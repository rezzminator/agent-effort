import { describe, expect, it } from 'vitest';
import {
  bayes,
  buildReader,
  buildReaderPrompt,
  CasebookCache,
  decide,
  loadCasebook,
  OVER_COST,
  parseCasebook,
  parseReaderAnswer,
  sharpen,
  SHARPEN_T,
  UNDER_COST,
  type CaseRow,
  type CasebookIo,
} from '../plugins/effort-live-control/src/reader.ts';

const row = (level: CaseRow['level'], message: string, extra: Partial<CaseRow> = {}): CaseRow => ({ message, previous: 'prev ' + message, level, note: 'note ' + message, core: false, ...extra });

describe('reader: the prompt', () => {
  const definitions = [
    '- medium: the reply is routine — run or check something, operate git or tools, make an edit the user dictated, report status or recall, answer a greeting, coordinate other agents, explain something already known.',
    '- high: the reply must work something out — diagnose a failure, build or fix something whose shape the agent designs, measure, research, review work.',
    '- xhigh: the reply must decide how a system should be shaped — architecture, options and trade-offs, a design or a proposal.',
  ];

  it('holds the opening sentence without the ruling, the three definitions word for word, the judging paragraph and the case', () => {
    const prompt = buildReaderPrompt('please fix the flaky test', 'I ran the suite and two cases fail.', []);
    expect(prompt.startsWith('You choose how hard a coding agent should think before its next reply.')).toBe(true);
    expect(prompt).not.toContain('The user ruled');
    expect(prompt).toContain('The three effort levels:\n' + definitions.join('\n'));
    expect(prompt).toContain(
      'For each case, estimate the probability of each level. Judge first what the user\'s message asks the agent to do next, then check it against the casebook and the precedents that match it. A short reply ("go", "yes", "Amen", a number, a pasted error) takes its meaning from the agent\'s previous reply: approving a plan to build means the build comes next; a pasted error means a diagnosis comes next. Give honest probabilities; the caller handles the cost of being wrong in either direction.',
    );
    expect(prompt).toContain("# The case to judge\n\nAgent's previous reply (end): I ran the suite and two cases fail.\n\nUser's new message: please fix the flaky test\n");
    expect(prompt.endsWith('Answer with one line only: three probabilities for medium, high and xhigh, separated by spaces, three decimals each, summing to 1. No other text.')).toBe(true);
  });

  it('omits the casebook and precedents headers when the casebook is empty', () => {
    const prompt = buildReaderPrompt('go', '(none: first message)', []);
    expect(prompt).not.toContain('# Casebook');
    expect(prompt).not.toContain('Nearest precedents');
    expect(prompt).toContain('# The case to judge');
  });

  it('renders each casebook row by case(): previous cut to 120, message to 260, the effort line first', () => {
    const long = 'x'.repeat(300);
    const prompt = buildReaderPrompt('go', 'p', [row('xhigh', long, { core: true, previous: 'y'.repeat(200), note: 'a design' })]);
    expect(prompt).toContain("# Casebook: past turns of this user's work and the effort each one needed\n");
    expect(prompt).toContain(`C1. effort xhigh — it turned out to be: a design\n   previous reply (end): ${'y'.repeat(119)}…\n   user: ${'x'.repeat(259)}…\n`);
  });

  it('cuts the message to 400 characters and keeps the last 200 of the previous reply', () => {
    const prompt = buildReaderPrompt('m'.repeat(500), 'Q'.repeat(100) + 'b'.repeat(200), []);
    expect(prompt).toContain(`User's new message: ${'m'.repeat(400)}\n`);
    expect(prompt).not.toContain('m'.repeat(401));
    expect(prompt).toContain(`Agent's previous reply (end): ${'b'.repeat(200)}\n`);
    expect(prompt).not.toContain('Q');
  });

  it('numbers the precedents under their own heading, most similar first', () => {
    const prompt = buildReaderPrompt('fix the parser bug', 'p', [row('high', 'fix the parser'), row('medium', 'say hello')]);
    expect(prompt).toContain('Nearest precedents (past turns whose message reads alike, most similar first):\n\n1. effort high — it turned out to be: note fix the parser\n');
    expect(prompt).not.toContain('2. effort');
  });
});

