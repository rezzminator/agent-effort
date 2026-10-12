import { describe, expect, it } from 'vitest';
import { Controller, type Action, type Outcome, type Setup } from '../plugins/effort-live-control/src/control.ts';
import { DEFAULTS } from '../plugins/effort-live-control/src/settings.ts';

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function make(over: Partial<Setup> = {}): Controller {
  return new Controller({
    id: 'a1',
    type: 'lead',
    home: 'medium',
    floor: 'medium',
    ceiling: 'xhigh',
    judge: true,
    landing: [],
    models: DEFAULTS.models,
    words: { red: DEFAULTS.redWords, green: DEFAULTS.greenWords },
    announce: true,
    brief: 'Coordinate the build of X.',
    ...over,
  });
}

const rows = (o: Outcome, event?: string) => o.actions.flatMap((a) => (a.kind === 'log' && (event === undefined || a.row.event === event) ? [a.row] : []));
const judges = (o: Outcome) => o.actions.filter((a): a is Extract<Action, { kind: 'judge' }> => a.kind === 'judge');
const FAIL = { command: 'npm test', failed: true, text: 'expected 3 got 4' };
const PASS = { command: 'npm test', failed: false, text: 'ok' };

/** Drives a controller to its 2nd failing run and returns the judge action. */
function fail2(c: Controller): Extract<Action, { kind: 'judge' }> {
  c.onTestRun(FAIL);
  return judges(c.onTestRun(FAIL))[0]!;
}

describe('onRequest', () => {
  it('R-4: sends the level, home clamped into the range', () => {
    expect(make({ home: 'high' }).onRequest('claude-opus-5-5', 'low').send).toBe('high');
    expect(make({ home: 'low' }).onRequest('claude-opus-5-5', 'low').send).toBe('medium');
    expect(make({ home: 'max' }).onRequest('claude-opus-5-5', 'low').send).toBe('xhigh');
  });

  it('R-4: an allowed model matches as a prefix of the request model, bracket suffix included', () => {
    expect(make().onRequest('claude-opus-5-5[1m]', undefined).send).toBe('medium');
    expect(make().onRequest('claude-sonnet-5-5-20260101', undefined).send).toBe('medium');
  });

  it('R-4: an unallowed model passes through untouched, logged once per agent', () => {
    const c = make({ home: 'high' });
    const first = c.onRequest('claude-haiku-5-5', 'low');
    expect(first.send).toBeUndefined();
    expect(rows(first, 'model-gated')).toEqual([{ event: 'model-gated', model: 'claude-haiku-5-5' }]);
    expect(rows(c.onRequest('claude-haiku-5-5', 'low'), 'model-gated')).toEqual([]);
    expect(rows(c.onRequest('claude-haiku-5-5', 'low'), 'step')).toEqual([]);
  });

  it('R-4: writes a step row per steered request', () => {
    const c = make({ home: 'high' });
    expect(rows(c.onRequest('claude-opus-5-5', 'low'), 'step')).toEqual([{ event: 'step', model: 'claude-opus-5-5', requested: 'low', sent: 'high', struggle: false }]);
  });

  it('R-4: the tail of a non-empty answer is the agent\'s last words, whitespace collapsed to 400 chars', () => {
    const c = make();
    c.onRequest('claude-opus-5-5', undefined);
    c.onAnswer('first   words');
    c.onAnswer('');
    c.onAnswer(`${'x'.repeat(500)}\n\nend   here`);
    const p = fail2(c).packet;
    expect(p).toContain("agent's last words (tail): ");
    expect(p).toContain('x end here');
    expect(p).not.toContain('first words');
  });
});

