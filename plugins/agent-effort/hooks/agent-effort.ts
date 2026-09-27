import type { EngineInterface, On, Register } from 'claude-code';
import { describe, denyText, EMPTY_TEXT, parseTag, stepEffort, stripTag, type Pin } from '../src/effort.ts';

// Thin adapter: every decision lives in src/effort.ts. A failure is logged with
// its context and the request goes through at the effort it already had.

/** The spawning tool's name, past and present. */
const AGENT_TOOLS = new Set(['Agent', 'Task']);

/** How long a request of a loop the plugin has not seen waits for spawns in flight. */
const SPAWN_WAIT_MS = 5000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Pins live in host state, so a plugin reload keeps them; one value per agent id.
async function readPin($: EngineInterface, agentId: string): Promise<Pin | undefined> {
  const { value } = await $.state.get({ plugin: 'agent-effort', key: 'pin', id: agentId });
  return value ?? undefined;
}

async function writePin($: EngineInterface, agentId: string, pin: Pin): Promise<void> {
  await $.state.set({ plugin: 'agent-effort', key: 'pin', id: agentId }, pin);
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
// SPAWN_WAIT_MS, and at most once for its lifetime.
async function awaitPin($: EngineInterface, spawns: Spawns, agentId: string): Promise<Pin | undefined> {
  let pin = await readPin($, agentId);
  if (pin !== undefined || spawns.strangers.has(agentId)) return pin;
  const deadline = $.clock.sleep(SPAWN_WAIT_MS).then(() => 'timeout' as const);
  while (pin === undefined && spawns.inFlight > 0) {
    if ((await Promise.race([spawns.settled.then(() => 'settled' as const), deadline])) === 'timeout') break;
    pin = await readPin($, agentId);
  }
  if (pin === undefined) spawns.strangers.add(agentId);
  return pin;
}

export const register: Register = (on: On) => {
  const spawns = newSpawns();

  on('tool.describe', async ($, e, next) => {
    const result = await next(e);
    if (!AGENT_TOOLS.has(e.tool)) return result;
    return { ...result, description: describe(result.description) };
  });

  on('agent.spawn', async ($, e, next) => {
    const tag = parseTag(e.prompt);
    if (tag.kind === 'bad') return { deny: denyText(tag.raw) };
    if (tag.kind === 'empty') return { deny: EMPTY_TEXT };
    spawns.inFlight += 1;
    try {
      const result = await next(tag.kind === 'ok' ? { ...e, prompt: stripTag(e.prompt) } : e);
      if (result.agentId !== undefined) {
        try {
          await writePin($, result.agentId, { level: tag.kind === 'ok' ? tag.effort : null });
        } catch (error) {
          $.ui.log(`agent-effort: recording sub-agent ${result.agentId}'s pin failed: ${message(error)}; it runs at the session's effort, unpinned`);
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
    try {
      const step = stepEffort(await awaitPin($, spawns, agentId), e.effort);
      send = step.send;
      if (step.pin !== undefined) await writePin($, agentId, { level: step.pin });
    } catch (error) {
      $.ui.log(`agent-effort: resolving sub-agent ${agentId}'s effort failed: ${message(error)}; this request goes at ${String(e.effort)}`);
    }
    return yield* next(send === undefined || send === e.effort ? e : { ...e, effort: send });
  });

  // A finished sub-agent drops its pin, so a continuation is pinned afresh at its
  // first request. A run that ends while the agent still runs (it waits on its
  // own background task) is the same job resuming later: its pin stays.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined) return result;
    try {
      const status = (await $.agent.list()).find((agent) => agent.id === e.agentId)?.status;
      if (status === 'running') return result;
      if ((await readPin($, e.agentId)) !== undefined) await writePin($, e.agentId, { level: null });
    } catch (error) {
      $.ui.log(`agent-effort: clearing sub-agent ${e.agentId}'s pin failed: ${message(error)}; its next run keeps the old pin`);
    }
    return result;
  });
};
