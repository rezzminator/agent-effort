import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../plugins/effort-live-control/src/settings.ts';
import { isRead, isTestCommand, isTestRun, returnLine, testOutcome, type ReturnWords } from '../plugins/effort-live-control/src/signals.ts';

const patterns = (list: string[]) => list.map((source) => new RegExp(source));
const TEST = patterns(DEFAULTS.testCommandPatterns);
const READ_ONLY = new Set(DEFAULTS.readOnlyCommands);
const FAIL = patterns(DEFAULTS.failurePatterns);
const WORDS: ReturnWords = { red: DEFAULTS.redWords, green: DEFAULTS.greenWords };

describe('isTestCommand', () => {
  it.each(['npm test', 'go test ./...', 'npx vitest run tests/a.test.ts', 'pytest -x', 'cargo test', 'make check', 'scripts/test-api.sh'])('R-5: %s is a test run', (command) => {
    expect(isTestCommand(command, TEST, READ_ONLY)).toBe(true);
  });

  it.each(['cat README.md', 'git status', 'npm run build', 'grep -rn test src'])('R-5: %s is not', (command) => {
    expect(isTestCommand(command, TEST, READ_ONLY)).toBe(false);
  });

  it('testCommandPatterns: python -m unittest and node --test count as test runs', () => {
    for (const command of ['python -m unittest', 'python3 -m unittest -v', 'python3.14 -m unittest discover', 'cd /tmp/x && python3 -m unittest -v 2>&1 | tail -5', 'node --test', 'node --test tests/', 'node --test-only']) {
      expect(isTestCommand(command, TEST, READ_ONLY), command).toBe(true);
    }
    for (const command of ['python3 script.py', 'python -m pip install unittest2', 'node index.js', 'node --inspect app.js']) {
      expect(isTestCommand(command, TEST, READ_ONLY), command).toBe(false);
    }
  });
});

describe('isRead', () => {
  it.each(['cat flight/returns/a-r1.md', 'head -5 a.md', 'sed -n 1,20p a.md', 'cat a.md | head -3', 'cd flight && cat returns/a.md', 'grep -n FAIL a.md', 'cat <<EOF\nFAIL x\nEOF'])('read channel: %s only reads', (command) => {
    expect(isRead('Bash', { command }, READ_ONLY)).toBe(true);
  });

  it.each(['./scripts/check.sh src/a.go', 'make lint 2>&1 | tail -3', 'cat a.md && ./run.sh', 'npm run build', 'node tool.js', 'bash -c "cat a.md"', 'cat a.md; python3 report.py'])('read channel: %s runs a program', (command) => {
    expect(isRead('Bash', { command }, READ_ONLY)).toBe(false);
  });

  it('read channel: the Read tool is always a read', () => {
    expect(isRead('Read', { file_path: 'a.md' }, READ_ONLY)).toBe(true);
  });

  it('read channel: a backgrounded call, a missing or empty command, comments alone and another tool are not reads', () => {
    expect(isRead('Bash', { command: 'cat a.md', run_in_background: true }, READ_ONLY)).toBe(false);
    expect(isRead('Bash', {}, READ_ONLY)).toBe(false);
    expect(isRead('Bash', { command: 42 }, READ_ONLY)).toBe(false);
    expect(isRead('Bash', { command: '' }, READ_ONLY)).toBe(false);
    expect(isRead('Bash', { command: '   \n' }, READ_ONLY)).toBe(false);
    expect(isRead('Bash', { command: '# cat a.md' }, READ_ONLY)).toBe(false);
    expect(isRead('Grep', { pattern: 'FAIL' }, READ_ONLY)).toBe(false);
    expect(isRead('Edit', { command: 'cat a.md' }, READ_ONLY)).toBe(false);
  });

  it('read channel: the programs that read are the readOnlyCommands in force', () => {
    expect(isRead('Bash', { command: 'cat a.md' }, new Set(['less']))).toBe(false);
    expect(isRead('Bash', { command: 'less a.md' }, new Set(['less']))).toBe(true);
    expect(isRead('Bash', { command: 'cat a.md' }, new Set())).toBe(false);
  });
});

describe('isTestRun', () => {
  it('R-5: a foreground Bash call whose command matches is a test run; its command is returned', () => {
    expect(isTestRun('Bash', { command: 'npm test' }, TEST, READ_ONLY)).toBe('npm test');
  });

  it('R-5: a backgrounded run, another tool and a missing command are not', () => {
    expect(isTestRun('Bash', { command: 'npm test', run_in_background: true }, TEST, READ_ONLY)).toBeUndefined();
    expect(isTestRun('Read', { command: 'npm test' }, TEST, READ_ONLY)).toBeUndefined();
    expect(isTestRun('Bash', {}, TEST, READ_ONLY)).toBeUndefined();
  });
});

