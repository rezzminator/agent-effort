import { describe, expect, it } from 'vitest';
import { JUDGE_SYSTEM, packet, parseAnswer, PACKET_MAX, type PacketInput } from '../plugins/effort-live-control/src/judge.ts';

describe('parseAnswer', () => {
  it('R-8: reads the probability and the reason after " - "', () => {
    expect(parseAnswer('85 - same assertion fails after the fix, cause unknown')).toEqual({ p: 85, reason: 'same assertion fails after the fix, cause unknown' });
  });

  it('R-8: reads the first non-blank line and strips backticks and asterisks', () => {
    expect(parseAnswer('\n\n**40** - because\nextra')).toEqual({ p: 40, reason: 'because' });
    expect(parseAnswer('`0` - hold')).toEqual({ p: 0, reason: 'hold' });
    expect(parseAnswer('100 - certain')).toEqual({ p: 100, reason: 'certain' });
  });

  it('R-9: a number above 100 is not parsed', () => {
    expect(parseAnswer('101 - too sure')).toBeUndefined();
    expect(parseAnswer('1000 - way too sure')).toBeUndefined();
  });

  it('R-9: an answer without a leading number is unparsed', () => {
    expect(parseAnswer('I would say about 60')).toBeUndefined();
    expect(parseAnswer('high - stuck')).toBeUndefined();
    expect(parseAnswer('')).toBeUndefined();
    expect(parseAnswer('   \n  ')).toBeUndefined();
    expect(parseAnswer('about 60')).toBeUndefined();
  });

  it('R-8: a number with no reason parses with an empty reason; a long reason is cut to 120 chars', () => {
    expect(parseAnswer('60')).toEqual({ p: 60, reason: '' });
    expect(parseAnswer(`60 - ${'x'.repeat(300)}`)?.reason).toHaveLength(120);
  });
});

describe('JUDGE_SYSTEM', () => {
  it('R-8: is the v2 prompt, verbatim at its anchors', () => {
    expect(JUDGE_SYSTEM.startsWith('You estimate whether an AI coding agent is in real trouble, so its reasoning effort can be raised in time.')).toBe(true);
    expect(JUDGE_SYSTEM).toContain('Estimate the probability, from 0 to 100, that the trouble continues:');
    expect(JUDGE_SYSTEM).toContain('- a failing test run, the first in a row: about 1 in 2\n- the 2nd failing test run in a row: about 9 in 10\n- a sub-task returned red: about 9 in 10\n- a red result sent back to a sub-task: about 8 in 10\n');
    expect(JUDGE_SYSTEM).toContain('Waiting for a sub-task is normal for this agent and is no evidence either way.');
    expect(JUDGE_SYSTEM.endsWith('Example: 85 - same assertion fails after the fix, cause unknown')).toBe(true);
    expect(JUDGE_SYSTEM.split('\n')).toHaveLength(16);
  });
});

const base: PacketInput = {
  type: 'builder',
  model: 'claude-opus-5-5',
  level: 'high',
  home: 'medium',
  floor: 'medium',
  ceiling: 'xhigh',
  tripwire: 'fail2',
  brief: 'Build the   parser\nfor X.',
  events: ['test FAIL: npm test', 'test FAIL: npm test'],
  failTail: 'expected 3 got 4',
  returnHead: undefined,
  lastWords: 'I will try a different approach',
};

describe('packet', () => {
  it('R-5: lays out exactly the spec sections for a fail2 tripwire', () => {
    expect(packet(base)).toBe(
      [
        'agent: builder · model claude-opus-5-5 · effort now high · home medium · allowed medium..xhigh',
        'tripwire: 2nd failing test run in a row',
        'brief (opening): Build the parser for X.',
        'recent events (oldest first):',
        '- test FAIL: npm test',
        '- test FAIL: npm test',
        'last output of the failing run (tail): expected 3 got 4',
        "agent's last words (tail): I will try a different approach",
      ].join('\n'),
    );
  });

  it('R-5: a fail1 tripwire reads "a failing test run" and carries the failing run\'s output', () => {
    const text = packet({ ...base, tripwire: 'fail1', events: ['test FAIL: npm test'] });
    expect(text).toContain('tripwire: a failing test run\n');
    expect(text).toContain('last output of the failing run (tail): expected 3 got 4');
    expect(text).not.toContain('return (head)');
  });

  it('R-6: a red tripwire carries the return head and no failing-run section', () => {
    const text = packet({ ...base, tripwire: 'red', failTail: undefined, returnHead: 'FAIL unit-a: boom', lastWords: '' });
    expect(text).toContain('tripwire: a sub-task returned red');
    expect(text).toContain('return (head): FAIL unit-a: boom');
    expect(text).not.toContain('last output of the failing run');
    expect(text).toContain("agent's last words (tail): (none)");
  });

  it('R-7: a redispatch tripwire reads "a red result sent back to a sub-task"', () => {
    const text = packet({ ...base, tripwire: 'redispatch', failTail: undefined, returnHead: 'BLOCKED x' });
    expect(text).toContain('tripwire: a red result sent back to a sub-task');
    expect(text).toContain('return (head): BLOCKED x');
  });

  it('R-5: holds only the last 12 events and clips the sections', () => {
    const events = Array.from({ length: 20 }, (_, i) => `ev ${i}`);
    const text = packet({ ...base, events, brief: 'b'.repeat(900), failTail: 'f'.repeat(500), lastWords: 'w'.repeat(500) });
    expect(text).not.toContain('- ev 7\n');
    expect(text).toContain('- ev 8\n');
    expect(text).toContain('- ev 19');
    expect(text).toContain(`brief (opening): ${'b'.repeat(600)}\n`);
    expect(text).not.toContain('b'.repeat(601));
    expect(text).toContain(`(tail): ${'f'.repeat(300)}\n`);
    expect(text).not.toContain('f'.repeat(301));
    expect(text).toContain(`(tail): ${'w'.repeat(400)}`);
    expect(text).not.toContain('w'.repeat(401));
  });

  it('R-5: stays within 2,500 characters whatever the parts, dropping the oldest events first', () => {
    const events = Array.from({ length: 12 }, (_, i) => `return builder FAIL: ${String(i).padStart(2, '0')}${'z'.repeat(130)}`);
    const text = packet({ ...base, tripwire: 'red', events, brief: 'b'.repeat(900), returnHead: 'r'.repeat(500), lastWords: 'w'.repeat(500) });
    expect(PACKET_MAX).toBe(2500);
    expect(text.length).toBeLessThanOrEqual(2500);
    expect(text).toContain('- return builder FAIL: 11');
    expect(text).toContain("agent's last words (tail): " + 'w'.repeat(400));
  });
});
