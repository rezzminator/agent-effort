// The per-agent controller: the state of one steered agent and every decision about its
// effort. Pure: events go in, `{ actions }` come out; the hooks file performs the actions.

import type { Effort } from './effort.ts';
import { collapse, packet as buildPacket, parseAnswer, type Tripwire } from './judge.ts';
import { clamp, step } from './ladder.ts';
import { returnLine, type ReturnWords } from './signals.ts';
import { announceLine, boundText, buttonText, whyChild, whyJudge, whyRedispatch, whyResolved, WHY_FAIL1, WHY_FAIL2, WHY_JUDGE_FAILED, WHY_LANDING, type Direction } from './text.ts';

export type Row = Record<string, unknown>;

export type Action =
  /** A decision-log row: the hook adds `ts`, `agent` and `type`. `detail` is logged only when packets are. */
  | { kind: 'log'; row: Row; detail?: Row }
  /** A judge call to start, detached; its answer returns through `onJudgeAnswer` / `onJudgeFailure` with this epoch. */
  | { kind: 'judge'; epoch: number; tripwire: Tripwire; packet: string };

export type Outcome = { actions: Action[] };
export type RequestOutcome = Outcome & { send: Effort | undefined };

export type Setup = {
  id: string;
  type: string;
  /** The level the agent starts at: its definition's effort, else its tag, else its first request's. */
  home: Effort;
  floor: Effort;
  ceiling: Effort;
  /** Whether a tripwire asks the judge (else it raises one step mechanically). */
  judge: boolean;
  /** The judge's probability (0-100) at or above which the level rises one step; below it the level holds. */
  judgeRaiseAt: number;
  /** Agent types whose spawn lands the flight. */
  landing: readonly string[];
  /** Model id prefixes the agent may be steered on. */
  models: readonly string[];
  words: ReturnWords;
  announce: boolean;
  /** The spawn prompt after the tag was stripped. */
  brief: string;
};

type Child = { type: string; name: string | undefined; unit: string | undefined };
type Struggle = { epoch: number; pre: Effort; requests: number };
type Usage = { input_tokens: number; output_tokens: number };

const RING = 12;
const COMMAND_MAX = 70;
const LINE_MAX = 100;
const FAIL_TAIL_MAX = 300;
const HEAD_MAX = 300;
const LAST_WORDS_MAX = 400;

const log = (event: string, fields: Row = {}, detail?: Row): Action => ({ kind: 'log', row: { event, ...fields }, ...(detail ? { detail } : {}) });

export class Controller {
  level: Effort;
  base: Effort;
  ownFails = 0;
  readonly reds = new Set<string>();

  private struggle: Struggle | undefined;
  private epochs = 0;
  private struggles = 0;
  private judgeCalls = 0;
  private judgeTokens = { input: 0, output: 0 };
  private inFlight: { epoch: number; tripwire: Tripwire; packet: string } | undefined;
  private readonly ring: string[] = [];
  private readonly children = new Map<string, Child>();
  private readonly seen = new Set<string>();
  private readonly heads = new Map<string, string>();
  private readonly requests: Record<string, number> = {};
  private lastWords = '';
  private failTail: string | undefined;
  private model = '';
  private gated = false;
  private line: string | undefined;

  constructor(private readonly setup: Setup) {
    this.level = clamp(setup.home, setup.floor, setup.ceiling);
    this.base = this.level;
  }

  get id(): string {
    return this.setup.id;
  }

  get type(): string {
    return this.setup.type;
  }

  get struggleOpen(): boolean {
    return this.struggle !== undefined;
  }

  /** The effort to send for one request, or undefined to pass it through untouched. */
  onRequest(model: string, requested: unknown): RequestOutcome {
    this.model = model;
    const actions: Action[] = [];
    if (!this.setup.models.some((prefix) => model.startsWith(prefix))) {
      if (!this.gated) actions.push(log('model-gated', { model }));
      this.gated = true;
      return { send: undefined, actions };
    }
    const sent = this.level;
    this.requests[sent] = (this.requests[sent] ?? 0) + 1;
    if (this.struggle) this.struggle.requests += 1;
    actions.push(log('step', { model, requested: requested ?? null, sent, struggle: this.struggle !== undefined }));
    return { send: sent, actions };
  }

  /** The agent's reply text of one request; a non-empty one becomes its last words. */
  onAnswer(answer: string): void {
    const words = collapse(answer);
    if (words !== '') this.lastWords = words.slice(-LAST_WORDS_MAX);
  }