describe('test runs', () => {
  it.each([
    ["cat > brief.md <<'EOF'\nrun python3 -m unittest -v\nEOF", false],
    ['grep -rn pytest .', false],
    ['echo "run pytest"', false],
    ['git commit -m "fix pytest flake"', false],
    ['sed -n 1,20p logs/pytest.log', false],
    ['cat <<<"pytest"', false],
    ['ls 2>&1 | grep pytest', false],
    ['cd x && python3 -m unittest -v 2>&1 | tail -3', true],
    ['F=/x; python3 -m unittest > $F/log 2>&1; echo rc=$?', true],
    ['timeout 600 npm test', true],
    ['env CI=1 npx vitest run', true],
    ['if pytest -q; then echo ok; fi', true],
    ['then grep pytest x', false],
    ['sudo -u ci make test', true],
    ['cat > run.md <<EOF\nx\nEOF\npytest -q', true],
    ['node --test', true],
    ['source venv/bin/activate && pytest', true],
    ["bash -c 'pytest -q'", true],
    ['command -v pytest', false],
    ['command -V pytest', false],
    ['command pytest -q', true],
    ['for f in a b; do pytest $f; done', true],
    ['for x in pytest jest; do echo $x; done', false],
    ['select t in pytest jest; do echo $t; done', false],
    ['case x in pytest) echo no;; esac', false],
    ['# run pytest', false],
    ['ls # then pytest', false],
    ['pytest -q # the unit suite', true],
    ['echo a#b', false],
    ['pytest tests/a#b.py', true],
    ['out=$(npm test 2>&1 | tail -3); echo "$out"', true],
    ['x="$(pytest -q)"', true],
    ['echo "$(python3 -m unittest 2>&1 | tail -1)"', true],
    ['x=`pytest -q`', true],
    ["echo '$(pytest)'", false],
    ['x=$(cat log | grep pytest)', false],
    ['echo `grep pytest log`', false],
    ['foo $(grep pytest log)', false],
  ])('test runs: %j is a test run: %s', (command, expected) => {
    expect(isTestCommand(command, TEST, READ_ONLY)).toBe(expected);
  });

  it('test runs: a heredoc that mentions the test command is not a test run through isTestRun either', () => {
    expect(isTestRun('Bash', { command: "cat > b.md <<'EOF'\npytest\nEOF" }, TEST, READ_ONLY)).toBeUndefined();
    expect(isTestRun('Bash', { command: "cat > b.md <<'EOF'\nx\nEOF\npytest" }, TEST, READ_ONLY)).toBe("cat > b.md <<'EOF'\nx\nEOF\npytest");
  });

  it('readOnlyCommands: a custom list replaces the default', () => {
    expect(isTestCommand('grep -rn pytest .', TEST, new Set())).toBe(true);
    expect(isTestCommand('grep -rn pytest .', TEST, new Set(['grep']))).toBe(false);
    expect(isTestCommand('echo pytest', TEST, new Set(['grep']))).toBe(true);
  });
});

describe('testOutcome', () => {
  it('R-5: an error result fails', () => {
    expect(testOutcome(true, 'all fine', FAIL)).toBe('fail');
  });

  it.each(['--- FAIL: TestX', 'FAILED tests/a.py', '3 failed, 2 passed', 'AssertionError: x', 'panic: nil', 'Traceback (most recent call last)'])('R-5: %s in the result fails', (text) => {
    expect(testOutcome(false, text, FAIL)).toBe('fail');
  });

  it('R-5: a clean result passes, and "0 failed" is not a failure', () => {
    expect(testOutcome(false, 'Tests: 12 passed, 0 failed', FAIL)).toBe('pass');
    expect(testOutcome(undefined, 'ok', FAIL)).toBe('pass');
  });
});

