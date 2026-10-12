// What a shell command string actually runs: the simple commands in it, without heredoc bodies,
// without the words that only prefix a program, and without the programs that only read or print.

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until']);
/** Loop and case headers: their words are data, the body after `do` is its own segment. */
const HEADERS = new Set(['for', 'select', 'case']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DELIMITER = /^[A-Za-z_][A-Za-z0-9_]*/;
const SPACE = /\s/;

type Heredoc = { delimiter: string; stripTabs: boolean };

/** The heredoc operator at `at` (`<<` or `<<-`, never `<<<`) with its delimiter, or undefined when it is none. */
function heredocAt(text: string, at: number): { heredoc: Heredoc; end: number } | undefined {
  let i = at + 2;
  const stripTabs = text[i] === '-';
  if (stripTabs) i++;
  while (text[i] === ' ' || text[i] === '\t') i++;
  const quote = text[i] === "'" || text[i] === '"' ? (text[i] as string) : '';
  if (quote) i++;
  const name = DELIMITER.exec(text.slice(i))?.[0];
  if (name === undefined) return undefined;
  i += name.length;
  if (quote) {
    if (text[i] !== quote) return undefined;
    i++;
  }
  return { heredoc: { delimiter: name, stripTabs }, end: i };
}

/** The position after the body of each pending heredoc, read from `from`, the start of the line after the operator line. */
function skipBodies(text: string, from: number, pending: readonly Heredoc[]): number {
  let at = from;
  for (const { delimiter, stripTabs } of pending) {
    while (at < text.length) {
      const newline = text.indexOf('\n', at);
      const line = text.slice(at, newline === -1 ? text.length : newline);
      at = newline === -1 ? text.length : newline + 1;
      if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) break;
    }
  }
  return at;
}

/** The index of the `)` closing a `$(` whose text starts at `from`, quotes, nesting and backticks tracked; -1 when it never closes. */
function closeOf(text: string, from: number): number {
  let depth = 0;
  let quote = '';
  for (let i = from; i < text.length; i++) {
    const c = text[i] as string;
    if (c === '\\' && quote !== "'") i++;
    else if (quote === "'") quote = c === "'" ? '' : quote;
    else if (c === '$' && text[i + 1] === '(') {
      const end = closeOf(text, i + 2);
      if (end === -1) return -1;
      i = end;
    } else if (c === '`') {
      const end = backtickEnd(text, i);
      if (end === -1) return -1;
      i = end;
    } else if (quote === '"') quote = c === '"' ? '' : quote;
    else if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** The index of the backtick closing the one at `at`, or -1. */
function backtickEnd(text: string, at: number): number {
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '`') return i;
  }
  return -1;
}

/**
 * The command split at unquoted `;`, `&`, `|` and newline, heredoc bodies and comments left out.
 * What runs inside an unquoted or double-quoted `$( )` or backticks is split the same way and comes
 * ahead of the segment that holds it, which keeps the substitution as an empty `$()` or pair of backticks.
 */
function split(command: string): string[] {
  const out: string[] = [];
  const pending: Heredoc[] = [];
  const inner: string[] = [];
  let current = '';
  let quote = '';
  const cut = () => {
    out.push(...inner.splice(0), current);
    current = '';
  };
  const substitute = (open: string, close: string, from: number, end: number) => {
    inner.push(...split(command.slice(from, end === -1 ? command.length : end)));
    current += open + close;
    return end === -1 ? command.length : end;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (c === '\\' && quote !== "'") {
      const next = command[i + 1];
      current += next === '\n' ? ' ' : c + (next ?? '');
      i++;
    } else if (quote === "'") {
      if (c === quote) quote = '';
      current += c;
    } else if (c === '$' && command[i + 1] === '(' && command[i + 2] === '(') {
      const end = closeOf(command, i + 2);
      current += command.slice(i, end === -1 ? command.length : end + 1);
      i = end === -1 ? command.length : end;
    } else if (c === '$' && command[i + 1] === '(') {
      i = substitute('$(', ')', i + 2, closeOf(command, i + 2));
    } else if (c === '`') {
      i = substitute('`', '`', i + 1, backtickEnd(command, i));
    } else if (quote === '"') {
      if (c === quote) quote = '';
      current += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      current += c;
    } else if (c === '#' && (current.trim() === '' || SPACE.test(command[i - 1] as string))) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++;
    } else if (c === '<' && command.startsWith('<<<', i)) {
      current += '<<<';
      i += 2;
    } else if (c === '<' && command.startsWith('<<', i)) {
      const found = heredocAt(command, i);
      if (found === undefined) {
        current += '<<';
        i += 1;
      } else {
        pending.push(found.heredoc);
        current += command.slice(i, found.end);
        i = found.end - 1;
      }
    } else if (c === '\n') {
      cut();
      if (pending.length > 0) i = skipBodies(command, i + 1, pending.splice(0)) - 1;
    } else if (c === ';' || c === '|' || (c === '&' && command[i - 1] !== '>' && command[i - 1] !== '<' && command[i + 1] !== '>')) {
      cut();
    } else {
      current += c;
    }
  }
  cut();
  return out;
}

