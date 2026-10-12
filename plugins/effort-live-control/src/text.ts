// Every text the model reads from this plugin, apart from the tag's deny texts and the
// Agent tool's description line (effort.ts) and the judge's prompt (judge.ts).

export const BUTTON_UP =
  'Raise your own reasoning effort one step for your next replies. Use it when you are stuck: a check still fails after your fix, results do not fit your understanding of the code, a sub-task came back red for a reason you did not foresee — or right before a design decision that is hard to undo. Not for routine steps; it makes every later reply slower and costlier.';

export const BUTTON_DOWN =
  'Lower your own reasoning effort one step for your next replies. Use it when what is left is routine: spawning and waiting, relaying results, bookkeeping, or a fix whose every line you already know.';

export const REFUSED = "Not available here: this agent's effort is not live-controlled (its definition does not turn on effortControl). Nothing changed.";

export type Direction = 'up' | 'down';

/** What a button press that moved the level answers. */
export function buttonText(direction: Direction, level: string, floor: string, ceiling: string): string {
  return `Effort ${direction === 'up' ? 'raised' : 'lowered'} to ${level} for your next replies (your range ${floor}..${ceiling}).`;
}

/** What a button press at the end of the range answers. */
export function boundText(direction: Direction, level: string): string {
  return `Your effort is already ${level}, the ${direction === 'up' ? 'ceiling' : 'floor'} of your range; nothing changed.`;
}

/** The line a steered agent reads after its next tool result once its level changed. */
export function announceLine(level: string, why: string): string {
  return `effort-live-control: your reasoning effort is now ${level} — ${why}.`;
}

export const WHY_FAIL1 = 'a failing test run';
export const WHY_FAIL2 = '2nd failing test run in a row';
export const WHY_JUDGE_FAILED = 'judge unavailable, raised one step';
export const WHY_LANDING = 'landing, one step below your home level';

export const whyChild = (childType: string, token: string): string => `${childType} returned ${token}`;
export const whyRedispatch = (type: string): string => `${type} sent back a red result`;
export const whyJudge = (reason: string): string => `judge: ${reason === '' ? 'no reason given' : reason}`;
export const whyResolved = (level: string): string => `the trouble is resolved, back to ${level}`;
export const whyDecayed = (level: string, requests: number): string => `no new trouble for ${requests} requests, back to ${level}`;
