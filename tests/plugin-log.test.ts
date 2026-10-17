import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// An absent new writer must fail a behavioral assertion, not test collection.
const source = '../plugins/effort-live-control/src/plugin-log.ts';
const log = await import(source).catch(() => undefined);
const exec = promisify(execFile);
const dirs: string[] = [];
const plugin = 'effort-live-control';
const now = 1791991231123;
const fields = { plugin, level: 'error', event: 'answer-tool-failed', msg: 'Nothing changed', where: 'hooks/effort-live-control.ts#answerButton' };
const writer = () => log!;
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), 'plugin-log-')); dirs.push(dir); return dir; };
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const run = async (argv: readonly string[], identity?: { uid?: number; gid?: number; cwd?: string; env?: NodeJS.ProcessEnv }) => {
  try { const out = await exec('/bin/sh', argv.slice(1), { ...identity, encoding: 'utf8' }); return { exitCode: 0, ...out }; }
  catch (error: any) { return { exitCode: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error) }; }
};
const rows = async (dir: string, file: string) => (await readFile(join(dir, file), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

it('levelRow preserves exact contract order, optional session and the UTF-8 byte cap', () => {
  const { levelRow, ROW_MAX_BYTES } = writer();
  for (const extra of [{}, { session: 's1', detail: { error: 'unknown level' } }]) {
    const row = levelRow({ ...fields, ...extra }, now);
    expect(row).toBe(JSON.stringify({ ts: '2026-10-14T15:20:31.123Z', ...fields, ...extra }) + '\n');
    expect(Object.keys(JSON.parse(row))).toEqual(['ts', 'plugin', 'level', 'event', 'msg', 'where', ...('session' in extra ? ['session', 'detail'] : [])]);
  }
  for (const msg of ['x'.repeat(20000), '🙂'.repeat(6000), '\"\\\n'.repeat(6000)]) {
    const full = { ...fields, msg, session: 's1', detail: { error: 'x'.repeat(9000) } };
    const original = Buffer.byteLength(JSON.stringify({ ts: '2026-10-14T15:20:31.123Z', ...full }) + '\n');
    const row = levelRow(full, now);
    expect(Buffer.byteLength(row)).toBeLessThanOrEqual(ROW_MAX_BYTES);
    const parsed = JSON.parse(row);
    expect(parsed.detail).toEqual({ truncated: true, bytes: original });
    expect(msg.startsWith(parsed.msg)).toBe(true);
    expect(row.endsWith('\n')).toBe(true);
  }
});

it('pluginLogDir resolves the configured folder, HOME fallback and no destination', () => {
  const { pluginLogDir } = writer();
  for (const [env, home, expected] of [
    ['/x/logs', '/h/u', '/x/logs/auto-effort'],
    [undefined, '/h/u', '/h/u/.local/state/auto-effort/logs'],
    [undefined, undefined, undefined],
  ]) expect(pluginLogDir(env, home, 'auto-effort')).toBe(expected);
});

it('APPEND_SCRIPT appends exact rows to three private files, quoting paths and content', async () => {
  const { levelRow, appendArgv } = writer();
  const dir = join(await temp(), "logs with 'quotes;$(false)");
  const lines = ['error', 'warning', 'info'].map((level) => levelRow({ ...fields, level, msg: "literal 'quote;$(false)" }, now));
  for (const argv of appendArgv(dir, plugin, lines)) expect(await run(argv)).toMatchObject({ exitCode: 0 });
  for (const [i, file] of ['errors.jsonl', 'warnings.jsonl', 'info.jsonl'].entries()) {
    expect(await readFile(join(dir, file), 'utf8')).toBe(lines[i]);
    expect((await stat(join(dir, file))).mode & 0o777).toBe(0o600);
  }
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
});

it.each(['absolute', 'hyphen-relative'].flatMap((root) => ['new', 'existing', 'capped'].map((state) => ({ root, state }))))('APPEND_SCRIPT appends and caps rows with BSD chmod ($root, $state)', async ({ root, state }) => {
  const { pluginLogDir, levelRow, appendArgv } = writer();
  const cwd = await temp();
  const bin = join(cwd, 'bin');
  await mkdir(bin);
  const shim = join(bin, 'chmod');
  await writeFile(shim, `#!/bin/sh
set -eu
case "$1" in 600|700) ;; *) printf 'chmod: unsupported mode %s\\n' "$1" >&2; exit 1 ;; esac
mode=$1
shift
for path do
  case "$path" in -*) printf 'chmod: %s: No such file or directory\\n' "$path" >&2; exit 1 ;; esac
done
exec /bin/chmod "$mode" "$@"
`);
  await chmod(shim, 0o755);
  const configured = root === 'absolute' ? join(cwd, "logs with 'quotes;$(false)") : '-logs';
  const dir = pluginLogDir(configured, undefined, plugin)!;
  const target = root === 'absolute' ? dir : join(cwd, dir);
  const levels = [
    { level: 'error', file: 'errors.jsonl' },
    { level: 'warning', file: 'warnings.jsonl' },
    { level: 'info', file: 'info.jsonl' },
  ] as const;
  const seed = (level: string) => state === 'capped' && level !== 'info' ? level.charAt(0).repeat(20971521) : `seed ${level}\n`;
  if (state !== 'new') {
    await mkdir(target, { recursive: true });
    await chmod(target, 0o755);
    for (const { level, file } of levels) {
      await writeFile(join(target, file), seed(level));
      await writeFile(join(target, file + '.1'), `backup ${level}\n`);
      await chmod(join(target, file), 0o644);
      await chmod(join(target, file + '.1'), 0o644);
    }
  }
  const session = 'bsd-session';
  const lines = levels.map(({ level }) => levelRow({ ...fields, level, session }, now));
  for (const argv of appendArgv(dir, plugin, lines)) {
    const out = await run(argv, { cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` } });
    expect(out).toMatchObject({ exitCode: 0, stderr: '' });
  }
  if (state === 'new') expect((await stat(target)).mode & 0o777).toBe(0o700);
  for (const [i, { level, file }] of levels.entries()) {
    const path = join(target, file);
    const content = await readFile(path, 'utf8');
    if (state === 'capped' && level === 'warning') {
      expect(content.endsWith(lines[i])).toBe(true);
      const capLines = content.slice(0, -lines[i].length).trim().split('\n');
      expect(capLines).toHaveLength(2);
      for (const line of capLines) {
        expect(JSON.parse(line)).toEqual({
          ts: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/),
          plugin, level: 'warning', event: 'log-capped',
          msg: 'level file exceeded 20971520 bytes; moved to .1',
          where: 'src/plugin-log.ts#APPEND_SCRIPT', session,
        });
      }
    } else {
      const prefix = state === 'new' || (state === 'capped' && level === 'error') ? '' : seed(level);
      expect(content).toBe(prefix + lines[i]);
    }
    if (state === 'new') expect((await stat(path)).mode & 0o777).toBe(0o600);
    if (state !== 'new') {
      const backup = path + '.1';
      const expected = state === 'capped' && level !== 'info' ? seed(level) : `backup ${level}\n`;
      expect(await readFile(backup, 'utf8')).toBe(expected);
      expect((await stat(backup)).size).toBe(Buffer.byteLength(expected));
    }
  }
});

it('APPEND_SCRIPT moves a capped file aside and writes a contract log-capped warning', async () => {
  const { levelRow, appendArgv, PLUGIN_LOG_CAP_BYTES } = writer();
  const dir = await temp();
  await writeFile(join(dir, 'errors.jsonl'), 'x'.repeat(20971521));
  const row = levelRow(fields, now);
  expect(PLUGIN_LOG_CAP_BYTES).toBe(20971520);
  expect(await run(appendArgv(dir, plugin, [row])[0])).toMatchObject({ exitCode: 0 });
  expect((await stat(join(dir, 'errors.jsonl.1'))).size).toBe(20971521);
  expect(await readFile(join(dir, 'errors.jsonl'), 'utf8')).toBe(row);
  expect(await rows(dir, 'warnings.jsonl')).toEqual([expect.objectContaining({ plugin, level: 'warning', event: 'log-capped', where: 'src/plugin-log.ts#APPEND_SCRIPT' })]);
});

it.skipIf(process.getuid?.() === 0)('APPEND_SCRIPT unreadable destination reports path (skip-because:superuser)', async () => {
  const { levelRow, appendArgv } = writer();
  const dir = await temp();
  await chmod(dir, 0o500);
  try {
    const out = await run(appendArgv(dir, plugin, [levelRow(fields, now)])[0]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain(dir);
  } finally { await chmod(dir, 0o700); }
});

it('APPEND_SCRIPT rejects a file-as-directory with a visible path, even as root', async () => {
  const { levelRow, appendArgv } = writer();
  const dir = join(await temp(), 'not-a-directory');
  await writeFile(dir, 'occupied');
  const out = await run(appendArgv(dir, plugin, [levelRow(fields, now)])[0]);
  expect(out.exitCode).not.toBe(0);
  expect(out.stderr).toContain(dir);
});

it('appendArgv limits every real subprocess to 64 rows; independent writers keep all rows', async () => {
  const { levelRow, appendArgv } = writer();
  const dir = await temp();
  const lines = Array.from({ length: 130 }, (_, i) => levelRow({ ...fields, detail: { id: i } }, now));
  const argv = appendArgv(dir, plugin, lines);
  expect(argv.map((a: string[]) => (a.length - 6) / 2)).toEqual([64, 64, 2]);
  expect(argv[0].slice(0, 6)).toEqual(['/bin/sh', '-c', writer().APPEND_SCRIPT, 'plugin-log', dir, plugin]);
  await Promise.all(argv.map(async (a: string[]) => expect(await run(a)).toMatchObject({ exitCode: 0 })));
  const actual = await rows(dir, 'errors.jsonl');
  expect(actual.map((r) => r.detail.id).sort((a, b) => a - b)).toEqual(Array.from({ length: 130 }, (_, i) => i));
});

it('PluginLogQueue serializes flushes, reports dropped rows once and rearms after success', async () => {
  const { levelRow, PluginLogQueue } = writer();
  const dir = await temp();
  const queue = new PluginLogQueue(dir, plugin);
  let calls = 0;
  let active = 0;
  let maximum = 0;
  let broken = true;
  const runner = async (argv: readonly string[]) => {
    calls += 1; active += 1; maximum = Math.max(active, maximum);
    try { if (broken) throw new Error('runner unavailable'); return await run(argv); }
    finally { active -= 1; }
  };
  expect(await queue.flush(runner)).toEqual({ dropped: 0 });
  expect(calls).toBe(0);
  queue.add(levelRow(fields, now));
  const first = await queue.flush(runner);
  expect(first.dropped).toBe(1); expect(first.error).toContain('runner unavailable'); expect(first.error).toContain(dir);
  queue.add(levelRow(fields, now));
  expect(await queue.flush(runner)).toEqual({ dropped: 1 });
  broken = false;
  queue.add(levelRow(fields, now));
  await Promise.all([queue.flush(runner), queue.flush(runner)]);
  expect(maximum).toBe(1);
  expect(await rows(dir, 'errors.jsonl')).toHaveLength(1);
  broken = true; queue.add(levelRow(fields, now));
  expect((await queue.flush(runner)).error).toContain('runner unavailable');
  const off = new PluginLogQueue(undefined, plugin);
  off.add(levelRow(fields, now));
  expect((await off.flush(runner)).error).toContain('plugin log off: no PLUGIN_LOG_DIR and no HOME');
});

it('PluginLogQueue returns every unwritten warning and info message, including repeated failures and later batches', async () => {
  const { levelRow, PluginLogQueue } = writer();
  const queue = new PluginLogQueue('/logs', plugin);
  for (let i = 0; i < 65; i++) queue.add(levelRow({ ...fields, level: 'info', msg: `change ${i}` }, now));
  queue.add(levelRow({ ...fields, level: 'warning', msg: 'recoverable warning' }, now));
  queue.add(levelRow(fields, now));
  let calls = 0;
  const result = await queue.flush(async () => ({ exitCode: ++calls === 1 ? 0 : 1, stdout: '', stderr: 'write failed' }));
  expect(result.fallback).toEqual(['change 64', 'recoverable warning']);
  queue.add(levelRow({ ...fields, level: 'warning', msg: 'another warning' }, now));
  const repeated = await queue.flush(async () => { throw new Error('still broken'); });
  expect(repeated.error).toBeUndefined();
  expect(repeated.fallback).toEqual(['another warning']);
});

it.each([
  { session: 'sess1' },
  { session: 'quote"\\backslash\nline\t🙂 ,"detail":{"session":"fake"}' },
  { session: '' },
  { session: undefined },
])('preserves the known triggering session in cascading cap warnings: $session', async ({ session }) => {
  const { levelRow, appendArgv } = writer();
  const dir = await temp();
  await writeFile(join(dir, 'errors.jsonl'), 'x'.repeat(20971521));
  await writeFile(join(dir, 'warnings.jsonl'), 'x'.repeat(20971521));
  const line = levelRow({ ...fields, msg: 'fake ,"session":"body" and ,"detail":{}', session, detail: { session: 'fake detail session', nested: { session: 'nested fake' } } }, now);
  expect(await run(appendArgv(dir, plugin, [line])[0])).toMatchObject({ exitCode: 0 });
  const warnings = await rows(dir, 'warnings.jsonl');
  expect(warnings).toHaveLength(2);
  for (const warning of warnings) {
    expect(warning).toMatchObject({ level: 'warning', event: 'log-capped', plugin, where: 'src/plugin-log.ts#APPEND_SCRIPT' });
    expect(Object.hasOwn(warning, 'session')).toBe(session !== undefined);
    if (session !== undefined) expect(warning.session).toBe(session);
    expect(Buffer.byteLength(JSON.stringify(warning) + '\n')).toBeLessThanOrEqual(4096);
  }
  expect(await readFile(join(dir, 'errors.jsonl'), 'utf8')).toBe(line);
});