describe('reader: the casebook rows shown', () => {
  it('caps the core rows at 40 in file order and sorts them medium, high, xhigh', () => {
    const rows: CaseRow[] = [];
    for (let i = 0; i < 45; i += 1) rows.push(row((['xhigh', 'high', 'medium'] as const)[i % 3]!, `core ${i}`, { core: true }));
    const { core } = buildReader('zzz', 'p', rows);
    expect(core).toHaveLength(40);
    expect(new Set(core.map((r: CaseRow) => r.message))).toEqual(new Set(rows.slice(0, 40).map((r) => r.message)));
    const rank = { medium: 0, high: 1, xhigh: 2 };
    expect(core.map((r: CaseRow) => rank[r.level])).toEqual([...core.map((r: CaseRow) => rank[r.level])].sort());
    // within a level, file order
    const mediums = core.filter((r: CaseRow) => r.level === 'medium').map((r: CaseRow) => Number(r.message.slice(5)));
    expect(mediums).toEqual([...mediums].sort((a, b) => a - b));
  });

  it('picks the 6 nearest pool rows by TF-IDF cosine, most similar first, and skips the identical message', () => {
    const pool = [
      row('high', 'deploy the staging server tonight'),
      row('high', 'fix the flaky parser test in the parser module'),
      row('medium', 'parser test'),
      row('high', 'fix the parser'),
      row('medium', 'what time is it'),
      row('xhigh', 'design the parser module and its test layout'),
      row('medium', 'fix the flaky parser test'),
      row('high', 'parser'),
      row('medium', 'commit and push'),
      row('medium', 'fix the flaky parser test in the parser module'), // identical to the prompt: skipped
    ];
    const prompt = 'fix the flaky parser test in the parser module';
    const { precedents } = buildReader(prompt, 'p', pool);
    expect(precedents).toHaveLength(6);
    expect(precedents.map((r: CaseRow) => r.message)).not.toContain(prompt);
    expect(precedents[0]!.message).toBe('fix the flaky parser test');
    // none of the unrelated rows beats a row that shares words
    expect(precedents.map((r: CaseRow) => r.message)).not.toContain('what time is it');
    expect(precedents.map((r: CaseRow) => r.message)).not.toContain('commit and push');
    // most similar first: the cosine falls along the list
    const sim = (a: string, b: string) => {
      const ta = a.toLowerCase().match(/[a-z0-9]+/g)!;
      const tb = new Set(b.toLowerCase().match(/[a-z0-9]+/g)!);
      return ta.filter((t) => tb.has(t)).length / Math.sqrt(ta.length * tb.size);
    };
    const sims = precedents.map((r: CaseRow) => sim(prompt, r.message));
    expect(sims[0]!).toBeGreaterThan(sims[sims.length - 1]!);
  });

  it('puts a rarer shared word ahead of a common one (IDF)', () => {
    const pool = [row('high', 'refactor the code'), row('high', 'update the code'), row('high', 'check the code'), row('xhigh', 'zebra the code')];
    const { precedents } = buildReader('zebra code', 'p', pool);
    expect(precedents[0]!.message).toBe('zebra the code');
  });

  it('never shows a core row as a precedent, and shows no precedent for a prompt sharing no word', () => {
    const rows = [row('xhigh', 'design the cache', { core: true }), row('high', 'design the cache layer')];
    const { core, precedents } = buildReader('design the cache', 'p', rows);
    expect(core.map((r: CaseRow) => r.message)).toEqual(['design the cache']);
    expect(precedents.map((r: CaseRow) => r.message)).toEqual(['design the cache layer']);
    expect(buildReader('qqq', 'p', rows).precedents).toEqual([]);
  });
});

describe('reader: the decision', () => {
  // Reference: loss(d, t) = 3 per level of under-effort, 1 per level of over-effort; p is sharpened with T = 0.3 first.
  const loss = (d: number, t: number) => 3 * Math.max(0, t - d) + Math.max(0, d - t);
  const reference = (p: number[]) => {
    const q = p.map((x) => x ** (1 / 0.3));
    const s = q.reduce((a, b) => a + b, 0);
    const r = q.map((x) => x / s);
    let best = 0;
    let bestLoss = Infinity;
    for (let d = 0; d < 3; d += 1) {
      const e = r.reduce((acc, x, t) => acc + x * loss(d, t), 0);
      if (e < bestLoss) (bestLoss = e), (best = d);
    }
    return ['medium', 'high', 'xhigh'][best];
  };

  it('exports the constants of the lab: T 0.3, under-effort 3, over-effort 1', () => {
    expect([SHARPEN_T, UNDER_COST, OVER_COST]).toEqual([0.3, 3, 1]);
  });

  // E(medium) = 3 q1 + 6 q2, E(high) = q0 + 3 q2, E(xhigh) = 2 q0 + q1, q = p^(1/0.3) normalised.
  const table: Array<[number[], string]> = [
    // q = [.9625, .0372, .0002]: E = [.113, .963, 1.962] -> medium
    [[0.69, 0.26, 0.05], 'medium'],
    // q = [.090, .908, .002]: E = [2.74, .097, 1.09] -> high
    [[0.3, 0.6, 0.1], 'high'],
    // q = [.045, .288, .667]: E = [4.86, 2.05, .378] -> xhigh
    [[0.2, 0.35, 0.45], 'xhigh'],
    // medium beats high iff q0 > 3 (q1 + q2), i.e. q0 > .75. Here q = [.8163, .1807, .0028]: raw p0 .55 would say high, sharpening says medium (E = [.559, .825, ...])
    [[0.55, 0.35, 0.1], 'medium'],
    // high beats xhigh iff q2 < .25. Here q = [.0003, .5568, .2565 after normalising .1364, .0471, 0]: q2 = .2568 > .25 -> xhigh (E = [..., .770, .743])
    [[0.05, 0.55, 0.4], 'xhigh'],
    // q = [.0002, .8577, .1421]: q2 = .142 < .25 -> high
    [[0.05, 0.6, 0.35], 'high'],
  ];

  it.each(table)('decide(%j) is %s, and equals bayes(sharpen(0.3))', (p, level) => {
    expect(decide(p)).toBe(level);
    expect(decide(p)).toBe(reference(p));
  });

  it('sharpen takes p^(1/T) over the sum, and bayes minimises the expected loss with ties to the lower level', () => {
    const q = sharpen([0.5, 0.5, 0], 0.3);
    expect(q[0]).toBeCloseTo(0.5, 10);
    expect(q[2]).toBe(0);
    expect(bayes([1, 0, 0])).toBe(0);
    expect(bayes([0, 0, 1])).toBe(2);
  });
});

