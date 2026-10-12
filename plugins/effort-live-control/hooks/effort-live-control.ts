import type { EngineInterface, On, PluginOptions, Register } from 'claude-code';
import { Definitions, type ControlConfig, type Definition } from '../src/agents.ts';
import { Controller, type Action } from '../src/control.ts';
import { describe, denyText, EMPTY_TEXT, isStillRunning, parseTag, stepEffort, stripTag, type Effort, type Pin } from '../src/effort.ts';
import { JUDGE_SYSTEM } from '../src/judge.ts';
import { isLevel } from '../src/ladder.ts';
import { appendRows, sessionLogPath } from '../src/log.ts';
import { compile, resolveSettings, type Compiled, type Settings } from '../src/settings.ts';
import { isTestRun, testOutcome } from '../src/signals.ts';
import { BUTTON_DOWN, BUTTON_UP, REFUSED, type Direction } from '../src/text.ts';

// Thin adapter: every decision lives in src/. A failure is logged with its context and
// the spawn, request or tool call goes through at the effort it already had.

/** The spawning tool's name, past and present. */
const AGENT_TOOLS = new Set(['Agent', 'Task']);

/** How long a request of a loop the plugin has not seen waits for spawns in flight. */
const SPAWN_WAIT_MS = 5000;

const LOG_CAP = 5000;
const JUDGE_MAX_TOKENS = 4000;

type Fields = Record<string, unknown>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Pins live in host state, so a plugin reload keeps them; one value per agent id.
async function readPin($: EngineInterface, agentId: string): Promise<Pin | undefined> {
  const { value } = await $.state.get({ plugin: 'effort-live-control', key: 'pin', id: agentId });
  return value ?? undefined;
}

async function writePin($: EngineInterface, agentId: string, pin: Pin): Promise<void> {
  await $.state.set({ plugin: 'effort-live-control', key: 'pin', id: agentId }, pin);
}

type Spawns = {
  /** Spawns whose next() has not returned yet. */
  inFlight: number;
  /** Resolved and replaced each time a spawn settles. */
  settled: Promise<void>;
  wake: () => void;
  /** Loops that waited once and were never attributed to a spawn: never wait again. */
  strangers: Set<string>;
};

function newSpawns(): Spawns {
  const spawns = { inFlight: 0, strangers: new Set<string>() } as Spawns;
  spawns.settled = new Promise((resolve) => (spawns.wake = resolve));
  return spawns;
}

function settle(spawns: Spawns): void {
  spawns.inFlight -= 1;
  const wake = spawns.wake;
  spawns.settled = new Promise((resolve) => (spawns.wake = resolve));
  wake();
}

// A sub-agent's first request can start before agent.spawn returns its id. An
// unknown id waits until its own pin appears or no spawn is in flight, never past
// SPAWN_WAIT_MS, and at most once for its lifetime. The turn's abort ends the
// wait at once, and however the wait ends its timer is cancelled.
async function awaitPin($: EngineInterface, spawns: Spawns, agentId: string, signal: AbortSignal): Promise<Pin | undefined> {
  let pin = await readPin($, agentId);
  if (pin !== undefined || spawns.strangers.has(agentId)) return pin;
  const waiting = new AbortController();
  const stop = () => waiting.abort();
  signal.addEventListener('abort', stop);
  if (signal.aborted) stop();
  const deadline = $.clock.sleep(SPAWN_WAIT_MS, { signal: waiting.signal }).then(
    () => 'over' as const,
    (error: unknown) => {
      if (!waiting.signal.aborted) $.ui.log(`effort-live-control: sub-agent ${agentId}'s wait for its spawn failed: ${message(error)}; it goes on without waiting`);
      return 'over' as const;
    },
  );
  try {
    while (pin === undefined && spawns.inFlight > 0) {
      if ((await Promise.race([spawns.settled.then(() => 'settled' as const), deadline])) === 'over') break;
      pin = await readPin($, agentId);
    }
  } finally {
    signal.removeEventListener('abort', stop);
    waiting.abort();
  }
  if (pin === undefined) spawns.strangers.add(agentId);
  return pin;
}

/** A steered agent whose home waits for its first request. */
type Awaiting = { type: string; control: ControlConfig; brief: string };

