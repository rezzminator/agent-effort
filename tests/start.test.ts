import { describe, expect, it } from 'vitest';
import { startOf } from '../plugins/effort-live-control/src/start.ts';

const RANGE = { floor: 'medium', ceiling: 'xhigh' } as const;

describe('startOf', () => {
  it('parentTag: the home is clamped into floor and ceiling, and a tag within the range is the home', () => {
    expect(startOf({ tagged: 'medium', own: 'high', parentTag: 'honor', range: RANGE })).toEqual({ level: 'medium', row: { event: 'tag', tag: 'medium', effort: 'high', home: 'medium' } });
    expect(startOf({ tagged: 'low', own: 'high', parentTag: 'honor', range: RANGE })).toEqual({ level: 'medium', row: { event: 'tag', tag: 'low', effort: 'high', home: 'medium', clamped: true } });
    expect(startOf({ tagged: 'max', own: 'high', parentTag: 'honor', range: RANGE })).toEqual({ level: 'xhigh', row: { event: 'tag', tag: 'max', effort: 'high', home: 'xhigh', clamped: true } });
  });

  it('parentTag: honor on a steered type without effort logs the tag row with effort null', () => {
    expect(startOf({ tagged: 'low', own: undefined, parentTag: 'honor', range: RANGE })).toEqual({ level: 'medium', row: { event: 'tag', tag: 'low', effort: null, home: 'medium', clamped: true } });
  });

  it('parentTag: honor on an unsteered type with its own effort pins at the tag and logs the tag row without a home', () => {
    expect(startOf({ tagged: 'low', own: 'high', parentTag: 'honor', range: undefined })).toEqual({ level: 'low', row: { event: 'tag', tag: 'low', effort: 'high' } });
  });

  it('parentTag: honor on an unsteered type without effort is the plain tag, no row', () => {
    expect(startOf({ tagged: 'low', own: undefined, parentTag: 'honor', range: undefined })).toEqual({ level: 'low' });
  });

  it('parentTag: ignore keeps the definition effort and logs tag-ignored', () => {
    for (const range of [RANGE, undefined]) {
      expect(startOf({ tagged: 'low', own: 'high', parentTag: 'ignore', range })).toEqual({ level: 'high', row: { event: 'tag-ignored', tag: 'low', effort: 'high' } });
    }
  });

  it('parentTag: ignore on a type without effort is today: the tag, no row', () => {
    expect(startOf({ tagged: 'low', own: undefined, parentTag: 'ignore', range: undefined })).toEqual({ level: 'low' });
    expect(startOf({ tagged: 'high', own: undefined, parentTag: 'ignore', range: RANGE })).toEqual({ level: 'high' });
  });

  it('parentTag: an untagged spawn keeps the definition effort, whichever the mode', () => {
    for (const parentTag of ['honor', 'ignore'] as const) {
      for (const range of [RANGE, undefined]) {
        expect(startOf({ tagged: undefined, own: 'high', parentTag, range })).toEqual({ level: 'high' });
        expect(startOf({ tagged: undefined, own: undefined, parentTag, range })).toEqual({ level: undefined });
      }
    }
  });
});
