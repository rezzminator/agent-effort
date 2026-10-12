import { describe, expect, it } from 'vitest';
import { Definitions, type AgentFs, type ControlDefaults } from '../plugins/effort-live-control/src/agents.ts';

const ALL = ['fail1', 'fail2', 'red', 'redispatch'] as const;
const DEFAULTS: ControlDefaults = { floor: 'medium', ceiling: 'xhigh', judge: true, tripwires: ALL, parentTag: 'honor', struggleDecay: 20 };

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
    expect(found).toMatchObject({ path: '/p/.claude/agents/builder.md', effort: 'xhigh', control: undefined, parentTag: 'honor', errors: [] });
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
    expect(await x.defs(['/a']).resolve('general-purpose')).toEqual({ path: undefined, effort: undefined, control: undefined, parentTag: 'honor', errors: [] });
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

describe('effortControl.tripwires', () => {
  const control = async (frontmatter: string) => {
    const x = standIn({ '/a/t.md': `---\nname: t\n${frontmatter}\n---\n` });
    return { found: await x.defs(['/a']).resolve('t'), logs: x.logs };
  };

  it('tripwires: the key reads a comma list for that agent', async () => {
    expect((await control('effortControl:\n  tripwires: fail2, red')).found.control?.tripwires).toEqual(['fail2', 'red']);
  });

  it('tripwires: an empty key arms none', async () => {
    expect((await control('effortControl:\n  tripwires:')).found.control?.tripwires).toEqual([]);
  });

  it('tripwires: an unknown name is logged with its key, the type and the default, and the default used', async () => {
    const { found, logs } = await control('effortControl:\n  tripwires: fail1, boom');
    expect(found.control?.tripwires).toEqual([...ALL]);
    expect(logs).toEqual(['effort-live-control: /a/t.md effortControl.tripwires for t is invalid ("boom" is not a tripwire (fail1, fail2, red, redispatch)); using fail1,fail2,red,redispatch']);
  });
});

describe('effortControl.struggleDecay', () => {
  const control = async (frontmatter: string) => {
    const x = standIn({ '/a/t.md': `---\nname: t\n${frontmatter}\n---\n` });
    return { found: await x.defs(['/a']).resolve('t'), logs: x.logs };
  };

  it('decay: frontmatter overrides the option, and 0 turns it off for that agent', async () => {
    expect((await control('effortControl:\n  struggleDecay: 5')).found.control?.struggleDecay).toBe(5);
    expect((await control('effortControl:\n  struggleDecay: 0')).found.control?.struggleDecay).toBe(0);
  });

  it('decay: an agent that does not set it takes the option', async () => {
    expect((await control('effortControl:\n  floor: low')).found.control?.struggleDecay).toBe(20);
    expect((await control('effortControl: on')).found.control?.struggleDecay).toBe(20);
  });

  it('decay: the key alone turns steering on', async () => {
    expect((await control('effortControl:\n  struggleDecay: 8')).found.control).toMatchObject({ struggleDecay: 8 });
  });

  it('decay: a bad value is reported by key and value and the default applies', async () => {
    for (const raw of ['-3', '2.5', 'soon', '']) {
      const { found, logs } = await control(`effortControl:\n  struggleDecay: ${raw}`);
      expect(found.control?.struggleDecay, raw).toBe(20);
      expect(logs, raw).toEqual([expect.stringContaining('/a/t.md effortControl.struggleDecay for t is invalid (')]);
      expect(logs[0], raw).toContain(`${JSON.stringify(raw)} is not a whole number of at least 0`);
      expect(logs[0], raw).toContain('; using 20');
    }
  });
});

