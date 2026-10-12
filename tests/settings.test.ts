import { describe, expect, it } from 'vitest';
import { compile, DEFAULTS, resolveSettings, SETTING_KEYS } from '../plugins/effort-live-control/src/settings.ts';

describe('resolveSettings', () => {
  it('uses the defaults for no options, with no errors', () => {
    expect(resolveSettings({})).toEqual({ settings: DEFAULTS, errors: [] });
  });

  it('holds the spec defaults', () => {
    expect(DEFAULTS).toMatchObject({
      floor: 'medium',
      ceiling: 'xhigh',
      models: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5'],
      judge: true,
      judgeModel: 'haiku',
      judgeEffort: 'xhigh',
      judgeTimeoutMs: 45000,
      buttons: true,
      announce: true,
      redWords: ['FAIL', 'FAILED', 'BLOCKED', 'PARTIAL', 'SPEC-DRIFT'],
      greenWords: ['DONE', 'PASS', 'FIXED'],
      agentDirs: [],
      logFile: '~/.local/state/effort-live-control/decisions.jsonl',
      logPackets: false,
    });
    expect(DEFAULTS.testCommandPatterns).toHaveLength(15);
    expect(DEFAULTS.failurePatterns).toHaveLength(6);
    expect(SETTING_KEYS).toHaveLength(16);
  });

  it('reads valid values of every kind', () => {
    const raw = { floor: 'low', ceiling: 'max', models: ['claude-x'], judge: false, judgeModel: 'sonnet', judgeEffort: 'high', judgeTimeoutMs: 9000, buttons: false, announce: false, redWords: ['NO'], greenWords: ['YES'], agentDirs: ['/x'], logFile: '', logPackets: true };
    expect(resolveSettings(raw)).toEqual({ settings: { ...DEFAULTS, ...raw }, errors: [] });
  });

  it('reads booleans and numbers given as text', () => {
    const { settings, errors } = resolveSettings({ judge: 'false', judgeTimeoutMs: '1200' });
    expect(errors).toEqual([]);
    expect(settings).toMatchObject({ judge: false, judgeTimeoutMs: 1200 });
  });

  it('reports a bad value by key and value and uses the default', () => {
    const { settings, errors } = resolveSettings({ floor: 'sideways', judgeTimeoutMs: 0, buttons: 'maybe', judgeEffort: 'ultra' });
    expect(settings).toMatchObject({ floor: 'medium', judgeTimeoutMs: 45000, buttons: true, judgeEffort: 'xhigh' });
    expect(errors).toHaveLength(4);
    expect(errors[0]).toBe('effort-live-control: option "floor" is "sideways", not a level (low, medium, high, xhigh, max); using the default "medium"');
  });

  it('reports a pattern that is not a regular expression', () => {
    const { settings, errors } = resolveSettings({ testCommandPatterns: ['(unclosed'] });
    expect(settings.testCommandPatterns).toEqual(DEFAULTS.testCommandPatterns);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('option "testCommandPatterns"');
    expect(errors[0]).toContain('is not a regular expression');
  });

  it('reports a word that cannot be a return token', () => {
    const { settings, errors } = resolveSettings({ redWords: ['OK now'] });
    expect(settings.redWords).toEqual(DEFAULTS.redWords);
    expect(errors[0]).toContain('option "redWords"');
  });

  it('reports a floor above the ceiling and uses both defaults', () => {
    const { settings, errors } = resolveSettings({ floor: 'max', ceiling: 'low' });
    expect(settings).toMatchObject({ floor: 'medium', ceiling: 'xhigh' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('option "floor"');
  });

  it('reads a list given as text, one entry per line, and an empty text as the default', () => {
    expect(resolveSettings({ models: 'a\n b \n\nc' }).settings.models).toEqual(['a', 'b', 'c']);
    expect(resolveSettings({ models: '' }).settings.models).toEqual(DEFAULTS.models);
  });

  it('R-16: an empty logFile text turns the log off', () => {
    expect(resolveSettings({ logFile: '' }).settings.logFile).toBe('');
  });
});

describe('compile', () => {
  it('turns the patterns into regular expressions', () => {
    const compiled = compile(DEFAULTS);
    expect(compiled.testCommand).toHaveLength(15);
    expect(compiled.failure).toHaveLength(6);
    expect(compiled.testCommand.every((re) => re instanceof RegExp)).toBe(true);
  });
});