type Runtime = {
  config: Settings;
  compiled: Compiled;
  optionErrors: string[];
  started?: Promise<void>;
  defs?: Definitions;
  /** The decision log's path pattern with `~` expanded; empty: no log. */
  logFile: string;
  logPath?: Promise<string | undefined>;
  pending: string[];
  writing: Promise<void>;
  steered: Map<string, Controller>;
  awaiting: Map<string, Awaiting>;
  /** Each child agent's id → its steered parent's id. */
  childOf: Map<string, string>;
  /** The full tool names `$.tool.register` returned. */
  buttons: Map<string, Direction>;
};

// Rows queue in memory; each flush reads the session's file and appends them,
// so a resumed session keeps its earlier rows and no other chat shares the file.
function record(rt: Runtime, $: EngineInterface, agent: string, type: string, row: Fields): void {
  const file = rt.logFile;
  if (!file) return;
  const { event, ...rest } = row;
  rt.pending.push(JSON.stringify({ ts: new Date().toISOString(), event, agent, type, ...rest }));
  rt.logPath ??= $.session.id().then(
    (id) => sessionLogPath(file, id),
    (error) => {
      $.ui.log(`effort-live-control: reading the session id failed: ${message(error)}; the decision log is off for this session`);
      return undefined;
    },
  );
  rt.writing = rt.writing
    .then(async () => {
      const path = await rt.logPath;
      const rows = rt.pending.splice(0);
      if (!path || rows.length === 0) return;
      const existing = (await $.fs.exists(path)) ? await $.fs.read(path) : '';
      await $.fs.write(path, appendRows(existing, rows, LOG_CAP));
    })
    .catch((error) => $.ui.log(`effort-live-control: writing the decision log for ${file} failed: ${message(error)}`));
}

// First hook call: read where definitions live, report option errors, build the resolver.
function start(rt: Runtime, $: EngineInterface): Promise<void> {
  rt.started ??= (async () => {
    let cwd = '.';
    let home: string | undefined;
    let configDir: string | undefined;
    try {
      cwd = await $.session.cwd();
    } catch (error) {
      $.ui.log(`effort-live-control: reading the session cwd failed: ${message(error)}; using relative paths`);
    }
    try {
      home = await $.env.get('HOME');
    } catch (error) {
      $.ui.log(`effort-live-control: reading HOME failed: ${message(error)}; skipping ~/.claude/agents and ~ in logFile`);
    }
    try {
      configDir = await $.env.get('CLAUDE_CONFIG_DIR');
    } catch (error) {
      $.ui.log(`effort-live-control: reading CLAUDE_CONFIG_DIR failed: ${message(error)}; skipping its agents directory`);
    }
    const file = rt.config.logFile;
    if (file.startsWith('~') && !home) $.ui.log(`effort-live-control: logFile ${file} needs HOME, which is unset; the decision log is off`);
    else rt.logFile = file.startsWith('~') ? `${home}${file.slice(1)}` : file;
    for (const line of rt.optionErrors) {
      $.ui.log(line);
      record(rt, $, 'main', 'option-error', { event: 'option-error', line });
    }
    const dirs = [`${cwd}/.claude/agents`, ...(configDir ? [`${configDir}/agents`] : []), ...(home ? [`${home}/.claude/agents`] : []), ...rt.config.agentDirs];
    rt.defs = new Definitions(
      dirs,
      { floor: rt.config.floor, ceiling: rt.config.ceiling, judge: rt.config.judge },
      {
        exists: (path) => $.fs.exists(path),
        read: (path) => $.fs.read(path),
        listMarkdown: async (dir) => (await $.fs.list(dir)).filter((entry) => entry.kind === 'file' && entry.name.endsWith('.md')).map((entry) => entry.name),
      },
      (line) => $.ui.log(line),
    );
  })().catch((error) => $.ui.log(`effort-live-control: starting failed: ${message(error)}; sub-agents run unsteered at the effort they carry`));
  return rt.started;
}

const NO_DEFINITION: Definition = { path: undefined, effort: undefined, control: undefined, errors: [] };

