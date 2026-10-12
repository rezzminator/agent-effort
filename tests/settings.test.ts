import { describe, expect, it } from 'vitest';
import { parseTripwires } from '../plugins/effort-live-control/src/judge.ts';
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
      judge: false,
      judgeRaiseAt: 25,
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
      tripwires: 'fail1,fail2,red,redispatch',
    });
    expect(DEFAULTS.testCommandPatterns).toHaveLength(17);
    expect(DEFAULTS.failurePatterns).toHaveLength(6);
    expect(SETTING_KEYS).toHaveLength(18);
  });

  it('reads valid values of every kind', () => {
    const raw = { floor: 'low', ceiling: 'max', models: ['claude-x'], judge: true, judgeRaiseAt: 50, judgeModel: 'sonnet', judgeEffort: 'high', judgeTimeoutMs: 9000, buttons: false, announce: false, redWords: ['NO'], greenWords: ['YES'], agentDirs: ['/x'], logFile: '', logPackets: true, tripwires: 'fail2, red' };
    expect(resolveSettings(raw)).toEqual({ settings: { ...DEFAULTS, ...raw }, errors: [] });
  });

  it('reads booleans and numbers given as text', () => {
    const { settings, errors } = resolveSettings({ judge: 'true', judgeTimeoutMs: '1200', judgeRaiseAt: '40' });
    expect(errors).toEqual([]);
    expect(settings).toMatchObject({ judge: true, judgeTimeoutMs: 1200, judgeRaiseAt: 40 });
  });

  it('reports a bad value by key and value and uses the default', () => {
    const { settings, errors } = resolveSettings({ floor: 'sideways', judgeTimeoutMs: 0, buttons: 'maybe', judgeEffort: 'ultra' });
    expect(settings).toMatchObject({ floor: 'medium', judgeTimeoutMs: 45000, buttons: true, judgeEffort: 'xhigh' });
    expect(errors).toHaveLength(4);
    expect(errors[0]).toBe('effort-live-control: option "floor" is "sideways", not a level (low, medium, high, xhigh, max); using the default "medium"');
  });

  it('judgeRaiseAt takes a number from 0 to 100 and reports anything else', () => {
    expect(resolveSettings({ judgeRaiseAt: 0 }).settings.judgeRaiseAt).toBe(0);
    expect(resolveSettings({ judgeRaiseAt: 100 }).settings.judgeRaiseAt).toBe(100);
    for (const raw of [101, -1, 12.5, 'high', '']) {
      const { settings, errors } = resolveSettings({ judgeRaiseAt: raw });
      expect(settings.judgeRaiseAt, String(raw)).toBe(25);
      expect(errors, String(raw)).toHaveLength(1);
      expect(errors[0]).toContain('option "judgeRaiseAt"');
    }
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

describe('tripwires option', () => {
  it('tripwires: the default arms all four', () => {
    expect(DEFAULTS.tripwires).toBe('fail1,fail2,red,redispatch');
    expect(parseTripwires(DEFAULTS.tripwires)).toEqual({ ok: true, value: ['fail1', 'fail2', 'red', 'redispatch'] });
    expect(resolveSettings({}).errors).toEqual([]);
  });

  it('tripwires: whitespace around names is ignored, case is not significant and a repeat counts once', () => {
    expect(parseTripwires(' red ,  fail2\t, RED')).toEqual({ ok: true, value: ['red', 'fail2'] });
    expect(resolveSettings({ tripwires: ' fail2 , red ' })).toEqual({ settings: { ...DEFAULTS, tripwires: ' fail2 , red ' }, errors: [] });
  });

  it('tripwires: an empty list arms none', () => {
    expect(parseTripwires('')).toEqual({ ok: true, value: [] });
    expect(parseTripwires('  ')).toEqual({ ok: true, value: [] });
    expect(resolveSettings({ tripwires: '' })).toEqual({ settings: { ...DEFAULTS, tripwires: '' }, errors: [] });
  });

  it('tripwires: an unknown name is reported and the default applies', () => {
    const { settings, errors } = resolveSettings({ tripwires: 'fail1,boom' });
    expect(settings.tripwires).toBe('fail1,fail2,red,redispatch');
    expect(errors).toEqual(['effort-live-control: option "tripwires" is "fail1,boom", "boom" is not a tripwire (fail1, fail2, red, redispatch); using the default "fail1,fail2,red,redispatch"']);
    expect(resolveSettings({ tripwires: 7 }).errors).toHaveLength(1);
  });
});

describe('compile', () => {
  it('turns the patterns into regular expressions', () => {
    const compiled = compile(DEFAULTS);
    expect(compiled.testCommand).toHaveLength(17);
    expect(compiled.failure).toHaveLength(6);
    expect(compiled.testCommand.every((re) => re instanceof RegExp)).toBe(true);
  });
});
