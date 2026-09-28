// The effort tag: `[effort: <level>]` as the first non-blank text of an Agent
// prompt sets that sub-agent's reasoning effort for every model request its
// hooks see (not its compaction forks or the panel's `agent_summary`; README).

export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof LEVELS)[number];

/** An effort as a request carries it: a level, or a number on models that take one. */
export type Level = Effort | number;

export type Tag =
  | { kind: 'none' }
  | { kind: 'ok'; effort: Effort }
  | { kind: 'bad'; raw: string }
  | { kind: 'empty' };

// Anchored at the prompt's first non-blank character; a tag later in the text
// is prose the sub-agent reads, never a setting. The brackets sit on one line,
// and `[effort: …](…)` is a markdown link, not a tag.
const TAG = /^\s*\[[^\S\r\n]*effort[^\S\r\n]*:[^\S\r\n]*([^\]\r\n]*?)[^\S\r\n]*\](?!\()/i;

export function isEffort(value: string): value is Effort {
  return (LEVELS as readonly string[]).includes(value);
}

export function parseTag(prompt: string): Tag {
  const match = TAG.exec(prompt);
  if (!match) return { kind: 'none' };
  const raw = match[1] ?? '';
  const level = raw.toLowerCase();
  if (!isEffort(level)) return { kind: 'bad', raw };
  return prompt.slice(match[0].length).trim() === '' ? { kind: 'empty' } : { kind: 'ok', effort: level };
}

/** The prompt without its leading tag, as the sub-agent reads it. */
export function stripTag(prompt: string): string {
  const match = TAG.exec(prompt);
  return match ? prompt.slice(match[0].length).replace(/^[^\S\r\n]*(?:\r?\n)?/, '') : prompt;
}

export const EMPTY_TEXT = 'The prompt holds an effort tag and no task. Put the task after the tag.';

export function denyText(raw: string): string {
  return `The prompt's effort tag names "${raw}", which is not an effort level. Start the prompt with [effort: ${LEVELS.join('|')}], or leave the tag out to keep the agent's own effort.`;
}

export const DESCRIBE_LINE = `\n\nEffort: start the prompt with [effort: ${LEVELS.join('|')}] to run the sub-agent at that effort; without it, the sub-agent keeps the effort it starts with.`;

/** Appends the tag's usage to a description once, whatever calls it twice. */
export function describe(description: string): string {
  return description.includes(DESCRIBE_LINE.trim()) ? description : description + DESCRIBE_LINE;
}

/**
 * A spawned sub-agent's pin: the effort every one of its requests is sent at.
 * `level` null means not pinned yet: an untagged spawn, or a finished run.
 */
export type Pin = { level: Level | null };

export type Step = { send: Level | undefined; pin?: Level };

/**
 * The effort one request is sent at. A pinned sub-agent gets its pin; an
 * unpinned one is pinned to what its first request carries, so a later
 * /effort change never reaches it; a loop with no pin keeps what it carries.
 */
export function stepEffort(pin: Pin | undefined, requested: Level | undefined): Step {
  if (pin === undefined) return { send: requested };
  if (pin.level !== null) return { send: pin.level };
  return requested === undefined ? { send: undefined } : { send: requested, pin: requested };
}
