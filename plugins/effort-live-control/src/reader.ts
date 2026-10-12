// The prompt reader: a cheap model reads the user's new message, the end of the main chat's previous reply and
// precedents from the owner's own history, and estimates how hard the next reply must think. Pure: the prompt,
// the casebook, the answer's parser and the decision; the hooks file makes the call and reads the file.

export const READER_LEVELS = ['medium', 'high', 'xhigh'] as const;
export type ReaderLevel = (typeof READER_LEVELS)[number];

/** One past turn: what the user said, what the agent had said, and the effort it turned out to need. */
export type CaseRow = { message: string; previous: string; level: ReaderLevel; note: string; core: boolean };

/** The decision's constants, as measured on the owner's labelled prompts. */
export const SHARPEN_T = 0.3;
export const UNDER_COST = 3;
export const OVER_COST = 1;

export const CORE_MAX = 40;
export const PRECEDENTS_MAX = 6;
export const MESSAGE_MAX = 400;
export const PREVIOUS_MAX = 200;
const CASE_PREVIOUS_MAX = 120;
const CASE_MESSAGE_MAX = 260;

/** The previous reply's text at the first message of a session. */
export const NO_PREVIOUS = '(none: first message)';

const INSTRUCTIONS = `You choose how hard a coding agent should think before its next reply.

Below is the case to judge: the end of the agent's previous reply, the user's new message, and the past turns whose message reads most alike. A casebook of past turns from this user's work, each marked with the effort it needed and what it turned out to be, comes first when there is one.

The three effort levels:
- medium: the reply is routine — run or check something, operate git or tools, make an edit the user dictated, report status or recall, answer a greeting, coordinate other agents, explain something already known.
- high: the reply must work something out — diagnose a failure, build or fix something whose shape the agent designs, measure, research, review work.
- xhigh: the reply must decide how a system should be shaped — architecture, options and trade-offs, a design or a proposal.

For each case, estimate the probability of each level. Judge first what the user's message asks the agent to do next, then check it against the casebook and the precedents that match it. A short reply ("go", "yes", "Amen", a number, a pasted error) takes its meaning from the agent's previous reply: approving a plan to build means the build comes next; a pasted error means a diagnosis comes next. Give honest probabilities; the caller handles the cost of being wrong in either direction.
`;

const OUTPUT_LINE = 'Answer with one line only: three probabilities for medium, high and xhigh, separated by spaces, three decimals each, summing to 1. No other text.';

const rankOf = (level: ReaderLevel): number => READER_LEVELS.indexOf(level);

/** `text` as is when it fits `max`, else its head and an ellipsis (the lab's cut()). */
const cut = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max - 1) + '…');

// ---- the casebook: which rows are shown ----

const tokens = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Sublinear term frequency times IDF, over the pool's vocabulary, scaled to unit length. */
function vector(words: readonly string[], idf: ReadonlyMap<string, number>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of words) if (idf.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
  const weights = new Map<string, number>();
  let norm = 0;
  for (const [word, count] of counts) {
    const weight = (1 + Math.log(count)) * (idf.get(word) as number);
    weights.set(word, weight);
    norm += weight * weight;
  }
  if (norm === 0) return weights;
  const length = Math.sqrt(norm);
  for (const [word, weight] of weights) weights.set(word, weight / length);
  return weights;
}

/** The pool rows nearest to `message` by TF-IDF cosine (IDF over the pool), most similar first; a row sharing no word is no precedent. */
function nearest(message: string, pool: readonly CaseRow[], max: number): CaseRow[] {
  const documents = pool.map((candidate) => tokens(candidate.message));
  const frequency = new Map<string, number>();
  for (const words of documents) for (const word of new Set(words)) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const idf = new Map<string, number>();
  for (const [word, count] of frequency) idf.set(word, Math.log((documents.length + 1) / (count + 1)) + 1);
  const query = vector(tokens(message), idf);
  const scored = pool.map((candidate, index) => {
    let similarity = 0;
    for (const [word, weight] of vector(documents[index] as string[], idf)) similarity += weight * (query.get(word) ?? 0);
    return { candidate, index, similarity };
  });
  return scored
    .filter((entry) => entry.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity || a.index - b.index)
    .slice(0, max)
    .map((entry) => entry.candidate);
}

export type Reader = { prompt: string; core: CaseRow[]; precedents: CaseRow[] };

function renderCase(item: CaseRow): string {
  return `effort ${item.level} — it turned out to be: ${item.note}\n   previous reply (end): ${cut(item.previous, CASE_PREVIOUS_MAX)}\n   user: ${cut(item.message, CASE_MESSAGE_MAX)}\n`;
}

/**
 * The reader's whole prompt, and the rows it shows. The message is cut to its first 400 characters, the previous
 * reply to its last 200. Core rows (at most 40, file order, then by level) open it; the 6 pool rows nearest to the
 * message follow the case, the message's own twin skipped.
 */
export function buildReader(message: string, previous: string, casebook: readonly CaseRow[]): Reader {
  const asked = message.slice(0, MESSAGE_MAX);
  const reply = previous.slice(-PREVIOUS_MAX);
  const core = casebook.filter((item) => item.core).slice(0, CORE_MAX).sort((a, b) => rankOf(a.level) - rankOf(b.level));
  const pool = casebook.filter((item) => !item.core && item.message.trim() !== message.trim());
  const precedents = nearest(message, pool, PRECEDENTS_MAX);
  const out: string[] = [INSTRUCTIONS];
  if (core.length > 0) {
    out.push("# Casebook: past turns of this user's work and the effort each one needed\n");
    core.forEach((item, n) => out.push(`C${n + 1}. ` + renderCase(item)));
    out.push('');
  }
  out.push('# The case to judge\n');
  out.push(`Agent's previous reply (end): ${reply}\n\nUser's new message: ${asked}\n`);
  if (precedents.length > 0) {
    out.push('Nearest precedents (past turns whose message reads alike, most similar first):\n');
    precedents.forEach((item, n) => out.push(`${n + 1}. ` + renderCase(item)));
    out.push('');
  }
  out.push(OUTPUT_LINE);
  return { prompt: out.join('\n'), core, precedents };
}