  onTestRun(run: { command: string; failed: boolean; text: string }): Outcome {
    const actions: Action[] = [];
    const command = collapse(run.command).slice(0, COMMAND_MAX);
    this.event(`test ${run.failed ? 'FAIL' : 'PASS'}: ${command}`);
    if (run.failed) {
      this.ownFails += 1;
      this.failTail = collapse(run.text).slice(-FAIL_TAIL_MAX);
      if (this.ownFails === 1) this.tripwire('fail1', WHY_FAIL1, actions);
      else if (this.ownFails % 2 === 0) this.tripwire('fail2', WHY_FAIL2, actions);
    } else {
      this.ownFails = 0;
      this.resolve(actions);
    }
    return { actions };
  }

  /** The agent spawned a child (`childId` is absent when the spawn started none). */
  onSpawn(spawn: { childId?: string; type: string; name?: string }): Outcome {
    const actions: Action[] = [];
    this.event(`spawn ${spawn.type}`);
    this.seen.clear();
    if (this.setup.landing.includes(spawn.type)) {
      const base = step(this.setup.home, -1, this.setup.floor, this.setup.ceiling);
      const from = this.level;
      this.base = base;
      if (this.struggle) this.struggle.pre = base;
      else this.setLevel(base, WHY_LANDING);
      actions.push(log('landing', { from, to: this.level }));
    }
    const redType = [...this.children.values()].find((child) => child.type === spawn.type && this.isRed(child));
    if (redType) this.tripwire('redispatch', whyRedispatch(redType.type), actions, this.headOf(redType));
    if (spawn.childId !== undefined) this.children.set(spawn.childId, { type: spawn.type, name: spawn.name, unit: undefined });
    return { actions };
  }

  /** A child's final answer on its own turn.complete. */
  onChildReturn(childId: string, answer: string): Outcome {
    const found = returnLine(answer, 'complete', this.setup.words);
    if (!found) return { actions: [] };
    const child = this.children.get(childId);
    return this.take(found, child?.type ?? '?', found.unit ?? child?.type ?? '?', child, answer);
  }

  /** A result the agent read (Read, a non-test Bash such as a cat of a return file). */
  onRead(text: string): Outcome {
    const found = returnLine(text, 'read', this.setup.words);
    if (!found) return { actions: [] };
    const child = [...this.children.values()].find((candidate) => found.unit !== undefined && (candidate.name === found.unit || candidate.type === found.unit));
    return this.take(found, child?.type ?? found.unit ?? '?', found.unit ?? '?', child, text);
  }

  /** The agent sent a message to `to` (a child's id or name). */
  onSendMessage(to: string): Outcome {
    const actions: Action[] = [];
    const child = this.children.get(to) ?? [...this.children.values()].find((candidate) => candidate.name === to);
    this.event(`sendmessage → ${child?.type ?? to}`);
    this.seen.clear();
    if (child && this.isRed(child)) this.tripwire('redispatch', whyRedispatch(child.type), actions, this.headOf(child));
    return { actions };
  }

  onJudgeAnswer(epoch: number, text: string, ms: number, usage: Usage): Outcome {
    const call = this.inFlight;
    this.inFlight = undefined;
    this.addUsage(usage);
    const actions: Action[] = [];
    const detail = { packet: call?.packet ?? null, answer: text };
    const tripwire = call?.tripwire ?? 'fail2';
    if (!this.current(epoch)) {
      actions.push(log('judge-stale', { tripwire, epoch }, detail));
      return { actions };
    }
    const parsed = parseAnswer(text);
    if (!parsed) {
      this.failed(epoch, tripwire, 'unparseable answer', actions, detail);
      return { actions };
    }
    const from = this.level;
    if (parsed.p >= this.setup.judgeRaiseAt) this.setLevel(step(this.level, +1, this.setup.floor, this.setup.ceiling), whyJudge(parsed.reason));
    actions.push(log('judge', { tripwire, p: parsed.p, from, to: this.level, reason: parsed.reason, ms, usage }, detail));
    return { actions };
  }

  onJudgeFailure(epoch: number, reason: string, usage?: Usage): Outcome {
    const call = this.inFlight;
    this.inFlight = undefined;
    if (usage) this.addUsage(usage);
    const actions: Action[] = [];
    this.failed(epoch, call?.tripwire ?? 'fail2', reason, actions, { packet: call?.packet ?? null, answer: null });
    return { actions };
  }

