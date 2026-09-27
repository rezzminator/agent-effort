// The effort tag: `[effort: <level>]` at the very start of an Agent prompt sets
// that sub-agent's reasoning effort for every model request it makes.

export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof LEVELS)[number];

export type Tag =
  | { kind: 'none' }
  | { kind: 'ok'; effort: Effort }
  | { kind: 'bad'; raw: string };

// Anchored at the prompt's first non-blank character; a tag later in the text
// is prose the sub-agent reads, never a setting.
const TAG = /^\s*\[\s*effort\s*:\s*([^\]]*?)\s*\]/i;

export function isEffort(value: string): value is Effort {
  return (LEVELS as readonly string[]).includes(value);
}

export function parseTag(prompt: string): Tag {
  const match = TAG.exec(prompt);
  if (!match) return { kind: 'none' };
  const raw = match[1] ?? '';
  const level = raw.toLowerCase();
  return isEffort(level) ? { kind: 'ok', effort: level } : { kind: 'bad', raw };
}

export function denyText(raw: string): string {
  return `The prompt's effort tag names "${raw}", which is not an effort level. Start the prompt with [effort: ${LEVELS.join('|')}], or leave the tag out to keep the agent's own effort.`;
}

export const DESCRIBE_LINE = `\n\nEffort: to set the sub-agent's reasoning effort, start the prompt with [effort: ${LEVELS.join('|')}] on its first line. It applies to every model request the sub-agent makes; without the tag the agent keeps its own effort (its definition's, else the session's). An unknown level refuses the spawn.`;

/** Appends the tag's usage to a description once, whatever calls it twice. */
export function describe(description: string): string {
  return description.includes(DESCRIBE_LINE.trim()) ? description : description + DESCRIBE_LINE;
}

/**
 * Each sub-agent's tagged effort by agent id: an Effort, or null for one read
 * and found untagged. An id absent here has not been read yet.
 */
export class EffortBook {
  private readonly byAgent = new Map<string, Effort | null>();

  has(agentId: string): boolean {
    return this.byAgent.has(agentId);
  }

  get(agentId: string): Effort | undefined {
    return this.byAgent.get(agentId) ?? undefined;
  }

  record(agentId: string, tag: Tag): void {
    this.byAgent.set(agentId, tag.kind === 'ok' ? tag.effort : null);
  }
}

/** The text of the first user message: the prompt a sub-agent was spawned with. */
export function firstPrompt(messages: ReadonlyArray<{ role: string; text: string }>): string | undefined {
  return messages.find((m) => m.role === 'user')?.text;
}
