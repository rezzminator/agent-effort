/** Standalone, append-only plugin logs. Host I/O is supplied by the adapter. */
export const PLUGIN_LOG_CAP_BYTES = 20971520;
export const ROW_MAX_BYTES = 4096;
export type Level = 'error' | 'warning' | 'info';
type RowFields = { plugin: string; level: Level; event: string; msg: string; where: string; session?: string; detail?: Record<string, unknown> };
type Run = (argv: readonly string[], init: { timeoutMs: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
export type FlushResult = { dropped: number; error?: string };

export function pluginLogDir(configured: string | undefined, home: string | undefined, plugin: string): string | undefined {
  const base = configured || (home ? `${home.replace(/\/$/, '')}/.local/state/${plugin}/logs` : undefined);
  return configured ? `${configured.replace(/\/$/, '')}/${plugin}` : base;
}

function bytes(text: string): number {
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    count += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return count;
}

/** The adapter supplies only identifiers, counts, paths and error text, never bodies. */
export function levelRow(fields: RowFields, nowMs: number): string {
  const { plugin, level, event, msg, where, session, detail } = fields;
  const row = { ts: new Date(nowMs).toISOString(), plugin, level, event, msg, where, ...(session === undefined ? {} : { session }), ...(detail === undefined ? {} : { detail }) };
  let line = JSON.stringify(row) + '\n';
  const original = bytes(line);
  if (original <= ROW_MAX_BYTES) return line;
  const capped = { ...row, detail: { truncated: true, bytes: original } };
  // Bound metadata too: a hostile session id must not defeat the row limit.
  capped.plugin = capped.plugin.slice(0, 128);
  capped.event = capped.event.slice(0, 128);
  capped.where = capped.where.slice(0, 128);
  if (capped.session !== undefined) capped.session = capped.session.slice(0, 128);
  const chars = Array.from(msg);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    capped.msg = chars.slice(0, mid).join('');
    if (bytes(JSON.stringify(capped) + '\n') <= ROW_MAX_BYTES) low = mid;
    else high = mid - 1;
  }
  capped.msg = chars.slice(0, low).join('');
  return JSON.stringify(capped) + '\n';
}

// Every row is a quoted positional argument, not interpolated shell source.
// Rename races at the cap are intentionally unlocked; open-append-close keeps
// ordinary writers from replacing or reading back one another's rows.
export const APPEND_SCRIPT = `set -eu
umask 077
dir=$1
case "$dir" in -*) dir=./$dir ;; esac
plugin=$2
shift 2
mkdir -p "$dir" || { printf 'plugin log %s: mkdir failed\\n' "$dir" >&2; exit 1; }
append_line() {
  file=$1
  row=$2
  path=$dir/$file
  if [ -f "$path" ]; then
    size=$(wc -c < "$path") || { printf 'plugin log %s: size unreadable\\n' "$path" >&2; exit 1; }
    if [ "$size" -gt 20971520 ]; then
      mv -f "$path" "$path.1" || { printf 'plugin log %s: cap rename failed\\n' "$path" >&2; exit 1; }
      stamp=$(date -u +%Y-%m-%dT%H:%M:%S.000Z) || { printf 'plugin log %s: timestamp failed\\n' "$path" >&2; exit 1; }
      # Fixed-order levelRow scalars escape all embedded quotes. Only the
      # top-level structural delimiters below contain unescaped quotes.
      scalar=\${row%'
'}
      scalar=\${scalar%'}'}
      scalar=\${scalar%%,\\\"detail\\\":*}
      session=
      case "$scalar" in
        *,\\\"session\\\":*) session=,\\\"session\\\":\${scalar##*,\\\"session\\\":} ;;
      esac
      warning=$(printf '{"ts":"%s","plugin":"%s","level":"warning","event":"log-capped","msg":"level file exceeded 20971520 bytes; moved to .1","where":"src/plugin-log.ts#APPEND_SCRIPT"%s}\\n' "$stamp" "$plugin" "$session")
      # Recursive calls have their own positional parameters; rebind below.
      append_line warnings.jsonl "$warning
"
    fi
  fi
  printf '%s' "$2" >> "$dir/$1" || { printf 'plugin log %s/%s: append failed\\n' "$dir" "$1" >&2; exit 1; }
}
while [ "$#" -gt 0 ]; do
  case "$1" in errors.jsonl|warnings.jsonl|info.jsonl) ;; *) printf 'plugin log %s: invalid level file\\n' "$dir" >&2; exit 1 ;; esac
  append_line "$1" "$2"
  shift 2
done`;

export function appendArgv(dir: string, plugin: string, rows: readonly string[]): string[][] {
  const commands: string[][] = [];
  for (let at = 0; at < rows.length; at += 64) {
    const argv = ['/bin/sh', '-c', APPEND_SCRIPT, 'plugin-log', dir, plugin];
    for (const row of rows.slice(at, at + 64)) {
      const level = JSON.parse(row).level as Level;
      const file = { error: 'errors.jsonl', warning: 'warnings.jsonl', info: 'info.jsonl' }[level];
      if (!file) throw new Error(`invalid plugin log level: ${String(level)}`);
      argv.push(file, row);
    }
    commands.push(argv);
  }
  return commands;
}

/** One serialization chain and one fallback notice per failing streak. */
export class PluginLogQueue {
  private readonly rows: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  private failing = false;

  constructor(private readonly dir: string | undefined, private readonly plugin: string) {}

  add(row: string): void { this.rows.push(row); }

  flush(run: Run): Promise<FlushResult> {
    const result = this.chain.then(async (): Promise<FlushResult> => {
      const rows = this.rows.splice(0);
      if (rows.length === 0) return { dropped: 0 };
      let written = 0;
      try {
        if (!this.dir) throw new Error('plugin log off: no PLUGIN_LOG_DIR and no HOME');
        for (const argv of appendArgv(this.dir, this.plugin, rows)) {
          const out = await run(argv, { timeoutMs: 5000 });
          if (out.exitCode !== 0) throw new Error(out.stderr.split('\n')[0] || `append exited ${out.exitCode}`);
          written += (argv.length - 6) / 2;
          this.failing = false;
        }
        return { dropped: 0 };
      } catch (error) {
        const dropped = rows.length - written;
        const cause = error instanceof Error ? error.message : String(error);
        const notice = this.dir ? `plugin log ${this.dir}: ${cause}; dropped ${dropped} rows` : cause;
        const first = !this.failing;
        this.failing = true;
        return { dropped, ...(first ? { error: notice } : {}) };
      }
    });
    this.chain = result.then(() => undefined);
    return result;
  }
}
