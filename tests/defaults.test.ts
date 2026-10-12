import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULTS, SETTING_KEYS } from '../plugins/effort-live-control/src/settings.ts';

// Every knob is a plugin option. Defaults agree in three places: src/settings.ts, plugin.json's userConfig and the README table.
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('plugins/effort-live-control/.claude-plugin/plugin.json', root), 'utf8'));
const readmes = ['README.md', 'plugins/effort-live-control/README.md'].map((path) => [path, readFileSync(new URL(path, root), 'utf8')] as const);

describe('plugin options', () => {
  it('declares exactly the settings, each with its default, a title opening with its key, and a matching type', () => {
    expect(Object.keys(manifest.userConfig).sort()).toEqual([...SETTING_KEYS].sort());
    for (const key of SETTING_KEYS) {
      const field = manifest.userConfig[key];
      expect(field.default, key).toEqual(DEFAULTS[key]);
      expect(field.title.startsWith(`${key}: `), key).toBe(true);
      expect(typeof field.description, key).toBe('string');
      expect(field.type, key).toBe(typeof DEFAULTS[key] === 'object' ? 'string' : typeof DEFAULTS[key]);
      expect(Boolean(field.multiple), key).toBe(Array.isArray(DEFAULTS[key]));
    }
  });

  it.each(readmes)('shows every option in the table of %s with the default the code holds', (_path, readme) => {
    const lines = readme.split('\n');
    for (const key of SETTING_KEYS) {
      const row = lines.find((line) => line.startsWith(`| \`${key}\` |`));
      expect(row, key).toBeDefined();
      // A GFM cell ends at every `|` not escaped as `\|`, inside code spans too.
      const cells = row!.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim());
      expect(cells, key).toHaveLength(3);
      const value = DEFAULTS[key];
      if (Array.isArray(value) && value.length === 0) {
        expect(cells[1], key).toBe('*(none)*');
        continue;
      }
      if (value === '') {
        expect(cells[1], key).toBe('*(empty)*');
        continue;
      }
      const shown = cells[1]!.split('<br>').map((entry) => entry.replace(/^`|`$/g, '').replace(/\\\|/g, '|'));
      expect(shown, key).toEqual(Array.isArray(value) ? value : [String(value)]);
    }
  });

  it('judge is false and judgeRaiseAt is 25 in the code, the manifest and both READMEs', () => {
    expect(DEFAULTS.judge).toBe(false);
    expect(DEFAULTS.judgeRaiseAt).toBe(25);
    expect(manifest.userConfig.judge.default).toBe(false);
    expect(manifest.userConfig.judgeRaiseAt).toMatchObject({ type: 'number', default: 25, min: 0, max: 100 });
    for (const [path, readme] of readmes) {
      const row = (key: string) => readme.split('\n').find((line) => line.startsWith(`| \`${key}\` |`));
      expect(row('judge'), path).toContain('| `false` |');
      expect(row('judgeRaiseAt'), path).toContain('| `25` |');
    }
  });

  it('tripwires: the default is fail1,fail2,red,redispatch in the code, the manifest and both READMEs', () => {
    expect(DEFAULTS.tripwires).toBe('fail1,fail2,red,redispatch');
    expect(manifest.userConfig.tripwires).toMatchObject({ type: 'string', default: 'fail1,fail2,red,redispatch' });
    expect(manifest.userConfig.tripwires.multiple).toBeUndefined();
    for (const [path, readme] of readmes) {
      const row = readme.split('\n').find((line) => line.startsWith('| `tripwires` |'));
      expect(row, path).toContain('| `fail1,fail2,red,redispatch` |');
      expect(readme, path).toContain('`effortControl.tripwires`');
    }
  });

  it('parentTag: the default is honor in the code, the manifest and both READMEs', () => {
    expect(DEFAULTS.parentTag).toBe('honor');
    expect(manifest.userConfig.parentTag).toMatchObject({ type: 'string', default: 'honor' });
    expect(manifest.userConfig.parentTag.multiple).toBeUndefined();
    expect(manifest.userConfig.parentTag.description).toContain('ignore');
    for (const [path, readme] of readmes) {
      const row = readme.split('\n').find((line) => line.startsWith('| `parentTag` |'));
      expect(row, path).toContain('| `honor` |');
      expect(row, path).toContain('`ignore`');
      expect(readme, path).toContain('`effortControl.parentTag`');
    }
  });

  it('readOnlyCommands: agrees across the code, the manifest and both READMEs', () => {
    expect(DEFAULTS.readOnlyCommands).toContain('grep');
    expect(DEFAULTS.readOnlyCommands).not.toContain('source');
    expect(manifest.userConfig.readOnlyCommands).toMatchObject({ type: 'string', multiple: true, default: DEFAULTS.readOnlyCommands });
    expect(manifest.userConfig.readOnlyCommands.title.startsWith('readOnlyCommands: ')).toBe(true);
    for (const [path, readme] of readmes) {
      const row = readme.split('\n').find((line) => line.startsWith('| `readOnlyCommands` |'));
      expect(row, path).toBeDefined();
      for (const name of DEFAULTS.readOnlyCommands) expect(row, `${path} ${name}`).toContain(`\`${name}\``);
    }
  });

  it('keeps the two READMEs\' option tables identical', () => {
    const table = (text: string) => text.split('\n').filter((line) => SETTING_KEYS.some((key) => line.startsWith(`| \`${key}\` |`)));
    expect(table(readmes[1]![1])).toEqual(table(readmes[0]![1]));
  });
});
