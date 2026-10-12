// The decision log: one JSONL file per session, appended to on every write.
// Chats share the configured logFile option, so each session writes its own
// file beside it; a resumed session appends to the rows it wrote before.

/** The session's own log path: the session id goes before the extension of `logFile`. */
export function sessionLogPath(logFile: string, sessionId: string): string {
  if (sessionId === '') throw new Error('effort-live-control: empty session id; cannot name the log file');
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  const slash = logFile.lastIndexOf('/');
  const dir = logFile.slice(0, slash + 1);
  const name = logFile.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${dir}${name}.${safe}`;
  return `${dir}${name.slice(0, dot)}.${safe}${name.slice(dot)}`;
}

/** The file's rows followed by `rows`, blank lines dropped, the newest `cap` kept. */
export function appendRows(existing: string, rows: string[], cap: number): string {
  const all = [...existing.split('\n').filter((line) => line.trim() !== ''), ...rows];
  return all.slice(-cap).join('\n') + '\n';
}
