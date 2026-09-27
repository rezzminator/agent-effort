import type { EngineInterface, On, Register } from 'claude-code';
import { describe, denyText, EffortBook, parseTag, stripTag } from '../src/effort.ts';

// Thin adapter: every decision lives in src/effort.ts. A failure is logged with
// its context and the request goes through at the effort it already had.

/** The spawning tool's name, past and present. */
const AGENT_TOOLS = new Set(['Agent', 'Task']);

/** How long a sub-agent's first request waits for its spawn to return its id. */
const SPAWN_WAIT_MS = 5000;

// A sub-agent's first request can start before agent.spawn returns its id, so
// an unknown id waits for the spawns still in flight, never past SPAWN_WAIT_MS.
async function settle(book: EffortBook, $: EngineInterface, agentId: string, inFlight: Set<Promise<unknown>>): Promise<void> {
  if (book.has(agentId) || inFlight.size === 0) return;
  const done = Promise.allSettled([...inFlight]).then(() => true);
  const timedOut = $.clock.sleep(SPAWN_WAIT_MS).then(() => false);
  if (!(await Promise.race([done, timedOut]))) {
    $.ui.log(`agent-effort: sub-agent ${agentId}'s first request waited ${SPAWN_WAIT_MS}ms for its spawn to return; it runs at the effort it already had`);
  }
}

export const register: Register = (on: On) => {
  const book = new EffortBook();
  const inFlight = new Set<Promise<unknown>>();

  on('tool.describe', async ($, e, next) => {
    const result = await next(e);
    if (!AGENT_TOOLS.has(e.tool)) return result;
    return { ...result, description: describe(result.description) };
  });

  on('agent.spawn', async ($, e, next) => {
    const tag = parseTag(e.prompt);
    if (tag.kind === 'bad') return { deny: denyText(tag.raw) };
    const spawning = next(tag.kind === 'ok' ? { ...e, prompt: stripTag(e.prompt) } : e);
    inFlight.add(spawning);
    try {
      const result = await spawning;
      if (result.agentId !== undefined) book.record(result.agentId, tag);
      return result;
    } finally {
      inFlight.delete(spawning);
    }
  });

  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId;
    if (agentId === undefined) return yield* next(e);
    try {
      await settle(book, $, agentId, inFlight);
    } catch (error) {
      $.ui.log(`agent-effort: waiting on sub-agent ${agentId}'s spawn failed: ${error instanceof Error ? error.message : String(error)}; its effort is left as it is`);
    }
    const effort = book.get(agentId);
    return yield* next(effort === undefined || effort === e.effort ? e : { ...e, effort });
  });
};
