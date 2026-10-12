// The judge: a cheap model reads a snapshot taken at a tripwire and names the effort for the agent's next replies.

import type { Effort } from './effort.ts';
import { isLevel } from './ladder.ts';

export const JUDGE_SYSTEM = `You set the reasoning effort of an AI coding agent while it works. The levels, cheapest first: low, medium, high, xhigh, max. A higher level makes each of the agent's next replies think longer and cost more; it pays off only when the agent is stuck or faces a decision that is hard to undo.

You get a snapshot taken at a tripwire: a check that failed again, or a sub-task that came back failed, blocked or partial. Choose the effort for the agent's next replies.

Raise one step when the trouble is real and the way out is not obvious:
- the same check fails again after a fix attempt, or fails in a way the agent did not predict;
- a sub-task came back red for a reason the agent did not foresee;
- the agent's own words show doubt: it is guessing, results do not fit its model of the code, it is about to change approach or redesign.
Raise two steps only when several of these hold at once.
Hold the current level when the failure is expected or its fix is plain:
- the agent wrote the test first and says it watched it fail as expected;
- the error names its own small fix (a typo, a missing import, a wrong path) and the agent already says what it will change;
- the red result is already diagnosed and the agent is routing it back unchanged.
Lower one step only when what remains is waiting, relaying results or bookkeeping.

Stay within the allowed range in the snapshot. Answer with one line and nothing else: the level, a space, a hyphen, a space, and a reason of at most twelve words.
Example: xhigh - same test fails after the fix, cause unknown`;

const REASON_MAX = 120;

/** The judge's answer: its first non-blank line, `level - reason`, the level inside `allowed`. */
export function parseAnswer(text: string, allowed: readonly Effort[]): { level: Effort; reason: string } | undefined {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== '');
  if (line === undefined) return undefined;
  const clean = line.replace(/[`*]/g, '').trim();
  const word = (clean.split(/\s+/)[0] ?? '').toLowerCase();
  if (!isLevel(word) || !allowed.includes(word)) return undefined;
  const cut = clean.indexOf(' - ');
  return { level: word, reason: cut < 0 ? '' : clean.slice(cut + 3).trim().slice(0, REASON_MAX) };
}

export type Tripwire = 'fail2' | 'red' | 'redispatch';

const TRIPWIRE_TEXT: Readonly<Record<Tripwire, string>> = {
  fail2: '2nd failing test run in a row',
  red: 'a sub-task returned red',
  redispatch: 'a red result sent back to a sub-task',
};

export type PacketInput = {
  type: string;
  model: string;
  level: Effort;
  home: Effort;
  floor: Effort;
  ceiling: Effort;
  tripwire: Tripwire;
  /** The spawn prompt after the tag was stripped. */
  brief: string;
  /** Event tokens, oldest first. */
  events: readonly string[];
  /** The failing run's output (fail2 only). */
  failTail: string | undefined;
  /** The red return (red and redispatch only). */
  returnHead: string | undefined;
  lastWords: string;
};

export const PACKET_MAX = 2500;
const BRIEF_MAX = 600;
const EVENTS_MAX = 12;
const FAIL_TAIL_MAX = 300;
const RETURN_HEAD_MAX = 300;
const LAST_WORDS_MAX = 400;

export const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();
const tail = (text: string, max: number): string => collapse(text).slice(-max);
const head = (text: string, max: number): string => collapse(text).slice(0, max);

function render(input: PacketInput, events: readonly string[], briefMax: number): string {
  const lines = [
    `agent: ${input.type} · model ${input.model} · effort now ${input.level} · home ${input.home} · allowed ${input.floor}..${input.ceiling}`,
    `tripwire: ${TRIPWIRE_TEXT[input.tripwire]}`,
    `brief (opening): ${head(input.brief, briefMax)}`,
    'recent events (oldest first):',
    ...events.map((event) => `- ${event}`),
  ];
  if (input.tripwire === 'fail2' && input.failTail !== undefined) lines.push(`last output of the failing run (tail): ${tail(input.failTail, FAIL_TAIL_MAX)}`);
  if (input.tripwire !== 'fail2' && input.returnHead !== undefined) lines.push(`return (head): ${head(input.returnHead, RETURN_HEAD_MAX)}`);
  const last = tail(input.lastWords, LAST_WORDS_MAX);
  lines.push(`agent's last words (tail): ${last === '' ? '(none)' : last}`);
  return lines.join('\n');
}

/**
 * The snapshot the judge reads, at most PACKET_MAX characters: when the parts do
 * not fit, the oldest events go first, then the brief is cut shorter.
 */
export function packet(input: PacketInput): string {
  let events = input.events.slice(-EVENTS_MAX);
  let text = render(input, events, BRIEF_MAX);
  while (text.length > PACKET_MAX && events.length > 0) {
    events = events.slice(1);
    text = render(input, events, BRIEF_MAX);
  }
  if (text.length > PACKET_MAX) {
    const over = text.length - PACKET_MAX;
    text = render(input, events, Math.max(0, BRIEF_MAX - over));
  }
  return text.slice(0, PACKET_MAX);
}