describe('returnLine', () => {
  it('R-6: reads a red token with an optional unit name and trailing detail', () => {
    expect(returnLine('FAIL', 'complete', WORDS)).toEqual({ token: 'FAIL', red: true, unit: undefined, line: 'FAIL' });
    expect(returnLine('BLOCKED lander-2: no network', 'complete', WORDS)).toEqual({ token: 'BLOCKED', red: true, unit: 'lander-2', line: 'BLOCKED lander-2: no network' });
    expect(returnLine('SPEC-DRIFT api/users.go', 'complete', WORDS)).toMatchObject({ token: 'SPEC-DRIFT', red: true, unit: 'api/users.go' });
  });

  it('R-6: reads a green token', () => {
    expect(returnLine('DONE auth', 'complete', WORDS)).toMatchObject({ token: 'DONE', red: false, unit: 'auth' });
    expect(returnLine('FIXED: the bug', 'complete', WORDS)).toMatchObject({ token: 'FIXED', red: false, unit: undefined });
  });

  it('R-6: FAILED is not read as FAIL plus text', () => {
    expect(returnLine('FAILED unit-a', 'complete', WORDS)).toMatchObject({ token: 'FAILED', unit: 'unit-a' });
  });

  it('R-6: a return line may run on after its unit, as a sub-agent appends a sentence to it', () => {
    expect(returnLine('DONE probe-unit. Handoff not written: this session has no file-write tool.', 'complete', WORDS)).toMatchObject({ token: 'DONE', red: false, unit: 'probe-unit' });
    expect(returnLine('PASS probe — 3 checks green', 'complete', WORDS)).toMatchObject({ token: 'PASS', unit: 'probe' });
    expect(returnLine('FAIL gate-r2, see gate.md', 'complete', WORDS)).toMatchObject({ token: 'FAIL', unit: 'gate-r2' });
    expect(returnLine('DONE.', 'complete', WORDS)).toMatchObject({ token: 'DONE', unit: undefined });
  });

  it('R-6: is case-sensitive and anchored on the whole line', () => {
    expect(returnLine('done', 'complete', WORDS)).toBeUndefined();
    expect(returnLine('FAILURE', 'complete', WORDS)).toBeUndefined();
    expect(returnLine('The build FAILED', 'complete', WORDS)).toBeUndefined();
  });

  it('return lines: a final answer counts whatever follows its token', () => {
    expect(returnLine('DONE probe-unit (handoff skipped: no write tool)', 'complete', WORDS)).toMatchObject({ token: 'DONE', red: false, unit: 'probe-unit' });
    expect(returnLine('DONE (no handoff)', 'complete', WORDS)).toMatchObject({ token: 'DONE', unit: undefined });
    expect(returnLine('PASS probe', 'complete', WORDS)).toMatchObject({ token: 'PASS', unit: 'probe' });
    expect(returnLine('FAILED — two residuals', 'complete', WORDS)).toMatchObject({ token: 'FAILED', red: true, unit: undefined });
    expect(returnLine('DONE and dusted', 'complete', WORDS)).toMatchObject({ token: 'DONE', red: false, unit: undefined });
    expect(returnLine('DONEZO', 'complete', WORDS)).toBeUndefined();
    expect(returnLine('done probe', 'complete', WORDS)).toBeUndefined();
  });

  it('return lines: a read result needs a boundary after its token or unit', () => {
    expect(returnLine('DONE probe-unit (x)', 'read', WORDS)).toMatchObject({ token: 'DONE', unit: 'probe-unit' });
    expect(returnLine('DONE and dusted', 'read', WORDS)).toBeUndefined();
    expect(returnLine('FAIL probe: 1 residual', 'read', WORDS)).toMatchObject({ token: 'FAIL', unit: 'probe' });
  });

  it('R-6: a turn.complete answer is searched in its first 15 lines', () => {
    const filler = Array.from({ length: 14 }, (_, i) => `line ${i}`);
    expect(returnLine([...filler, 'PARTIAL x'].join('\n'), 'complete', WORDS)).toMatchObject({ token: 'PARTIAL', unit: 'x' });
    expect(returnLine([...filler, 'line 14', 'PARTIAL x'].join('\n'), 'complete', WORDS)).toBeUndefined();
  });

  it('R-6: a read result counts only its first non-blank line, after a line-number prefix', () => {
    expect(returnLine('\n\n     1→FAIL unit-b\nmore', 'read', WORDS)).toMatchObject({ token: 'FAIL', unit: 'unit-b' });
    expect(returnLine('  12\tDONE z', 'read', WORDS)).toMatchObject({ token: 'DONE', unit: 'z' });
    expect(returnLine('intro\nFAIL x', 'read', WORDS)).toBeUndefined();
  });

  it('R-6: the word lists are options: a custom word counts, a removed one does not', () => {
    expect(returnLine('REJECTED z', 'complete', { red: ['REJECTED'], green: ['DONE'] })).toMatchObject({ token: 'REJECTED', red: true });
    expect(returnLine('FAIL z', 'complete', { red: ['REJECTED'], green: ['DONE'] })).toBeUndefined();
  });

  it('R-6: an empty or word-less text finds nothing', () => {
    expect(returnLine('', 'complete', WORDS)).toBeUndefined();
    expect(returnLine('   \n', 'read', WORDS)).toBeUndefined();
  });
});