describe('own test runs', () => {
  it('R-5: the 2nd failing test run with no pass between fires the judge', () => {
    const c = make();
    expect(judges(c.onTestRun(FAIL))).toHaveLength(0);
    const second = c.onTestRun(FAIL);
    expect(judges(second)).toHaveLength(1);
    expect(judges(second)[0]).toMatchObject({ tripwire: 'fail2', epoch: 1 });
  });

  it('R-5: a pass between failures resets the count', () => {
    const c = make();
    c.onTestRun(FAIL);
    c.onTestRun(PASS);
    expect(judges(c.onTestRun(FAIL))).toHaveLength(0);
    expect(c.ownFails).toBe(1);
  });

  it('R-5: fires again at the 4th and 6th failure, not at the 3rd or 5th', () => {
    const c = make({ judge: false });
    const fired = [1, 2, 3, 4, 5, 6].map(() => rows(c.onTestRun(FAIL), 'mechanical').length);
    expect(fired).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('R-5: the packet carries the tripwire, the events and the failing output tail', () => {
    const p = fail2(make()).packet;
    expect(p).toContain('agent: lead · model ');
    expect(p).toContain('tripwire: 2nd failing test run in a row');
    expect(p).toContain('brief (opening): Coordinate the build of X.');
    expect(p).toContain('- test FAIL: npm test\n- test FAIL: npm test');
    expect(p).toContain('last output of the failing run (tail): expected 3 got 4');
  });

  it('R-5: the event token holds the command to 70 chars', () => {
    const c = make();
    c.onTestRun({ command: `npm test -- ${'a'.repeat(100)}`, failed: false, text: '' });
    const p = fail2(c).packet;
    expect(p).toContain(`- test PASS: npm test -- ${'a'.repeat(58)}\n`);
    expect(p).not.toContain('a'.repeat(59));
  });
});

describe('child returns', () => {
  const spawned = (c: Controller, id = 'c1', type = 'builder', name?: string) => c.onSpawn({ childId: id, type, name });

  it('R-6: a red return on the child\'s own turn.complete adds its unit and fires the red tripwire', () => {
    const c = make();
    spawned(c);
    const out = c.onChildReturn('c1', 'FAIL parser: 3 tests red\nmore detail');
    expect(c.reds.has('parser')).toBe(true);
    expect(judges(out)[0]).toMatchObject({ tripwire: 'red' });
    expect(judges(out)[0]!.packet).toContain('- return builder FAIL: FAIL parser: 3 tests red');
    expect(judges(out)[0]!.packet).toContain('return (head): FAIL parser: 3 tests red more detail');
  });

  it('R-6: a return naming no unit takes the child\'s type as its unit', () => {
    const c = make();
    spawned(c, 'c1', 'lander');
    c.onChildReturn('c1', 'BLOCKED');
    expect([...c.reds]).toEqual(['lander']);
  });

  it('R-6: a green return removes its unit from the reds', () => {
    const c = make({ judge: false });
    spawned(c);
    c.onChildReturn('c1', 'FAIL parser');
    c.onSendMessage('c1');
    c.onChildReturn('c1', 'DONE parser');
    expect(c.reds.size).toBe(0);
  });

  it('R-6: a return line already seen since the last spawn or SendMessage is ignored', () => {
    const c = make({ judge: false });
    spawned(c);
    expect(rows(c.onChildReturn('c1', 'FAIL parser'), 'mechanical')).toHaveLength(1);
    expect(rows(c.onRead('1→FAIL parser'), 'mechanical')).toHaveLength(0);
    c.onSendMessage('c1');
    expect(rows(c.onRead('1→FAIL parser'), 'mechanical')).toHaveLength(1);
  });

  it('R-6: a Read result counts through its first line, with the name as unit and no known child as "?"', () => {
    const c = make();
    expect(judges(c.onRead('     1→FAIL unit-9: reason\n'))[0]).toMatchObject({ tripwire: 'red' });
    expect(c.reds.has('unit-9')).toBe(true);
    const d = make();
    d.onRead('BLOCKED');
    expect(d.reds.has('?')).toBe(true);
  });

  it('R-6: a Read of a return whose name is a known child\'s name reads as that child\'s type', () => {
    const c = make();
    spawned(c, 'c1', 'builder', 'b1');
    const out = c.onRead('FAIL b1');
    expect(judges(out)[0]!.packet).toContain('- return builder FAIL: FAIL b1');
  });

  it('R-6: text that is not a return line changes nothing', () => {
    const c = make();
    spawned(c);
    const out = c.onChildReturn('c1', 'All good, finished.');
    expect(out.actions).toEqual([]);
    expect(c.reds.size).toBe(0);
  });

  it('R-6: the return token keeps the line to 100 chars', () => {
    const c = make();
    spawned(c);
    const p = judges(c.onChildReturn('c1', `FAIL x: ${'y'.repeat(200)}`))[0]!.packet;
    const event = p.split('\n').find((line) => line.startsWith('- return'));
    expect(event).toBe(`- return builder FAIL: FAIL x: ${'y'.repeat(92)}`);
  });
});

describe('re-dispatch', () => {
  function withRed(): Controller {
    const c = make();
    c.onSpawn({ childId: 'c1', type: 'builder', name: 'b1' });
    c.onChildReturn('c1', 'FAIL parser');
    return c;
  }

  it('R-7: a SendMessage to a red child by id fires the redispatch tripwire', () => {
    const c = withRed();
    c.onJudgeFailure(1, 'timeout');
    const out = c.onSendMessage('c1');
    expect(c.struggleOpen).toBe(true);
    expect(rows(out, 'judge-busy').length + judges(out).length).toBe(1);
  });

  it('R-7: a SendMessage to a red child by name fires it, with a packet reading "sent back to a sub-task"', () => {
    const c = withRed();
    c.onJudgeFailure(1, 'timeout');
    const out = c.onSendMessage('b1');
    expect(judges(out)[0]).toMatchObject({ tripwire: 'redispatch' });
    expect(judges(out)[0]!.packet).toContain('tripwire: a red result sent back to a sub-task');
    expect(judges(out)[0]!.packet).toContain('- sendmessage → builder');
    expect(judges(out)[0]!.packet).toContain('return (head): FAIL parser');
  });

  it('R-7: a SendMessage to a child that is not red fires nothing', () => {
    const c = make();
    c.onSpawn({ childId: 'c1', type: 'builder' });
    expect(judges(c.onSendMessage('c1'))).toHaveLength(0);
    expect(judges(c.onSendMessage('someone-else'))).toHaveLength(0);
  });

  it('R-7: spawning an agent of the type of a red child fires it', () => {
    const c = withRed();
    c.onJudgeFailure(1, 'timeout');
    const out = c.onSpawn({ childId: 'c2', type: 'builder' });
    expect(judges(out)[0]).toMatchObject({ tripwire: 'redispatch' });
    expect(judges(out)[0]!.packet).toContain('- spawn builder');
  });

  it('R-7: spawning another type fires nothing', () => {
    const c = withRed();
    c.onJudgeFailure(1, 'timeout');
    expect(judges(c.onSpawn({ childId: 'c2', type: 'reviewer' }))).toHaveLength(0);
  });
});

describe('a tripwire', () => {
  it('R-8: opens a struggle at the base level and starts one judge call', () => {
    const c = make({ home: 'high' });
    const j = fail2(c);
    expect(c.struggleOpen).toBe(true);
    expect(j).toMatchObject({ kind: 'judge', epoch: 1, tripwire: 'fail2' });
  });

  it('R-8: a request issued while the judge is pending goes at the old level, the next one after the answer at the new level', () => {
    const c = make();
    fail2(c);
    expect(c.onRequest('claude-opus-5-5', undefined).send).toBe('medium');
    c.onJudgeAnswer(1, 'xhigh - same test fails after the fix', 800, USAGE);
    expect(c.onRequest('claude-opus-5-5', undefined).send).toBe('xhigh');
  });

  it('R-8: an answer sets the level and logs the judge row with its tripwire, levels, reason, time and usage', () => {
    const c = make();
    fail2(c);
    const out = c.onJudgeAnswer(1, 'high - cause unknown', 812, USAGE);
    expect(c.level).toBe('high');
    expect(rows(out, 'judge')).toEqual([{ event: 'judge', tripwire: 'fail2', from: 'medium', to: 'high', reason: 'cause unknown', ms: 812, usage: USAGE }]);
  });

  it('R-8: a second tripwire while a call is in flight logs judge-busy and starts no other call', () => {
    const c = make();
    fail2(c);
    c.onTestRun(FAIL);
    const out = c.onTestRun(FAIL);
    expect(judges(out)).toHaveLength(0);
    expect(rows(out, 'judge-busy')).toHaveLength(1);
  });

  it('R-8: an answer after the struggle closed is stale and changes nothing', () => {
    const c = make();
    fail2(c);
    c.onTestRun(PASS);
    const out = c.onJudgeAnswer(1, 'max - x', 100, USAGE);
    expect(rows(out, 'judge-stale')).toHaveLength(1);
    expect(c.level).toBe('medium');
  });

  it('R-8: an answer for an earlier struggle\'s epoch is stale', () => {
    const c = make();
    fail2(c);
    c.onTestRun(PASS);
    c.onTestRun(FAIL);
    c.onTestRun(FAIL);
    const out = c.onJudgeAnswer(1, 'xhigh - x', 100, USAGE);
    expect(rows(out, 'judge-stale')).toHaveLength(1);
    expect(c.level).toBe('medium');
  });

  it('R-8: with the judge off, a tripwire raises one step mechanically, clamped to the ceiling', () => {
    const c = make({ judge: false, ceiling: 'high' });
    c.onTestRun(FAIL);
    const out = c.onTestRun(FAIL);
    expect(judges(out)).toHaveLength(0);
    expect(rows(out, 'mechanical')).toEqual([{ event: 'mechanical', tripwire: 'fail2', from: 'medium', to: 'high' }]);
    expect(c.level).toBe('high');
    c.onTestRun(FAIL);
    c.onTestRun(FAIL);
    expect(c.level).toBe('high');
  });
});

describe('a judge that gives no level', () => {
  it('R-9: a call that timed out or went unanswered raises one step and logs judge-failed with the reason', () => {
    const c = make();
    fail2(c);
    const out = c.onJudgeFailure(1, 'aborted');
    expect(c.level).toBe('high');
    expect(rows(out, 'judge-failed')).toEqual([{ event: 'judge-failed', tripwire: 'fail2', reason: 'aborted', from: 'medium', to: 'high' }]);
  });

  it('R-9: an answer that does not parse raises one step the same way', () => {
    const c = make();
    fail2(c);
    const out = c.onJudgeAnswer(1, 'I think maybe high', 700, USAGE);
    expect(c.level).toBe('high');
    expect(rows(out, 'judge-failed')[0]).toMatchObject({ reason: 'unparseable answer' });
  });

  it('R-9: an answer outside floor..ceiling does not parse', () => {
    const c = make();
    fail2(c);
    c.onJudgeAnswer(1, 'max - panic', 700, USAGE);
    expect(c.level).toBe('high');
  });

  it('R-9: a failure for a closed struggle logs but raises nothing', () => {
    const c = make();
    fail2(c);
    c.onTestRun(PASS);
    const out = c.onJudgeFailure(1, 'aborted');
    expect(c.level).toBe('medium');
    expect(rows(out, 'judge-failed')).toHaveLength(1);
  });

  it('R-9: after a failure the next tripwire may start a new call', () => {
    const c = make();
    fail2(c);
    c.onJudgeFailure(1, 'aborted');
    c.onTestRun(FAIL);
    expect(judges(c.onTestRun(FAIL))).toHaveLength(1);
  });
});

describe('resolution', () => {
  it('R-10: a passing test run with no red unit restores the pre-struggle level and logs resolved', () => {
    const c = make({ home: 'high' });
    fail2(c);
    c.onJudgeAnswer(1, 'xhigh - stuck', 100, USAGE);
    c.onRequest('claude-opus-5-5', undefined);
    c.onRequest('claude-opus-5-5', undefined);
    const out = c.onTestRun(PASS);
    expect(c.level).toBe('high');
    expect(c.struggleOpen).toBe(false);
    expect(rows(out, 'resolved')).toEqual([{ event: 'resolved', from: 'xhigh', to: 'high', requests: 2 }]);
  });

  it('R-10: a pass does not resolve while a red unit is open; the green return then does', () => {
    const c = make({ judge: false });
    c.onSpawn({ childId: 'c1', type: 'builder' });
    c.onChildReturn('c1', 'FAIL parser');
    expect(c.level).toBe('high');
    c.onTestRun(PASS);
    expect(c.struggleOpen).toBe(true);
    c.onSendMessage('c1');
    c.onChildReturn('c1', 'DONE parser');
    expect(c.struggleOpen).toBe(false);
    expect(c.level).toBe('medium');
  });

  it('R-10: a green return does not resolve while own test runs still fail', () => {
    const c = make({ judge: false });
    c.onSpawn({ childId: 'c1', type: 'builder' });
    c.onChildReturn('c1', 'FAIL parser');
    c.onTestRun(FAIL);
    c.onSendMessage('c1');
    c.onChildReturn('c1', 'DONE parser');
    expect(c.struggleOpen).toBe(true);
    c.onTestRun(PASS);
    expect(c.struggleOpen).toBe(false);
  });

  it('R-10: a judge answer after resolution is stale', () => {
    const c = make();
    fail2(c);
    c.onTestRun(PASS);
    expect(c.struggleOpen).toBe(false);
    c.onJudgeAnswer(1, 'max - x', 1, USAGE);
    expect(c.level).toBe('medium');
  });
});

describe('landing', () => {
  it('R-11: spawning a landing type drops base one step below home, floored', () => {
    const c = make({ home: 'high', landing: ['lander'] });
    const out = c.onSpawn({ childId: 'c1', type: 'lander' });
    expect(c.level).toBe('medium');
    expect(c.base).toBe('medium');
    expect(rows(out, 'landing')).toEqual([{ event: 'landing', from: 'high', to: 'medium' }]);
    const low = make({ home: 'medium', landing: ['lander'] });
    low.onSpawn({ childId: 'c1', type: 'lander' });
    expect(low.level).toBe('medium');
  });

  it('R-11: another type does not land', () => {
    const c = make({ home: 'high', landing: ['lander'] });
    c.onSpawn({ childId: 'c1', type: 'builder' });
    expect(c.level).toBe('high');
  });

  it('R-11: during a struggle landing moves the level it resolves to, not the current one', () => {
    const c = make({ home: 'high', landing: ['lander'] });
    fail2(c);
    c.onJudgeAnswer(1, 'xhigh - stuck', 1, USAGE);
    c.onSpawn({ childId: 'c1', type: 'lander' });
    expect(c.level).toBe('xhigh');
    c.onTestRun(PASS);
    expect(c.level).toBe('medium');
  });

  it('R-11: a lander\'s red return is an ordinary red return', () => {
    const c = make({ home: 'high', landing: ['lander'] });
    c.onSpawn({ childId: 'c1', type: 'lander' });
    expect(judges(c.onChildReturn('c1', 'BLOCKED ci')).map((j) => j.tripwire)).toEqual(['red']);
  });
});

describe('buttons', () => {
  it('R-12: up raises one step and, outside a struggle, moves the base with it', () => {
    const c = make();
    const out = c.onButton('up');
    expect(out.text).toBe('Effort raised to high for your next replies (your range medium..xhigh).');
    expect(c.level).toBe('high');
    expect(c.base).toBe('high');
    expect(rows(out, 'button')).toEqual([{ event: 'button', direction: 'up', from: 'medium', to: 'high' }]);
  });

  it('R-12: down lowers one step', () => {
    const c = make({ home: 'high' });
    expect(c.onButton('down').text).toBe('Effort lowered to medium for your next replies (your range medium..xhigh).');
  });

  it('R-12: at a bound it answers the bound text and changes nothing', () => {
    const c = make({ home: 'xhigh' });
    expect(c.onButton('up').text).toBe('Your effort is already xhigh, the ceiling of your range; nothing changed.');
    const d = make();
    const out = d.onButton('down');
    expect(out.text).toBe('Your effort is already medium, the floor of your range; nothing changed.');
    expect(rows(out, 'button')).toEqual([]);
  });

  it('R-12: during a struggle the base stays, so resolution returns to the pre-struggle level', () => {
    const c = make();
    fail2(c);
    c.onButton('up');
    expect(c.level).toBe('high');
    expect(c.base).toBe('medium');
    c.onTestRun(PASS);
    expect(c.level).toBe('medium');
  });
});

describe('announcements', () => {
  it('queues one line per level change, handed over once', () => {
    const c = make({ judge: false });
    c.onTestRun(FAIL);
    c.onTestRun(FAIL);
    expect(c.takeAnnouncement()).toBe('effort-live-control: your reasoning effort is now high — 2nd failing test run in a row.');
    expect(c.takeAnnouncement()).toBeUndefined();
  });

  it('names the child and its token for a red return, and the type for a re-dispatch', () => {
    const c = make({ judge: false });
    c.onSpawn({ childId: 'c1', type: 'lander' });
    c.onChildReturn('c1', 'BLOCKED');
    expect(c.takeAnnouncement()).toContain('— lander returned BLOCKED.');
    c.onSendMessage('c1');
    expect(c.takeAnnouncement()).toContain('— lander sent back a red result.');
  });

  it('a newer change replaces an undelivered line', () => {
    const c = make({ judge: false });
    c.onTestRun(FAIL);
    c.onTestRun(FAIL);
    c.onTestRun(PASS);
    expect(c.takeAnnouncement()).toBe('effort-live-control: your reasoning effort is now medium — the trouble is resolved, back to medium.');
  });

  it('carries the judge\'s reason', () => {
    const c = make();
    fail2(c);
    c.onJudgeAnswer(1, 'xhigh - cause unknown', 1, USAGE);
    expect(c.takeAnnouncement()).toBe('effort-live-control: your reasoning effort is now xhigh — judge: cause unknown.');
  });

  it('R-11: carries the landing line', () => {
    const c = make({ home: 'high', landing: ['lander'] });
    c.onSpawn({ childId: 'c1', type: 'lander' });
    expect(c.takeAnnouncement()).toBe('effort-live-control: your reasoning effort is now medium — landing, one step below your home level.');
  });

  it('says "judge unavailable" after a failed call', () => {
    const c = make();
    fail2(c);
    c.onJudgeFailure(1, 'aborted');
    expect(c.takeAnnouncement()).toBe('effort-live-control: your reasoning effort is now high — judge unavailable, raised one step.');
  });

  it('says nothing for a change that leaves the level where it was, for a button press, or with announce off', () => {
    const c = make();
    fail2(c);
    c.onJudgeAnswer(1, 'medium - plain fix', 1, USAGE);
    expect(c.takeAnnouncement()).toBeUndefined();
    c.onButton('up');
    expect(c.takeAnnouncement()).toBeUndefined();
    const quiet = make({ judge: false, announce: false });
    quiet.onTestRun(FAIL);
    quiet.onTestRun(FAIL);
    expect(quiet.level).toBe('high');
    expect(quiet.takeAnnouncement()).toBeUndefined();
  });
});

describe('end', () => {
  it('summarises requests by level, struggles and judge calls', () => {
    const c = make();
    c.onRequest('claude-opus-5-5', undefined);
    fail2(c);
    c.onJudgeAnswer(1, 'high - x', 1, USAGE);
    c.onRequest('claude-opus-5-5', undefined);
    c.onRequest('claude-opus-5-5', undefined);
    expect(c.end()).toEqual({ event: 'end', requests: { medium: 1, high: 2 }, struggles: 1, judgeCalls: 1, judgeTokens: { input: 10, output: 5 } });
  });
});
