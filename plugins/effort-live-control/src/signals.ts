// What a steered agent's tool results and its sub-agents' answers say about trouble.

/** The words that open a return line: red ones mean trouble, green ones mean it is over. */
export type ReturnWords = { red: readonly string[]; green: readonly string[] };

export type ReturnLine = { token: string; red: boolean; unit: string | undefined; line: string };

/** Where a return was read: a child's own final answer, or a result the steered agent read (Read, a cat). */
export type Channel = 'complete' | 'read';

export function isTestCommand(command: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(command));
}

/** The command of a foreground Bash call that is a test run; undefined for anything else. */
export function isTestRun(tool: string, input: Readonly<Record<string, unknown>>, patterns: readonly RegExp[]): string | undefined {
  if (tool !== 'Bash' || input.run_in_background === true) return undefined;
  const command = input.command;
  return typeof command === 'string' && isTestCommand(command, patterns) ? command : undefined;
}

/** Whether a test run failed: the tool reported an error, or its result matches a failure pattern. */
export function testOutcome(isError: boolean | undefined, text: string, failure: readonly RegExp[]): 'fail' | 'pass' {
  return isError === true || failure.some((pattern) => pattern.test(text)) ? 'fail' : 'pass';
}

const escape = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const UNIT = '[A-Za-z0-9_/@-](?:[A-Za-z0-9._/@-]*[A-Za-z0-9_/@-])?';

/** The two readings of a return line: `strict` takes the token and its unit, `lenient` only the token. */
function lineRegexes(words: readonly string[]): { strict: RegExp; lenient: RegExp } {
  const tokens = [...words].sort((a, b) => b.length - a.length).map(escape).join('|');
  // Strict: TOKEN, then an optional unit, then the line's end, punctuation or whitespace and a
  // symbol (`DONE probe-unit (handoff skipped)`); `DONE and dusted` is prose. Lenient: the token alone.
  return {
    strict: new RegExp(`^(${tokens})(?:\\s+(${UNIT}))?(?=\\s*$|[.:,;!?)\\]]|\\s+[^\\w\\s])`),
    lenient: new RegExp(`^(${tokens})(?![\\w-])`),
  };
}

const LEADING_LINES = 15;
const LINE_NUMBER = /^\s*\d+[\t→]/;

/**
 * The return line of a text, if it has one. A child's final answer (`complete`) is
 * searched in its first 15 lines; a result the steered agent read (`read`) counts only
 * by its first non-blank line, after a leading line-number prefix. Case-sensitive.
 * A read result must be `TOKEN` or `TOKEN unit`, ending the line or followed by
 * punctuation (`.:,;!?)]`) or whitespace and a symbol (`(`, `[`, a dash, a quote).
 * A final answer counts on its token alone, whatever follows; its unit is taken
 * only when that strict form matches, else it is undefined.
 */
export function returnLine(text: string, channel: Channel, words: ReturnWords): ReturnLine | undefined {
  const all = [...words.red, ...words.green];
  if (all.length === 0) return undefined;
  const { strict, lenient } = lineRegexes(all);
  const lines = text.split(/\r?\n/);
  const candidates = channel === 'complete' ? lines.slice(0, LEADING_LINES) : lines.filter((line) => line.trim() !== '').slice(0, 1);
  for (const raw of candidates) {
    const line = (channel === 'read' ? raw.replace(LINE_NUMBER, '') : raw).trim();
    const match = channel === 'complete' ? (strict.exec(line) ?? lenient.exec(line)) : strict.exec(line);
    if (!match) continue;
    const token = match[1] as string;
    return { token, red: words.red.includes(token), unit: match[2], line };
  }
  return undefined;
}