/** The next whitespace-separated word of `text` from `from`: its quoted-or-not source text and where it starts and ends. */
function nextWord(text: string, from: number): { raw: string; start: number; end: number } | undefined {
  let i = from;
  while (i < text.length && SPACE.test(text[i] as string)) i++;
  if (i >= text.length) return undefined;
  const wordStart = i;
  let quote = '';
  for (; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = '';
    } else if (c === '\\') i++;
    else if (c === "'" || c === '"') quote = c;
    else if (SPACE.test(c)) break;
  }
  const end = Math.min(i, text.length);
  return { raw: text.slice(wordStart, end), start: wordStart, end };
}

const unquote = (raw: string): string => raw.replace(/\\(.)|['"]/g, '$1');
const baseName = (raw: string): string => {
  const word = unquote(raw);
  return word.slice(word.lastIndexOf('/') + 1) || word;
};

/** The options a wrapper word takes before the program it runs. */
type Options = { flags?: string[]; valued?: string[]; anyDash?: boolean; numeric?: boolean; assignments?: boolean; duration?: boolean };

const WRAPPERS: Record<string, Options> = {
  env: { flags: ['-i'], valued: ['-u'], assignments: true },
  time: { flags: ['-p'] },
  nice: { valued: ['-n'], numeric: true },
  nohup: {},
  sudo: { flags: ['-E'], valued: ['-u'] },
  command: {},
  exec: {},
  timeout: { valued: ['-s', '-k'], anyDash: true, duration: true },
};

/** The position after a wrapper word's options (and its duration, for `timeout`). */
function skipOptions(text: string, from: number, options: Options): number {
  let at = from;
  for (;;) {
    const word = nextWord(text, at);
    if (!word) break;
    if (options.valued?.includes(word.raw)) at = nextWord(text, word.end)?.end ?? word.end;
    else if (options.flags?.includes(word.raw) || (options.anyDash && word.raw.startsWith('-')) || (options.numeric && /^-\d+$/.test(word.raw)) || (options.assignments && ASSIGNMENT.test(word.raw))) at = word.end;
    else break;
  }
  return options.duration ? (nextWord(text, at)?.end ?? at) : at;
}

/** A segment without its leading parts: the program a simple command runs, and the command from that program on. */
function program(segment: string): { name: string; command: string } | undefined {
  let at = 0;
  for (;;) {
    while (at < segment.length && (SPACE.test(segment[at] as string) || segment[at] === '(')) at++;
    while ((segment[at] === '{' || segment[at] === '!') && (at + 1 >= segment.length || SPACE.test(segment[at + 1] as string))) at++;
    const word = nextWord(segment, at);
    if (!word) return undefined;
    const name = baseName(word.raw);
    if (HEADERS.has(word.raw)) return undefined;
    if (name === 'command' && ['-v', '-V'].includes(nextWord(segment, word.end)?.raw ?? '')) return undefined;
    const wrapper = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined;
    if (KEYWORDS.has(word.raw) || ASSIGNMENT.test(word.raw)) at = word.end;
    else if (wrapper) at = skipOptions(segment, word.end, wrapper);
    else return { name, command: segment.slice(word.start).trim() };
  }
}

/**
 * The simple commands a shell command string runs, in order: heredoc bodies and comments dropped,
 * split at unquoted `;`, `&`, `|` and newline, the commands inside `$( )` and backticks ahead of
 * the segment that holds them, each stripped of its leading `(`, `{`, `!`, keywords, assignments
 * and wrapper words, and left out when it is a loop or case header, a `command -v` lookup, or a
 * `readOnly` program.
 */
export function runSegments(command: string, readOnly: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const segment of split(command)) {
    const found = program(segment.trim());
    if (found && found.command !== '' && !readOnly.has(found.name)) out.push(found.command);
  }
  return out;
}
