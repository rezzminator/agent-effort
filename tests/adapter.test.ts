import { describe as suite, expect, it } from 'vitest';
import { register } from '../plugins/agent-effort/hooks/agent-effort.ts';

// A stand-in engine: host state that outlives a re-register, a clock the test
// fires, and the hooks the module registers, driven the way the engine drives them.
type Hook = (...args: any[]) => any;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function engine(state = new Map<string, unknown>()) {
  const statuses = new Map<string, string>();
  const hooks = new Map<string, Hook>();
  const timers: Array<() => void> = [];
  const logs: string[] = [];
  const $ = {
    state: {
      get: async (ref: { id: string }) => ({ value: state.get(ref.id), version: 0 }),
      set: async (ref: { id: string }, value: unknown) => (state.set(ref.id, value), { isSet: true, version: 1 }),
    },
    // A sleep the test fires; its signal aborting rejects it and drops its timer.
    clock: {
      sleep: (_ms: number, options?: { signal?: AbortSignal }) =>
        new Promise<void>((resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) return reject(signal.reason);
          const fire = () => (signal?.removeEventListener('abort', cancel), resolve());
          const cancel = () => (timers.splice(timers.indexOf(fire) >>> 0, 1), reject(signal!.reason));
          timers.push(fire);
          signal?.addEventListener('abort', cancel, { once: true });
        }),
    },
    ui: { log: (line: string) => logs.push(line) },
    agent: { list: async () => [...statuses].map(([id, status]) => ({ id, status, type: 'general-purpose', description: '' })) },
  };
  (register as Hook)((name: string, fn: Hook) => hooks.set(name, fn), {});

  async function step(agentId: string | undefined, effort: string | undefined, signal = new AbortController().signal): Promise<string | undefined> {
    let sent: string | undefined;
    const next = Object.assign(
      async function* (e: any) {
        sent = e.effort;
        return { answer: '', toolUses: [] };
      },
      { signal },
    );
    const gen = hooks.get('turn.step')!($, { turnId: 't', index: 0, model: 'm', messageCount: 1, agentId, effort }, next);
    for (let r = await gen.next(); !r.done; r = await gen.next());
    return sent;
  }

  function spawn(prompt: string) {
    const started = deferred<{ model: string; agentId?: string }>();
    let seen: any;
    const result = hooks.get('agent.spawn')!($, { prompt }, (e: any) => ((seen = e), started.promise));
    return { result, start: (agentId: string) => started.resolve({ model: 'm', agentId }), prompt: () => seen?.prompt };
  }

  const complete = (agentId: string) => hooks.get('turn.complete')!($, { agentId }, async () => ({ text: '' }));
  const fireTimers = () => timers.splice(0).forEach((fire) => fire());
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { state, statuses, step, spawn, complete, fireTimers, tick, logs, timers };
}

suite('agent.spawn', () => {
  it('refuses an unknown level and a tag with no task', async () => {
    const x = engine();
    expect(await x.spawn('[effort: turbo] go').result).toHaveProperty('deny');
    expect(await x.spawn('[effort: low]').result).toHaveProperty('deny');
  });

  it('hands the sub-agent its prompt without the tag', async () => {
    const x = engine();
    const s = x.spawn('[effort: low]\nMap X.');
    s.start('a1');
    await s.result;
    expect(s.prompt()).toBe('Map X.');
  });
});

suite('pins', () => {
  it('sends a tagged sub-agent its tag on every request, whatever /effort says', async () => {
    const x = engine();
    const s = x.spawn('[effort: max]\nMap X.');
    s.start('a1');
    await s.result;
    expect(await x.step('a1', 'medium')).toBe('max');
    expect(await x.step('a1', 'low')).toBe('max');
  });

  it('pins an untagged sub-agent to its first request, so a later /effort change never reaches it', async () => {
    const x = engine();
    const s = x.spawn('Map X.');
    s.start('a1');
    await s.result;
    expect(await x.step('a1', 'high')).toBe('high');
    expect(await x.step('a1', 'low')).toBe('high');
  });

  it('keeps pins across a plugin reload', async () => {
    const first = engine();
    const s = first.spawn('[effort: low]\nMap X.');
    s.start('a1');
    await s.result;
    const reloaded = engine(first.state);
    expect(await reloaded.step('a1', 'high')).toBe('low');
  });

  it('clears a pin when its sub-agent finishes, so a continuation pins afresh', async () => {
    const x = engine();
    const s = x.spawn('Map X.');
    s.start('a1');
    await s.result;
    expect(await x.step('a1', 'high')).toBe('high');
    x.statuses.set('a1', 'completed');
    await x.complete('a1');
    expect(await x.step('a1', 'low')).toBe('low');
    expect(await x.step('a1', 'max')).toBe('low');
  });

  it('keeps the pin when a run ends while the sub-agent still runs, waiting on its own task', async () => {
    const x = engine();
    const s = x.spawn('[effort: max]\nMap X.');
    s.start('a1');
    await s.result;
    x.statuses.set('a1', 'running');
    await x.complete('a1');
    expect(await x.step('a1', 'low')).toBe('max');
  });

  it('never pins the main chat', async () => {
    const x = engine();
    expect(await x.step(undefined, 'high')).toBe('high');
    expect(await x.step(undefined, 'low')).toBe('low');
  });
});

suite('waiting for a spawn to return', () => {
  it('ends the wait when its own spawn is recorded, not when every spawn settles', async () => {
    const x = engine();
    x.spawn('Slow unrelated task.'); // never started: stays in flight
    const mine = x.spawn('[effort: low]\nMap X.');
    const sent = x.step('a1', 'high'); // its first request races ahead of the spawn's return
    await x.tick();
    mine.start('a1');
    expect(await sent).toBe('low');
    expect(x.logs).toEqual([]);
  });

  it('lets a loop no spawn names wait once, then pass straight through', async () => {
    const x = engine();
    x.spawn('Slow unrelated task.'); // in flight throughout
    const first = x.step('fork-1', 'high');
    await x.tick();
    x.fireTimers();
    expect(await first).toBe('high');
    expect(await x.step('fork-1', 'high')).toBe('high'); // no timer fired: it did not wait
    expect(x.timers).toHaveLength(0);
  });

  it('cancels its timer when the spawn settles first', async () => {
    const x = engine();
    const mine = x.spawn('[effort: low]\nMap X.');
    const sent = x.step('a1', 'high');
    await x.tick();
    expect(x.timers).toHaveLength(1);
    mine.start('a1');
    expect(await sent).toBe('low');
    expect(x.timers).toHaveLength(0);
  });

  it('ends the wait at once when the turn is interrupted', async () => {
    const x = engine();
    x.spawn('Slow unrelated task.'); // in flight throughout, never started
    const turn = new AbortController();
    const sent = x.step('a1', 'high', turn.signal);
    await x.tick();
    turn.abort();
    const stillWaiting = new Promise((r) => setTimeout(() => r('still waiting'), 50));
    expect(await Promise.race([sent, stillWaiting])).toBe('high');
    expect(x.timers).toHaveLength(0);
    expect(x.logs).toEqual([]);
  });
});