/** The reader's prompt for one case (see `buildReader` for the rows it shows). */
export const buildReaderPrompt = (message: string, previous: string, casebook: readonly CaseRow[]): string => buildReader(message, previous, casebook).prompt;

// ---- the answer and the decision ----

export type Probabilities = [number, number, number];

/** The first three numbers of the answer, each clipped to 0 or more and renormalised; undefined when fewer than three or none is positive. */
export function parseReaderAnswer(text: string): Probabilities | undefined {
  const found = text.match(/-?(?:\d+\.?\d*|\.\d+)/g);
  if (found === null || found.length < 3) return undefined;
  const clipped = found.slice(0, 3).map((raw) => Math.max(0, Number(raw)));
  const sum = clipped.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum) || sum <= 0) return undefined;
  return clipped.map((x) => x / sum) as Probabilities;
}

/** Under-effort costs UNDER_COST per level, over-effort OVER_COST. */
const loss = (decided: number, needed: number): number => UNDER_COST * Math.max(0, needed - decided) + OVER_COST * Math.max(0, decided - needed);

/** The level index of least expected loss under `p`; a tie goes to the lower level. */
export function bayes(p: readonly number[]): number {
  let best = 0;
  let bestLoss = Number.POSITIVE_INFINITY;
  for (let d = 0; d < READER_LEVELS.length; d += 1) {
    const expected = p.reduce((sum, x, needed) => sum + x * loss(d, needed), 0);
    if (expected < bestLoss) {
      bestLoss = expected;
      best = d;
    }
  }
  return best;
}

/** `p` raised to 1/T and normalised: the reader's probabilities are too soft to act on as they come. */
export function sharpen(p: readonly number[], temperature: number): number[] {
  const raised = p.map((x) => x ** (1 / temperature));
  const sum = raised.reduce((a, b) => a + b, 0);
  return raised.map((x) => x / sum);
}

/** The level the reader's probabilities decide on: `bayes(sharpen(0.3))`. */
export const decide = (p: readonly number[]): ReaderLevel => READER_LEVELS[bayes(sharpen(p, SHARPEN_T))] as ReaderLevel;

// ---- the casebook file ----

const isRow = (value: unknown): value is CaseRow => {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.message === 'string' &&
    typeof row.previous === 'string' &&
    typeof row.note === 'string' &&
    typeof row.core === 'boolean' &&
    (READER_LEVELS as readonly unknown[]).includes(row.level)
  );
};

/** The rows of a JSONL casebook, and the 1-based numbers of the lines that are not a row; blank lines are neither. */
export function parseCasebook(text: string): { rows: CaseRow[]; bad: number[] } {
  const rows: CaseRow[] = [];
  const bad: number[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      const value: unknown = JSON.parse(line);
      if (isRow(value)) rows.push({ message: value.message, previous: value.previous, level: value.level, note: value.note, core: value.core });
      else bad.push(index + 1);
    } catch {
      bad.push(index + 1);
    }
  });
  return { rows, bad };
}

/** How the casebook file is reached: the hooks file wraps `$.fs`, a bench wraps Node's. */
export type CasebookIo = {
  stat: (path: string) => Promise<{ mtimeMs: number }>;
  read: (path: string) => Promise<string>;
};

/** `missing`: no file, a defined state. `unreadable`: the file is there and could not be read; `error` says why. */
export type Casebook = { state: 'ok' | 'missing' | 'unreadable'; rows: CaseRow[]; bad: number[]; error?: string; mtimeMs?: number };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isMissing = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'ENOENT' || /\bENOENT\b/.test(messageOf(error));

/**
 * The casebook at `path`; a missing file and an unreadable one are different states, and neither throws. A hooks
 * module may not import Node, so the caller supplies `io` (a bench wraps `fs.promises.stat` and `readFile`).
 */
export async function loadCasebook(path: string, io: CasebookIo): Promise<Casebook> {
  try {
    const { mtimeMs } = await io.stat(path);
    const { rows, bad } = parseCasebook(await io.read(path));
    return { state: 'ok', rows, bad, mtimeMs };
  } catch (error) {
    if (isMissing(error)) return { state: 'missing', rows: [], bad: [] };
    return { state: 'unreadable', rows: [], bad: [], error: messageOf(error) };
  }
}

/** The casebook read once and again only when the file's mtime changes; `fresh` marks a read just made. */
export class CasebookCache {
  private held: { path: string; book: Casebook } | undefined;

  async get(path: string, io: CasebookIo): Promise<{ book: Casebook; fresh: boolean }> {
    const held = this.held;
    if (held?.path === path) {
      try {
        if ((await io.stat(path)).mtimeMs === held.book.mtimeMs) return { book: held.book, fresh: false };
      } catch {
        // The file changed under us or is gone: the read below says which.
      }
    }
    const book = await loadCasebook(path, io);
    this.held = book.state === 'ok' ? { path, book } : undefined;
    return { book, fresh: true };
  }
}
