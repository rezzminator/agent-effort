import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../plugins/effort-live-control/src/settings.ts';
import { isTestCommand, isTestRun, returnLine, testOutcome, type ReturnWords } from '../plugins/effort-live-control/src/signals.ts';

const patterns = (list: string[]) => list.map((source) => new RegExp(source));
const TEST = patterns(DEFAULTS.testCommandPatterns);
const FAIL = patterns(DEFAULTS.failurePatterns);
const WORDS: ReturnWords = { red: DEFAULTS.redWords, green: DEFAULTS.greenWords };

describe('isTestCommand', () => {
  it.each(['npm test', 'go test ./...', 'npx vitest run tests/a.test.ts', 'pytest -x', 'cargo test', 'make check', 'scripts/test-api.sh'])('R-5: %s is a test run', (command) => {
    expect(isTestCommand(command, TEST)).toBe(true);
  });

  it.each(['cat README.md', 'git status', 'npm run build', 'grep -rn test src'])('R-5: %s is not', (command) => {
    expect(isTestCommand(command, TEST)).toBe(false);
  });

  it('testCommandPatterns: python -m unittest and node --test count as test runs', () => {
    for (const command of ['python -m unittest', 'python3 -m unittest -v', 'python3.14 -m unittest discover', 'cd /tmp/x && python3 -m unittest -v 2>&1 | tail -5', 'node --test', 'node --test tests/', 'node --test-only']) {
      expect(isTestCommand(command, TEST), command).toBe(true);
    }
    for (const command of ['python3 script.py', 'python -m pip install unittest2', 'node index.js', 'node --inspect app.js']) {
      expect(isTestCommand(command, TEST), command).toBe(false);
    }
  });
});

describe('isTestRun', () => {
  it('R-5: a foreground Bash call whose command matches is a test run; its command is returned', () => {
    expect(isTestRun('Bash', { command: 'npm test' }, TEST)).toBe('npm test');
  });

  it('R-5: a backgrounded run, another tool and a missing command are not', () => {
    expect(isTestRun('Bash', { command: 'npm test', run_in_background: true }, TEST)).toBeUndefined();
    expect(isTestRun('Read', { command: 'npm test' }, TEST)).toBeUndefined();
    expect(isTestRun('Bash', {}, TEST)).toBeUndefined();
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
    expect(returnLine('DONE and dusted', 'complete', WORDS)).toBeUndefined();
    expect(returnLine('FAILURE', 'complete', WORDS)).toBeUndefined();
    expect(returnLine('The build FAILED', 'complete', WORDS)).toBeUndefined();
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