describe('effortControl', () => {
  const control = async (frontmatter: string) => {
    const x = standIn({ '/a/t.md': `---\nname: t\n${frontmatter}\n---\n` });
    const found = await x.defs(['/a']).resolve('t');
    return { found, logs: x.logs };
  };

  it.each(['on', 'true', 'yes', 'ON', 'Yes'])('R-3: bare effortControl: %s switches steering on with the option defaults', async (word) => {
    expect((await control(`effortControl: ${word}`)).found.control).toEqual({ floor: 'medium', ceiling: 'xhigh', landing: [], judge: true, tripwires: [...ALL], struggleDecay: 20 });
  });

  it.each(['off', 'false', 'no', 'OFF'])('R-3: bare effortControl: %s leaves the agent unsteered', async (word) => {
    expect((await control(`effortControl: ${word}`)).found.control).toBeUndefined();
  });

  it('R-3: an absent key leaves the agent unsteered', async () => {
    expect((await control('effort: high')).found.control).toBeUndefined();
  });

  it('R-3: the nested form is on by default and reads floor, ceiling, landing and judge', async () => {
    const { found } = await control('effortControl:\n  floor: low\n  ceiling: max\n  landing: lander, reviewer  tester\n  judge: off');
    expect(found.control).toEqual({ floor: 'low', ceiling: 'max', landing: ['lander', 'reviewer', 'tester'], judge: false, tripwires: [...ALL], struggleDecay: 20 });
  });

  it('R-3: nested enabled: off turns steering off whatever else is set', async () => {
    expect((await control('effortControl:\n  enabled: off\n  floor: low')).found.control).toBeUndefined();
    expect((await control('effortControl:\n  enabled: on')).found.control).toMatchObject({ floor: 'medium' });
  });

  it('R-3: an invalid value is logged with its key, the type and the default, and the default used', async () => {
    const { found, logs } = await control('effortControl:\n  floor: sideways\n  ceiling: max');
    expect(found.control).toEqual({ floor: 'medium', ceiling: 'max', landing: [], judge: true, tripwires: [...ALL], struggleDecay: 20 });
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
    const defs = new Definitions(['/a'], { floor: 'low', ceiling: 'high', judge: false, tripwires: ['red'], parentTag: 'honor', struggleDecay: 7 }, { exists: async () => true, read: async () => files['/a/t.md'], listMarkdown: async () => [] }, () => {});
    expect((await defs.resolve('t')).control).toEqual({ floor: 'low', ceiling: 'high', landing: [], judge: false, tripwires: ['red'], struggleDecay: 7 });
    expect(x.logs).toEqual([]);
  });
});

describe('effortControl.parentTag', () => {
  const read = async (frontmatter: string, defaults: ControlDefaults = DEFAULTS) => {
    const x = standIn({ '/a/t.md': `---\nname: t\n${frontmatter}\n---\n` });
    const defs = new Definitions(['/a'], defaults, { exists: async () => true, read: async () => `---\nname: t\n${frontmatter}\n---\n`, listMarkdown: async () => [] }, (line) => x.logs.push(line));
    return { found: await defs.resolve('t'), logs: x.logs };
  };

  it('parentTag: a definition takes the option when its frontmatter names none', async () => {
    expect((await read('effort: high')).found.parentTag).toBe('honor');
    expect((await read('effort: high', { ...DEFAULTS, parentTag: 'ignore' })).found.parentTag).toBe('ignore');
    expect((await standIn({}).defs(['/a']).resolve('absent')).parentTag).toBe('honor');
  });

  it('parentTag: the frontmatter key overrides the option, case-insensitively, with steering on or off', async () => {
    expect((await read('effort: high\neffortControl:\n  floor: low\n  parentTag: Ignore')).found).toMatchObject({ parentTag: 'ignore', control: { floor: 'low' } });
    expect((await read('effort: high\neffortControl:\n  parentTag: honor', { ...DEFAULTS, parentTag: 'ignore' })).found.parentTag).toBe('honor');
    const off = (await read('effort: high\neffortControl:\n  enabled: off\n  parentTag: ignore')).found;
    expect(off).toMatchObject({ parentTag: 'ignore', effort: 'high', control: undefined });
  });

  it('parentTag: the key alone pins a type without steering it', async () => {
    expect((await read('effort: high\neffortControl:\n  parentTag: ignore')).found).toMatchObject({ parentTag: 'ignore', control: undefined });
    expect((await read('effort: high\neffortControl:\n  parentTag: ignore\n  judge: on')).found.control).toMatchObject({ judge: true });
  });

  it('parentTag: an unknown value is logged with its key and the type and the option applies', async () => {
    const { found, logs } = await read('effort: high\neffortControl:\n  enabled: off\n  parentTag: sometimes', { ...DEFAULTS, parentTag: 'ignore' });
    expect(found.parentTag).toBe('ignore');
    const line = 'effort-live-control: /a/t.md effortControl.parentTag for t is invalid (not honor or ignore); using ignore';
    expect(logs).toEqual([line]);
    expect(found.errors).toEqual([line]);
  });
});
