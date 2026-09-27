import type { EngineInterface, On, Register } from 'claude-code';
import { describe, denyText, EffortBook, firstPrompt, parseTag } from '../src/effort.ts';

// Thin adapter: every decision lives in src/effort.ts. A failure is logged with
// its context and the request goes through at the effort it already had.

/** The spawning tool's name, past and present. */
const AGENT_TOOLS = new Set(['Agent', 'Task']);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A sub-agent this session never saw spawn (resumed, or its first request raced
// the spawn's return) is read once from its own first message; the tag stays in
// the prompt so this read finds it.
async function lookup(book: EffortBook, $: EngineInterface, agentId: string): Promise<void> {
  const found = await $.session.messages({ agentId });
  if ('deny' in found) {
    $.ui.log(`agent-effort: reading sub-agent ${agentId}'s messages was refused: ${String(found.deny)}; its effort is left as it is`);
    book.record(agentId, { kind: 'none' });
    return;
  }
  const prompt = firstPrompt(found);
  if (prompt === undefined) return; // no user message yet: read again on the next step
  book.record(agentId, parseTag(prompt));
}

export const register: Register = (on: On) => {
  const book = new EffortBook();

  on('tool.describe', async ($, e, next) => {
    const result = await next(e);
    if (!AGENT_TOOLS.has(e.tool)) return result;
    return { ...result, description: describe(result.description) };
  });

  on('agent.spawn', async ($, e, next) => {
    const tag = parseTag(e.prompt);
    if (tag.kind === 'bad') return { deny: denyText(tag.raw) };
    const result = await next(e);
    if (result.agentId !== undefined) book.record(result.agentId, tag);
    return result;
  });

  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId;
    if (agentId === undefined) return yield* next(e);
    try {
      if (!book.has(agentId)) await lookup(book, $, agentId);
    } catch (error) {
      $.ui.log(`agent-effort: reading sub-agent ${agentId}'s prompt failed: ${message(error)}; its effort is left as it is`);
    }
    const effort = book.get(agentId);
    return yield* next(effort === undefined || effort === e.effort ? e : { ...e, effort });
  });
};
