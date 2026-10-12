import { describe, expect, it } from 'vitest';
import { clamp, isLevel, step } from '../plugins/effort-live-control/src/ladder.ts';

describe('isLevel', () => {
  it('accepts the five levels and nothing else', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) expect(isLevel(level)).toBe(true);
    for (const other of ['HIGH', 'ultra', '', 5, undefined, null]) expect(isLevel(other)).toBe(false);
  });
});

describe('clamp', () => {
  it('pulls a level into floor..ceiling', () => {
    expect(clamp('low', 'medium', 'xhigh')).toBe('medium');
    expect(clamp('max', 'medium', 'xhigh')).toBe('xhigh');
    expect(clamp('high', 'medium', 'xhigh')).toBe('high');
  });
});

describe('step', () => {
  it('moves one level up or down the ladder', () => {
    expect(step('medium', +1, 'low', 'max')).toBe('high');
    expect(step('high', -1, 'low', 'max')).toBe('medium');
    expect(step('high', +2, 'low', 'max')).toBe('max');
  });

  it('stops at the floor and at the ceiling', () => {
    expect(step('medium', -1, 'medium', 'xhigh')).toBe('medium');
    expect(step('xhigh', +1, 'medium', 'xhigh')).toBe('xhigh');
    expect(step('low', -3, 'low', 'max')).toBe('low');
  });

  it('brings a level outside the range into it', () => {
    expect(step('low', +1, 'high', 'xhigh')).toBe('high');
    expect(step('max', -1, 'medium', 'high')).toBe('high');
  });
});