describe('reader: parsing the answer', () => {
  it('reads three probabilities in the plain, labelled and renormalised forms', () => {
    expect(parseReaderAnswer('0.1 0.6 0.3')).toEqual([0.1, 0.6, 0.3]);
    const labelled = parseReaderAnswer('p: 0.100, 0.600, 0.300')!;
    expect(labelled[0]).toBeCloseTo(0.1, 10);
    expect(labelled[1]).toBeCloseTo(0.6, 10);
    expect(labelled[2]).toBeCloseTo(0.3, 10);
    const even = parseReaderAnswer('0.2 0.2 0.2')!;
    expect(even.map((x: number) => Number(x.toFixed(6)))).toEqual([0.333333, 0.333333, 0.333333]);
  });

  it('clips a negative number to 0 and renormalises', () => {
    expect(parseReaderAnswer('-0.2 0.5 0.5')).toEqual([0, 0.5, 0.5]);
  });

  it('does not parse a level word, an empty answer, fewer than three numbers or all zeros', () => {
    expect(parseReaderAnswer('high')).toBeUndefined();
    expect(parseReaderAnswer('')).toBeUndefined();
    expect(parseReaderAnswer('   \n')).toBeUndefined();
    expect(parseReaderAnswer('0.5 0.5')).toBeUndefined();
    expect(parseReaderAnswer('0 0 0')).toBeUndefined();
  });
});

describe('reader: the casebook file', () => {
  const line = (r: Partial<CaseRow> = {}) => JSON.stringify({ message: 'm', previous: 'p', level: 'high', note: 'n', core: false, ...r });

  it('parseCasebook skips a malformed line and names its number', () => {
    const text = [line(), '{not json', '', line({ level: 'low' as never }), JSON.stringify({ message: 'only' }), line({ core: true })].join('\n');
    const { rows, bad } = parseCasebook(text);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.core).toBe(true);
    expect(bad).toEqual([2, 4, 5]);
  });

  const io = (files: Record<string, string>, broken: string[] = []): CasebookIo => ({
    stat: async (path) => {
      if (broken.includes(path)) throw new Error('EACCES: permission denied');
      if (!(path in files)) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
      return { mtimeMs: files[path]!.length };
    },
    read: async (path) => {
      if (broken.includes(path)) throw new Error('EACCES: permission denied');
      if (!(path in files)) throw new Error('ENOENT: no such file');
      return files[path]!;
    },
  });

  it('a missing file is the state "missing", with no rows and no error', async () => {
    const book = await loadCasebook('/c.jsonl', io({}));
    expect(book).toMatchObject({ state: 'missing', rows: [], bad: [] });
    expect(book.error).toBeUndefined();
  });

  it('an unreadable file is the state "unreadable" and carries the error', async () => {
    const book = await loadCasebook('/c.jsonl', io({ '/c.jsonl': line() }, ['/c.jsonl']));
    expect(book.state).toBe('unreadable');
    expect(book.rows).toEqual([]);
    expect(book.error).toContain('EACCES');
  });

  it('a readable file is "ok" with its rows and malformed line numbers', async () => {
    const book = await loadCasebook('/c.jsonl', io({ '/c.jsonl': line() + '\nbroken\n' }));
    expect(book).toMatchObject({ state: 'ok', bad: [2] });
    expect(book.rows).toHaveLength(1);
  });

  it('the cache reads once and again only when the mtime changes', async () => {
    const files: Record<string, string> = { '/c.jsonl': line() };
    let reads = 0;
    const counting: CasebookIo = { ...io(files), read: async (path) => (reads += 1, files[path]!) };
    const cache = new CasebookCache();
    const first = await cache.get('/c.jsonl', counting);
    const again = await cache.get('/c.jsonl', counting);
    expect([first.fresh, again.fresh, reads]).toEqual([true, false, 1]);
    files['/c.jsonl'] = line() + '\n' + line({ message: 'second' });
    const changed = await cache.get('/c.jsonl', counting);
    expect([changed.fresh, changed.book.rows.length, reads]).toEqual([true, 2, 2]);
  });
});
