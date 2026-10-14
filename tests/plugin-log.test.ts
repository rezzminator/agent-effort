import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, chown, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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

it.each(['absolute', 'hyphen-relative'].flatMap((root) => ['new', 'existing', 'capped'].map((state) => ({ root, state }))))('APPEND_SCRIPT writes private rows with BSD chmod ($root, $state)', async ({ root, state }) => {
  const { pluginLogDir, levelRow, appendArgv } = writer();
  const cwd = await temp();
  const bin = join(cwd, 'bin');
  const calls = join(cwd, 'chmod-calls');
  await mkdir(bin);
  const shim = join(bin, 'chmod');
  await writeFile(shim, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$CHMOD_CALLS"
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
    const out = await run(argv, { cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, CHMOD_CALLS: calls } });
    expect(out).toMatchObject({ exitCode: 0, stderr: '' });
  }
  expect((await readFile(calls, 'utf8')).split('\n')[0]).toBe(`700 ${root === 'absolute' ? dir : './' + dir}`);
  expect((await stat(target)).mode & 0o777).toBe(0o700);
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
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    if (state !== 'new') {
      const backup = path + '.1';
      const expected = state === 'capped' && level !== 'info' ? seed(level) : `backup ${level}\n`;
      expect(await readFile(backup, 'utf8')).toBe(expected);
      expect((await stat(backup)).size).toBe(Buffer.byteLength(expected));
      expect((await stat(backup)).mode & 0o777).toBe(0o600);
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

it.each(['error', 'warning', 'info'].flatMap((level) => [false, true].map((cap) => ({ level, cap }))))('secures existing $level objects (cap=$cap) without changing parent or legacy objects', async ({ level, cap }) => {
  const { levelRow, appendArgv } = writer();
  const parent = await temp();
  const dir = join(parent, 'levels');
  const legacy = join(parent, 'legacy');
  await mkdir(dir); await mkdir(legacy);
  await chmod(parent, 0o755); await chmod(dir, 0o755); await chmod(legacy, 0o755);
  const file = { error: 'errors.jsonl', warning: 'warnings.jsonl', info: 'info.jsonl' }[level]!;
  await writeFile(join(dir, file), cap ? 'x'.repeat(20971521) : 'seed\n');
  await chmod(join(dir, file), 0o644);
  await writeFile(join(dir, file + '.1'), 'backup unchanged'); await chmod(join(dir, file + '.1'), 0o644);
  await writeFile(join(legacy, 'decisions.jsonl'), 'legacy unchanged'); await chmod(join(legacy, 'decisions.jsonl'), 0o644);
  const line = levelRow({ ...fields, level }, now);
  expect(await run(appendArgv(dir, plugin, [line])[0])).toMatchObject({ exitCode: 0 });
  const mode = async (path: string) => (await stat(path)).mode & 0o777;
  expect({ dir: await mode(dir), file: await mode(join(dir, file)), archive: await mode(join(dir, file + '.1')), parent: await mode(parent), legacyDir: await mode(legacy), legacyFile: await mode(join(legacy, 'decisions.jsonl')) }).toEqual({ dir: 0o700, file: 0o600, archive: 0o600, parent: 0o755, legacyDir: 0o755, legacyFile: 0o644 });
  expect(await readFile(join(dir, file + '.1'), 'utf8')).toBe(cap ? 'x'.repeat(20971521) : 'backup unchanged');
  expect(await readFile(join(legacy, 'decisions.jsonl'), 'utf8')).toBe('legacy unchanged');
  expect((await readFile(join(dir, file), 'utf8')).endsWith(line)).toBe(true);
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

it.each(['directory', 'file', 'backup'])('refuses an owned $type symlink without changing a legacy target', async (kind) => {
  const { levelRow, appendArgv } = writer();
  const parent = await temp();
  const legacy = join(parent, 'legacy');
  const dir = join(parent, 'levels');
  await mkdir(legacy); await chmod(legacy, 0o755);
  const legacyFile = join(legacy, 'errors.jsonl');
  await writeFile(legacyFile, 'legacy unchanged'); await chmod(legacyFile, 0o644);
  if (kind === 'directory') await symlink(legacy, dir);
  else { await mkdir(dir); await symlink(legacyFile, join(dir, kind === 'backup' ? 'errors.jsonl.1' : 'errors.jsonl')); }
  const out = await run(appendArgv(dir, plugin, [levelRow(fields, now)])[0]);
  expect(out.exitCode).not.toBe(0); expect(out.stderr).toContain(dir);
  expect(await readFile(legacyFile, 'utf8')).toBe('legacy unchanged');
  expect((await stat(legacy)).mode & 0o777).toBe(0o755);
  expect((await stat(legacyFile)).mode & 0o777).toBe(0o644);
});

it.skipIf(process.getuid?.() !== 0 || process.platform !== 'linux').each(['directory', 'file', 'backup'])('chmod EPERM on a foreign $type gives one streak fallback and leaves it unchanged (needs root-created fixture)', async (kind) => {
  const { levelRow, PluginLogQueue } = writer();
  const parent = await temp(); await chmod(parent, 0o755);
  const dir = join(parent, 'levels'); await mkdir(dir);
  if (kind === 'directory') await chmod(dir, 0o777);
  else { await chown(dir, 65534, 65534); await chmod(dir, 0o700); }
  const file = join(dir, 'errors.jsonl');
  await writeFile(file, 'seed\n'); await chmod(file, kind === 'backup' ? 0o600 : 0o666);
  if (kind === 'backup') {
    await chown(file, 65534, 65534);
    await writeFile(file + '.1', 'backup unchanged'); await chmod(file + '.1', 0o666);
  }
  const queue = new PluginLogQueue(dir, plugin);
  const runner = (argv: readonly string[]) => run(argv, { uid: 65534, gid: 65534 });
  queue.add(levelRow(fields, now));
  expect(await queue.flush(runner)).toEqual({ dropped: 1, error: expect.stringContaining(dir) });
  queue.add(levelRow(fields, now));
  expect(await queue.flush(runner)).toEqual({ dropped: 1 });
  expect(await readFile(file, 'utf8')).toBe('seed\n');
  expect((await stat(file)).mode & 0o777).toBe(kind === 'backup' ? 0o600 : 0o666);
  if (kind === 'backup') {
    expect(await readFile(file + '.1', 'utf8')).toBe('backup unchanged');
    expect((await stat(file + '.1')).mode & 0o777).toBe(0o666);
  }
  expect((await stat(dir)).mode & 0o777).toBe(kind === 'directory' ? 0o777 : 0o700);
});

it.skipIf(process.getuid?.() === 0)('APPEND_SCRIPT refuses an intentionally unwritable backup without reviving owner write (skip-because:superuser)', async () => {
  const { levelRow, appendArgv } = writer();
  const dir = await temp();
  const file = join(dir, 'errors.jsonl');
  const backup = file + '.1';
  await writeFile(file, 'seed\n'); await chmod(file, 0o600);
  await writeFile(backup, 'backup unchanged'); await chmod(backup, 0o400);
  try {
    const out = await run(appendArgv(dir, plugin, [levelRow(fields, now)])[0]);
    expect(out.exitCode).not.toBe(0); expect(out.stderr).toContain(backup);
    expect((await stat(backup)).mode & 0o777).toBe(0o400);
    expect(await readFile(backup, 'utf8')).toBe('backup unchanged');
    expect(await readFile(file, 'utf8')).toBe('seed\n');
  } finally { await chmod(backup, 0o600); }
});
