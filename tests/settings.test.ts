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
      parentTag: 'honor',
      struggleDecay: 20,
    });
    expect(DEFAULTS.testCommandPatterns).toHaveLength(17);
    expect(DEFAULTS.failurePatterns).toHaveLength(6);
    expect(SETTING_KEYS).toHaveLength(26);
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

describe('parentTag option', () => {
  it('parentTag: honor is the default, and honor and ignore are read', () => {
    expect(DEFAULTS.parentTag).toBe('honor');
    expect(resolveSettings({ parentTag: 'ignore' })).toEqual({ settings: { ...DEFAULTS, parentTag: 'ignore' }, errors: [] });
    expect(resolveSettings({ parentTag: 'honor' })).toEqual({ settings: DEFAULTS, errors: [] });
  });

  it('parentTag: an unknown value is reported by key and value and honor applies', () => {
    for (const raw of ['sometimes', 'Honor', '', true, 7]) {
      const { settings, errors } = resolveSettings({ parentTag: raw });
      expect(settings.parentTag, String(raw)).toBe('honor');
      expect(errors, String(raw)).toEqual([`effort-live-control: option "parentTag" is ${JSON.stringify(raw)}, not honor or ignore; using the default "honor"`]);
    }
  });
});

describe('struggleDecay option', () => {
  it('decay: 20 is the default, and a whole number from 0 up is read, as a number or as text', () => {
    expect(resolveSettings({}).settings.struggleDecay).toBe(20);
    expect(resolveSettings({ struggleDecay: 0 })).toEqual({ settings: { ...DEFAULTS, struggleDecay: 0 }, errors: [] });
    expect(resolveSettings({ struggleDecay: 7 }).settings.struggleDecay).toBe(7);
    expect(resolveSettings({ struggleDecay: '12' }).settings.struggleDecay).toBe(12);
  });

  it('decay: a bad value is reported by key and value and the default applies', () => {
    for (const raw of [-1, 1.5, 'soon', '', null, true]) {
      const { settings, errors } = resolveSettings({ struggleDecay: raw });
      expect(settings.struggleDecay, String(raw)).toBe(20);
      expect(errors, String(raw)).toHaveLength(1);
      expect(errors[0], String(raw)).toContain(`option "struggleDecay" is ${JSON.stringify(raw)}`);
      expect(errors[0], String(raw)).toContain('using the default 20');
    }
  });
});

describe('readOnlyCommands', () => {
  it('readOnlyCommands: the default names the programs that only read or print, and not the ones that execute', () => {
    expect(DEFAULTS.readOnlyCommands).toEqual(expect.arrayContaining(['cat', 'grep', 'echo', 'git', 'sed', '[', '[[', 'cd', 'sleep', 'kill']));
    expect(DEFAULTS.readOnlyCommands).not.toContain('source');
    expect(DEFAULTS.readOnlyCommands).not.toContain('.');
    expect(DEFAULTS.readOnlyCommands).toHaveLength(new Set(DEFAULTS.readOnlyCommands).size);
  });

  it('readOnlyCommands: a custom list replaces the default', () => {
    expect(resolveSettings({ readOnlyCommands: ['grep', 'cat'] })).toEqual({ settings: { ...DEFAULTS, readOnlyCommands: ['grep', 'cat'] }, errors: [] });
    expect(resolveSettings({ readOnlyCommands: 'grep\ncat' }).settings.readOnlyCommands).toEqual(['grep', 'cat']);
  });

  it.each([['two words', ['cat', 'two words']], ['', ['cat', '']], ['tab\there', ['tab\there']]])('readOnlyCommands: a bad item is reported and the default applies (%j)', (_label, raw) => {
    const { settings, errors } = resolveSettings({ readOnlyCommands: raw });
    expect(settings.readOnlyCommands).toEqual(DEFAULTS.readOnlyCommands);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('option "readOnlyCommands"');
    expect(errors[0]).toContain(JSON.stringify(raw));
  });
});

describe('main chat options', () => {
  it('mainChat, casebookFile, promptModel, promptEffort and promptTimeoutMs hold their defaults', () => {
    expect(DEFAULTS).toMatchObject({
      mainChat: 'reader',
      casebookFile: '~/.local/state/effort-live-control/casebook.jsonl',
      promptModel: 'haiku',
      promptEffort: 'xhigh',
      promptTimeoutMs: 10000,
    });
  });

  it('reads valid values', () => {
    const raw = { mainChat: 'tripwires', casebookFile: '/x/cases.jsonl', promptModel: 'sonnet', promptEffort: 'low', promptTimeoutMs: '3000' };
    expect(resolveSettings(raw)).toEqual({ settings: { ...DEFAULTS, ...raw, promptTimeoutMs: 3000 }, errors: [] });
    expect(resolveSettings({ mainChat: 'off' }).settings.mainChat).toBe('off');
  });

  it.each([
    ['mainChat', 'sometimes', 'not off, tripwires or reader'],
    ['casebookFile', 3, 'not text'],
    ['promptModel', 'two words', 'not a model alias or id (text without spaces)'],
    ['promptEffort', 'ultra', 'not a level (low, medium, high, xhigh, max)'],
    ['promptTimeoutMs', 0, 'not a whole number of at least 1'],
  ])('%s: a bad value is reported by key and value and the default applies', (key, value, why) => {
    const { settings, errors } = resolveSettings({ [key]: value });
    expect(settings[key as keyof typeof DEFAULTS]).toEqual(DEFAULTS[key as keyof typeof DEFAULTS]);
    expect(errors).toEqual([`effort-live-control: option "${key}" is ${JSON.stringify(value)}, ${why}; using the default ${JSON.stringify(DEFAULTS[key as keyof typeof DEFAULTS])}`]);
  });
});

describe('compile', () => {
  it('turns the patterns into regular expressions', () => {
    const compiled = compile(DEFAULTS);
    expect(compiled.testCommand).toHaveLength(17);
    expect(compiled.failure).toHaveLength(6);
    expect(compiled.testCommand.every((re) => re instanceof RegExp)).toBe(true);
    expect(compiled.readOnly).toEqual(new Set(DEFAULTS.readOnlyCommands));
  });
});
