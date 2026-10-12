// The judge: a cheap model reads a snapshot taken at a tripwire and estimates the probability that the trouble continues.

import type { Effort } from './effort.ts';

export const JUDGE_SYSTEM = `You estimate whether an AI coding agent is in real trouble, so its reasoning effort can be raised in time. You get a snapshot taken right after a tripwire: a check failed, or a sub-task came back failed, blocked or partial.

Estimate the probability, from 0 to 100, that the trouble continues: the agent meets more failures or red results before it is over, or spends several more replies on it.

How often the trouble continued after each tripwire, measured over past runs of agents like this one:
- a failing test run, the first in a row: about 1 in 2
- the 2nd failing test run in a row: about 9 in 10
- a sub-task returned red: about 9 in 10
- a red result sent back to a sub-task: about 8 in 10
Start from that rate and move away from it only on clear evidence in the snapshot.
Lower it when the agent wrote the test first and says it watched it fail as expected, or when the error names its own small fix and the agent already says what it will change.
Raise it when the same failure repeats after a fix attempt, when results do not match what the agent predicted, or when the agent's words show doubt or a change of approach.
Waiting for a sub-task is normal for this agent and is no evidence either way.

Answer with one line and nothing else: the number, a space, a hyphen, a space, and a reason of at most twelve words.
Example: 85 - same assertion fails after the fix, cause unknown`;

const REASON_MAX = 120;

/** The judge's answer: its first non-blank line, `p - reason`, p a whole number from 0 to 100. */
export function parseAnswer(text: string): { p: number; reason: string } | undefined {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== '');
  if (line === undefined) return undefined;
  const clean = line.replace(/[`*]/g, '').trim();
  const found = /^\D{0,2}(\d{1,3})\b/.exec(clean);
  if (!found) return undefined;
  const p = Number(found[1]);
  if (p > 100) return undefined;
  const cut = clean.indexOf(' - ');
  return { p, reason: cut < 0 ? '' : clean.slice(cut + 3).trim().slice(0, REASON_MAX) };
}

export type Tripwire = 'fail1' | 'fail2' | 'red' | 'redispatch';

const TRIPWIRE_TEXT: Readonly<Record<Tripwire, string>> = {
  fail1: 'a failing test run',
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
  /** The failing run's output (fail1 and fail2 only). */
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
  if ((input.tripwire === 'fail1' || input.tripwire === 'fail2') && input.failTail !== undefined) lines.push(`last output of the failing run (tail): ${tail(input.failTail, FAIL_TAIL_MAX)}`);
  if ((input.tripwire === 'red' || input.tripwire === 'redispatch') && input.returnHead !== undefined) lines.push(`return (head): ${head(input.returnHead, RETURN_HEAD_MAX)}`);
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
