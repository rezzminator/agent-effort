import { describe, expect, it } from 'vitest';
import { JUDGE_SYSTEM, packet, parseAnswer, PACKET_MAX, type PacketInput } from '../plugins/effort-live-control/src/judge.ts';

const ALLOWED = ['medium', 'high', 'xhigh'] as const;

describe('parseAnswer', () => {
  it('R-8: reads the level and the reason after " - "', () => {
    expect(parseAnswer('xhigh - same test fails after the fix, cause unknown', ALLOWED)).toEqual({ level: 'xhigh', reason: 'same test fails after the fix, cause unknown' });
  });

  it('R-8: reads the first non-blank line, strips backticks and asterisks, ignores case', () => {
    expect(parseAnswer('\n\n**High** - because\nextra', ALLOWED)).toEqual({ level: 'high', reason: 'because' });
    expect(parseAnswer('`medium` - hold', ALLOWED)).toEqual({ level: 'medium', reason: 'hold' });
  });

  it('R-9: a level outside the allowed range is not parsed', () => {
    expect(parseAnswer('max - go all in', ALLOWED)).toBeUndefined();
    expect(parseAnswer('low - bookkeeping', ALLOWED)).toBeUndefined();
  });

  it('R-9: anything that is not a level first is not parsed', () => {
    expect(parseAnswer('I would raise it to high', ALLOWED)).toBeUndefined();
    expect(parseAnswer('', ALLOWED)).toBeUndefined();
    expect(parseAnswer('   \n  ', ALLOWED)).toBeUndefined();
    expect(parseAnswer('higher - x', ALLOWED)).toBeUndefined();
  });

  it('R-8: a level with no reason parses with an empty reason; a long reason is cut to 120 chars', () => {
    expect(parseAnswer('high', ALLOWED)).toEqual({ level: 'high', reason: '' });
    expect(parseAnswer(`high - ${'x'.repeat(300)}`, ALLOWED)?.reason).toHaveLength(120);
  });
});

describe('JUDGE_SYSTEM', () => {
  it('R-8: is the spec prompt, verbatim at its anchors', () => {
    expect(JUDGE_SYSTEM.startsWith('You set the reasoning effort of an AI coding agent while it works. The levels, cheapest first: low, medium, high, xhigh, max.')).toBe(true);
    expect(JUDGE_SYSTEM).toContain('Raise two steps only when several of these hold at once.');
    expect(JUDGE_SYSTEM).toContain('Lower one step only when what remains is waiting, relaying results or bookkeeping.');
    expect(JUDGE_SYSTEM.endsWith('Example: xhigh - same test fails after the fix, cause unknown')).toBe(true);
    expect(JUDGE_SYSTEM.split('\n')).toHaveLength(17);
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