async function definitionOf(rt: Runtime, $: EngineInterface, type: string | undefined): Promise<Definition> {
  if (!type || !rt.defs) return NO_DEFINITION;
  try {
    return await rt.defs.resolve(type);
  } catch (error) {
    $.ui.log(`effort-live-control: reading the definition of ${type} failed: ${message(error)}; treating it as having none`);
    return NO_DEFINITION;
  }
}

function newController(rt: Runtime, id: string, type: string, control: ControlConfig, home: Effort, brief: string): Controller {
  const controller = new Controller({
    id,
    type,
    home,
    floor: control.floor,
    ceiling: control.ceiling,
    judge: control.judge,
    judgeRaiseAt: rt.config.judgeRaiseAt,
    landing: control.landing,
    models: rt.config.models,
    words: { red: rt.config.redWords, green: rt.config.greenWords },
    announce: rt.config.announce,
    brief,
  });
  rt.steered.set(id, controller);
  return controller;
}

// Carries out what a controller decided: log rows, and judge calls started detached.
function perform(rt: Runtime, $: EngineInterface, controller: Controller, actions: readonly Action[]): void {
  for (const action of actions) {
    if (action.kind === 'log') {
      const { event, ...rest } = action.row;
      record(rt, $, controller.id, controller.type, { event, ...rest, ...(rt.config.logPackets ? action.detail : {}) });
    } else {
      runJudge(rt, $, controller, action);
    }
  }
}

// One judge call, never awaited by a hook: no request waits for it. Whatever it
// comes back with is read by the controller, which raises one step when it gives no level.
function runJudge(rt: Runtime, $: EngineInterface, controller: Controller, action: Extract<Action, { kind: 'judge' }>): void {
  const started = Date.now();
  $.model
    .complete({ model: rt.config.judgeModel, effort: rt.config.judgeEffort, system: JUDGE_SYSTEM, prompt: action.packet, maxTokens: JUDGE_MAX_TOKENS, timeoutMs: rt.config.judgeTimeoutMs })
    .then(
      (reply) => {
        if (rt.steered.get(controller.id) !== controller) return;
        const ms = Date.now() - started;
        const out = reply.isAnswered
          ? controller.onJudgeAnswer(action.epoch, reply.text, ms, reply.usage)
          : controller.onJudgeFailure(action.epoch, reply.reason === 'api-error' ? `api-error ${reply.status ?? 'no status'} ${reply.error}` : reply.reason, reply.usage);
        perform(rt, $, controller, out.actions);
      },
      (error: unknown) => {
        if (rt.steered.get(controller.id) !== controller) return;
        perform(rt, $, controller, controller.onJudgeFailure(action.epoch, `threw: ${message(error)}`).actions);
      },
    )
    .catch((error: unknown) => $.ui.log(`effort-live-control: reading the judge's answer for ${controller.id} failed: ${message(error)}; its effort stays where it is`));
}

// A spawn returned an id: log an ignored tag, tell a steered parent, and start steering the child.
function afterSpawn(rt: Runtime, $: EngineInterface, agentId: string, type: string, parentId: string | undefined, name: string | undefined, definition: Definition, tagged: Effort | undefined, brief: string): void {
  try {
    if (tagged !== undefined && definition.effort !== undefined) {
      record(rt, $, agentId, type, { event: 'tag-ignored', tag: tagged, effort: definition.effort });
    }
    const parent = parentId === undefined ? undefined : rt.steered.get(parentId);
    if (parent) {
      rt.childOf.set(agentId, parent.id);
      perform(rt, $, parent, parent.onSpawn({ childId: agentId, type, name }).actions);
    }
    if (definition.control) {
      const home = definition.effort ?? tagged;
      if (home !== undefined) newController(rt, agentId, type, definition.control, home, brief);
      else rt.awaiting.set(agentId, { type, control: definition.control, brief });
    }
  } catch (error) {
    $.ui.log(`effort-live-control: steering sub-agent ${agentId} failed: ${message(error)}; it runs unsteered at its pin`);
  }
}

// The first request of an agent whose home is its effort: steer it when that is a level.
function adoptFirst(rt: Runtime, $: EngineInterface, agentId: string, requested: unknown): Controller | undefined {
  const waiting = rt.awaiting.get(agentId);
  if (!waiting) return undefined;
  rt.awaiting.delete(agentId);
  if (!isLevel(requested)) {
    record(rt, $, agentId, waiting.type, { event: 'not-steered', requested: requested ?? null });
    $.ui.log(`effort-live-control: sub-agent ${agentId} (${waiting.type}) starts at ${String(requested)}, not a level; it is not steered`);
    return undefined;
  }
  return newController(rt, agentId, waiting.type, waiting.control, requested, waiting.brief);
}

