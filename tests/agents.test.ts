import { describe, expect, it } from 'vitest';
import { Definitions, type AgentFs, type ControlDefaults } from '../plugins/effort-live-control/src/agents.ts';

const DEFAULTS: ControlDefaults = { floor: 'medium', ceiling: 'xhigh', judge: true };

// A stand-in file system: a map of path → text; a path listed in `broken` fails to read.
function standIn(files: Record<string, string>, broken: string[] = []) {
  const logs: string[] = [];
  const reads: string[] = [];
  const fs: AgentFs = {
    exists: async (path) => path in files || Object.keys(files).some((file) => file.startsWith(path.replace(/\/$/, '') + '/')),
    read: async (path) => {
      reads.push(path);
      if (broken.includes(path)) throw new Error('EACCES');
      const text = files[path];
      if (text === undefined) throw new Error('ENOENT');
      return text;
    },
    listMarkdown: async (dir) => Object.keys(files).filter((file) => file.startsWith(dir + '/') && file.endsWith('.md')).map((file) => file.slice(dir.length + 1)),
  };
  const defs = (dirs: string[]) => new Definitions(dirs, DEFAULTS, fs, (line) => logs.push(line));
  return { defs, logs, reads };
}

describe('Definitions.resolve', () => {
  it('finds <dir>/<type>.md and reads its effort, case-insensitively', async () => {
    const x = standIn({ '/p/.claude/agents/builder.md': '---\nname: builder\neffort: XHigh\n---\nBody' });
    const found = await x.defs(['/p/.claude/agents']).resolve('builder');
    expect(found).toMatchObject({ path: '/p/.claude/agents/builder.md', effort: 'xhigh', control: undefined, errors: [] });
  });

  it('takes the first directory that holds the type, in order', async () => {
    const x = standIn({ '/a/t.md': '---\neffort: low\n---\n', '/b/t.md': '---\neffort: max\n---\n' });
    expect((await x.defs(['/a', '/b']).resolve('t')).effort).toBe('low');
  });

  it('finds a file whose name: is the type when no <type>.md exists', async () => {
    const x = standIn({ '/a/other-file.md': '---\nname: reviewer\neffort: high\n---\n' });
    expect(await x.defs(['/a']).resolve('reviewer')).toMatchObject({ path: '/a/other-file.md', effort: 'high' });
  });

  it('skips a <type>.md whose name: is another type', async () => {
    const x = standIn({ '/a/t.md': '---\nname: someone-else\neffort: low\n---\n' });
    expect(await x.defs(['/a']).resolve('t')).toMatchObject({ path: undefined, effort: undefined, control: undefined });
  });

  it('reports no definition for an unknown type, with no errors', async () => {
    const x = standIn({});
    expect(await x.defs(['/a']).resolve('general-purpose')).toEqual({ path: undefined, effort: undefined, control: undefined, errors: [] });
  });

  it('reads a numeric or unknown effort as no effort level', async () => {
    const x = standIn({ '/a/t.md': '---\neffort: 5\n---\n', '/a/u.md': '---\neffort: turbo\n---\n' });
    expect((await x.defs(['/a']).resolve('t')).effort).toBeUndefined();
    expect((await x.defs(['/a']).resolve('u')).effort).toBeUndefined();
  });

  it('R-15: a definition that cannot be read is treated as no definition and logged with its context', async () => {
    const x = standIn({ '/a/t.md': '---\neffort: low\n---\n' }, ['/a/t.md']);
    const found = await x.defs(['/a']).resolve('t');
    expect(found).toMatchObject({ path: undefined, effort: undefined, control: undefined });
    expect(x.logs.join('\n')).toContain('effort-live-control: reading /a/t.md failed: EACCES; treating t as having no definition');
  });

  it('caches per type: the file is read once', async () => {
    const x = standIn({ '/a/t.md': '---\neffort: low\n---\n' });
    const defs = x.defs(['/a']);
    await defs.resolve('t');
    await defs.resolve('t');
    expect(x.reads).toEqual(['/a/t.md']);
  });
});

describe('effortControl', () => {
  const control = async (frontmatter: string) => {
    const x = standIn({ '/a/t.md': `---\nname: t\n${frontmatter}\n---\n` });
    const found = await x.defs(['/a']).resolve('t');
    return { found, logs: x.logs };
  };

  it.each(['on', 'true', 'yes', 'ON', 'Yes'])('R-3: bare effortControl: %s switches steering on with the option defaults', async (word) => {
    expect((await control(`effortControl: ${word}`)).found.control).toEqual({ floor: 'medium', ceiling: 'xhigh', landing: [], judge: true });
  });

  it.each(['off', 'false', 'no', 'OFF'])('R-3: bare effortControl: %s leaves the agent unsteered', async (word) => {
    expect((await control(`effortControl: ${word}`)).found.control).toBeUndefined();
  });

  it('R-3: an absent key leaves the agent unsteered', async () => {
    expect((await control('effort: high')).found.control).toBeUndefined();
  });

  it('R-3: the nested form is on by default and reads floor, ceiling, landing and judge', async () => {
    const { found } = await control('effortControl:\n  floor: low\n  ceiling: max\n  landing: lander, reviewer  tester\n  judge: off');
    expect(found.control).toEqual({ floor: 'low', ceiling: 'max', landing: ['lander', 'reviewer', 'tester'], judge: false });
  });

  it('R-3: nested enabled: off turns steering off whatever else is set', async () => {
    expect((await control('effortControl:\n  enabled: off\n  floor: low')).found.control).toBeUndefined();
    expect((await control('effortControl:\n  enabled: on')).found.control).toMatchObject({ floor: 'medium' });
  });

  it('R-3: an invalid value is logged with its key, the type and the default, and the default used', async () => {
    const { found, logs } = await control('effortControl:\n  floor: sideways\n  ceiling: max');
    expect(found.control).toEqual({ floor: 'medium', ceiling: 'max', landing: [], judge: true });
    const line = 'effort-live-control: /a/t.md effortControl.floor for t is invalid (not a level: low, medium, high, xhigh, max); using medium';
    expect(logs).toEqual([line]);
    expect(found.errors).toEqual([line]);
  });

  it('R-3: an invalid bare value is logged and leaves the agent unsteered', async () => {
    const { found, logs } = await control('effortControl: maybe');
    expect(found.control).toBeUndefined();
    expect(logs).toEqual(['effort-live-control: /a/t.md effortControl for t is invalid (not on, off, true, false, yes or no); using off']);
  });

  it('R-3: a floor above the ceiling is invalid and both fall back to the option defaults', async () => {
    const { found, logs } = await control('effortControl:\n  floor: max\n  ceiling: low');
    expect(found.control).toMatchObject({ floor: 'medium', ceiling: 'xhigh' });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('effortControl.floor for t is invalid');
  });

  it('R-3: the option defaults come from the settings, not constants', async () => {
    const files = { '/a/t.md': '---\nname: t\neffortControl: on\n---\n' };
    const x = standIn(files);
    const defs = new Definitions(['/a'], { floor: 'low', ceiling: 'high', judge: false }, { exists: async () => true, read: async () => files['/a/t.md'], listMarkdown: async () => [] }, () => {});
    expect((await defs.resolve('t')).control).toEqual({ floor: 'low', ceiling: 'high', landing: [], judge: false });
    expect(x.logs).toEqual([]);
  });
});