  onButton(direction: Direction): Outcome & { text: string } {
    const { floor, ceiling } = this.setup;
    const to = step(this.level, direction === 'up' ? 1 : -1, floor, ceiling);
    if (to === this.level) return { text: boundText(direction, this.level), actions: [] };
    const from = this.level;
    this.level = to;
    if (!this.struggle) this.base = to;
    return { text: buttonText(direction, to, floor, ceiling), actions: [log('button', { direction, from, to })] };
  }

  /** The line owed to the agent's next tool result, handed over once. */
  takeAnnouncement(): string | undefined {
    const line = this.line;
    this.line = undefined;
    return line;
  }

  end(): Row {
    return { event: 'end', requests: { ...this.requests }, struggles: this.struggles, judgeCalls: this.judgeCalls, judgeTokens: { ...this.judgeTokens } };
  }

  private take(found: { token: string; red: boolean; line: string }, childType: string, unit: string, child: Child | undefined, text: string): Outcome {
    const actions: Action[] = [];
    if (this.seen.has(found.line)) return { actions };
    this.seen.add(found.line);
    this.event(`return ${childType} ${found.token}: ${found.line.slice(0, LINE_MAX)}`);
    if (child) child.unit = unit;
    if (found.red) {
      this.reds.add(unit);
      this.heads.set(unit, collapse(text).slice(0, HEAD_MAX));
      this.tripwire('red', whyChild(childType, found.token), actions, this.heads.get(unit));
    } else {
      this.reds.delete(unit);
      this.resolve(actions);
    }
    return { actions };
  }

  private isRed(child: Child): boolean {
    return child.unit !== undefined && this.reds.has(child.unit);
  }

  private headOf(child: Child): string | undefined {
    return child.unit === undefined ? undefined : this.heads.get(child.unit);
  }

  private event(token: string): void {
    this.ring.push(collapse(token));
    if (this.ring.length > RING) this.ring.shift();
  }

  private current(epoch: number): boolean {
    return this.struggle !== undefined && this.struggle.epoch === epoch;
  }

  private addUsage(usage: Usage): void {
    this.judgeTokens.input += usage.input_tokens;
    this.judgeTokens.output += usage.output_tokens;
  }

  private setLevel(to: Effort, why: string): void {
    if (to === this.level) return;
    this.level = to;
    if (this.setup.announce) this.line = announceLine(to, why);
  }

  private tripwire(kind: Tripwire, why: string, actions: Action[], returnHead?: string): void {
    if (!this.struggle) {
      this.struggle = { epoch: ++this.epochs, pre: this.base, requests: 0 };
      this.struggles += 1;
    }
    if (!this.setup.judge) {
      const from = this.level;
      this.setLevel(step(this.level, +1, this.setup.floor, this.setup.ceiling), why);
      actions.push(log('mechanical', { tripwire: kind, from, to: this.level }));
      return;
    }
    if (this.inFlight) {
      actions.push(log('judge-busy', { tripwire: kind }));
      return;
    }
    const text = buildPacket({
      type: this.setup.type,
      model: this.model,
      level: this.level,
      home: this.setup.home,
      floor: this.setup.floor,
      ceiling: this.setup.ceiling,
      tripwire: kind,
      brief: this.setup.brief,
      events: this.ring,
      failTail: this.failTail,
      returnHead,
      lastWords: this.lastWords,
    });
    this.inFlight = { epoch: this.struggle.epoch, tripwire: kind, packet: text };
    this.judgeCalls += 1;
    actions.push({ kind: 'judge', epoch: this.struggle.epoch, tripwire: kind, packet: text });
  }

  // The judge gave no level: one step up, if the struggle it was asked about is still the open one.
  private failed(epoch: number, tripwire: Tripwire, reason: string, actions: Action[], detail: Row): void {
    const from = this.level;
    if (this.current(epoch)) this.setLevel(step(this.level, +1, this.setup.floor, this.setup.ceiling), WHY_JUDGE_FAILED);
    actions.push(log('judge-failed', { tripwire, reason, from, to: this.level }, detail));
  }

  private resolve(actions: Action[]): void {
    if (!this.struggle || this.ownFails !== 0 || this.reds.size !== 0) return;
    const { pre, requests } = this.struggle;
    const from = this.level;
    this.struggle = undefined;
    this.setLevel(pre, whyResolved(pre));
    actions.push(log('resolved', { from, to: this.level, requests }));
  }
}