// What a steered agent's own tool call tells the controller.
function observe(rt: Runtime, $: EngineInterface, controller: Controller, e: Fields & { tool: string }, result: { text?: string; isError?: boolean }): void {
  const text = result.text ?? '';
  if (e.tool === 'SendMessage') {
    perform(rt, $, controller, controller.onSendMessage(String(e.to)).actions);
    return;
  }
  const command = isTestRun(e.tool, e, rt.compiled.testCommand);
  if (command !== undefined) {
    const failed = testOutcome(result.isError, text, rt.compiled.failure) === 'fail';
    perform(rt, $, controller, controller.onTestRun({ command, failed, text }).actions);
    return;
  }
  if (e.tool === 'Read' || (e.tool === 'Bash' && e.run_in_background !== true)) perform(rt, $, controller, controller.onRead(text).actions);
}

function answerButton(rt: Runtime, $: EngineInterface, agentId: string | undefined, direction: Direction): { result: string } {
  const controller = agentId === undefined ? undefined : rt.steered.get(agentId);
  if (!controller) {
    record(rt, $, agentId ?? 'main', 'unsteered', { event: 'button-refused', direction });
    return { result: REFUSED };
  }
  const out = controller.onButton(direction);
  perform(rt, $, controller, out.actions);
  return { result: out.text };
}

async function registerButtons(rt: Runtime, $: EngineInterface): Promise<void> {
  if (!rt.config.buttons) return;
  const specs: Array<{ name: string; description: string; direction: Direction }> = [
    { name: 'effort_up', description: BUTTON_UP, direction: 'up' },
    { name: 'effort_down', description: BUTTON_DOWN, direction: 'down' },
  ];
  for (const spec of specs) {
    try {
      const { tool } = await $.tool.register({ name: spec.name, description: spec.description, inputSchema: { type: 'object', properties: {} } });
      rt.buttons.set(tool, spec.direction);
      record(rt, $, 'main', 'plugin', { event: 'tool-registered', tool });
    } catch (error) {
      $.ui.log(`effort-live-control: registering the ${spec.name} tool failed: ${message(error)}; agents have no ${spec.name} button`);
      record(rt, $, 'main', 'plugin', { event: 'tool-register-failed', tool: spec.name, error: message(error) });
    }
  }
}

// A finished agent: its end row, and a child's final answer to its steered parent.
function finish(rt: Runtime, $: EngineInterface, agentId: string, answer: string): void {
  try {
    const parentId = rt.childOf.get(agentId);
    const parent = parentId === undefined ? undefined : rt.steered.get(parentId);
    if (parent) perform(rt, $, parent, parent.onChildReturn(agentId, answer).actions);
    const own = rt.steered.get(agentId);
    if (own) {
      record(rt, $, own.id, own.type, own.end());
      rt.steered.delete(agentId);
      for (const [child, owner] of rt.childOf) if (owner === agentId) rt.childOf.delete(child);
    }
    rt.awaiting.delete(agentId);
  } catch (error) {
    $.ui.log(`effort-live-control: closing sub-agent ${agentId}'s steering failed: ${message(error)}; its pin is cleared as usual`);
  }
}

export const register: Register = (on: On, options: PluginOptions) => {
  const spawns = newSpawns();
  const { settings, errors } = resolveSettings(options as Record<string, unknown>);
  const rt: Runtime = {
    config: settings,
    compiled: compile(settings),
    optionErrors: errors,
    logFile: '',
    pending: [],
    writing: Promise.resolve(),
    steered: new Map(),
    awaiting: new Map(),
    childOf: new Map(),
    buttons: new Map(),
  };

  on('session.start', async ($, e, next) => {
    const result = await next(e);
    await start(rt, $);
    await registerButtons(rt, $);
    return result;
  });

  on('tool.describe', async ($, e, next) => {
    const result = await next(e);
    if (!AGENT_TOOLS.has(e.tool)) return result;
    return { ...result, description: describe(result.description) };
  });

  on('agent.spawn', async ($, e, next) => {
    const tag = parseTag(e.prompt);
    if (tag.kind === 'bad') return { deny: denyText(tag.raw) };
    if (tag.kind === 'empty') return { deny: EMPTY_TEXT };
    await start(rt, $);
    const definition = await definitionOf(rt, $, e.subagentType);
    const tagged = tag.kind === 'ok' ? tag.effort : undefined;
    const prompt = tag.kind === 'ok' ? stripTag(e.prompt) : e.prompt;
    spawns.inFlight += 1;
    try {
      const result = await next(tag.kind === 'ok' ? { ...e, prompt } : e);
      if (result.agentId !== undefined) {
        afterSpawn(rt, $, result.agentId, e.subagentType ?? 'unknown', e.parentAgentId, e.name, definition, tagged, prompt);
        try {
          await writePin($, result.agentId, { level: definition.effort ?? tagged ?? null });
        } catch (error) {
          $.ui.log(`effort-live-control: recording sub-agent ${result.agentId}'s pin failed: ${message(error)}; it runs at the session's effort, unpinned`);
        }
      }
      return result;
    } finally {
      settle(spawns);
    }
  });

  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId;
    if (agentId === undefined) return yield* next(e);
    let send = e.effort;
    let controller: Controller | undefined;
    try {
      await start(rt, $);
      const pin = await awaitPin($, spawns, agentId, next.signal);
      controller = rt.steered.get(agentId) ?? adoptFirst(rt, $, agentId, e.effort);
      if (controller) {
        const out = controller.onRequest(e.model, e.effort);
        perform(rt, $, controller, out.actions);
        send = out.send ?? e.effort;
      } else {
        const step = stepEffort(pin, e.effort);
        send = step.send;
        if (step.pin !== undefined) await writePin($, agentId, { level: step.pin });
      }
    } catch (error) {
      $.ui.log(`effort-live-control: resolving sub-agent ${agentId}'s effort failed: ${message(error)}; this request goes at ${String(e.effort)}`);
    }
    const result = yield* next(send === undefined || send === e.effort ? e : { ...e, effort: send });
    try {
      controller?.onAnswer(result.answer);
    } catch (error) {
      $.ui.log(`effort-live-control: reading sub-agent ${agentId}'s reply failed: ${message(error)}; its last words are not kept`);
    }
    return result;
  });

  // Answers the two buttons itself; for a steered agent, reads what its own calls say about trouble
  // and carries a level change it is owed in the result's context.
  on('tool.call', async ($, e, next) => {
    const direction = rt.buttons.get(e.tool);
    if (direction !== undefined) {
      try {
        return answerButton(rt, $, e.agentId, direction);
      } catch (error) {
        $.ui.log(`effort-live-control: answering ${e.tool} failed: ${message(error)}; nothing changed`);
        return { result: `Nothing changed: ${message(error)}` };
      }
    }
    const controller = e.agentId === undefined ? undefined : rt.steered.get(e.agentId);
    if (!controller) return next(e);
    const result = await next(e);
    if (result.deny !== undefined) return result;
    try {
      observe(rt, $, controller, e as unknown as Fields & { tool: string }, result);
      const line = controller.takeAnnouncement();
      if (line !== undefined) return { ...result, context: [...(result.context ?? []), line] };
    } catch (error) {
      $.ui.log(`effort-live-control: reading ${e.agentId ?? 'main'}'s ${e.tool} result failed: ${message(error)}; its effort stays where it is`);
    }
    return result;
  });

  // A finished sub-agent drops its pin, so a continuation is pinned afresh at its
  // first request. A run that ends while the agent still runs, or waits on its own
  // background work, is the same job resuming later: its pin stays.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined) return result;
    try {
      const status = (await $.agent.list()).find((agent) => agent.id === e.agentId)?.status;
      if (isStillRunning(status)) return result;
      finish(rt, $, e.agentId, e.answer);
      if ((await readPin($, e.agentId)) !== undefined) await writePin($, e.agentId, { level: null });
    } catch (error) {
      $.ui.log(`effort-live-control: clearing sub-agent ${e.agentId}'s pin failed: ${message(error)}; its next run keeps the old pin`);
    }
    return result;
  });
};
