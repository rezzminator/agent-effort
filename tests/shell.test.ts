import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../plugins/effort-live-control/src/settings.ts';
import { runSegments } from '../plugins/effort-live-control/src/shell.ts';

const READ_ONLY = new Set(DEFAULTS.readOnlyCommands);
const segments = (command: string, readOnly: ReadonlySet<string> = READ_ONLY) => runSegments(command, readOnly);

describe('runSegments', () => {
  it('heredocs: the body is dropped and the operator line stays', () => {
    expect(segments("cat > b.md <<'EOF'\nline\nEOF\npytest -q", new Set())).toEqual(["cat > b.md <<'EOF'", 'pytest -q']);
    expect(segments('cat <<EOF\npytest\nEOF', new Set())).toEqual(['cat <<EOF']);
  });

  it('heredocs: <<- strips leading tabs from the closing line, << does not', () => {
    expect(segments('cat <<-EOF\n\tx\n\tEOF\nls', new Set())).toEqual(['cat <<-EOF', 'ls']);
    expect(segments('cat <<EOF\n\tEOF\nstill body\nEOF\nls', new Set())).toEqual(['cat <<EOF', 'ls']);
  });

  it('heredocs: several on one line take their bodies in order, and an unterminated body runs to the end', () => {
    expect(segments('cat <<A <<"B"\na1\nA\nb1\nB\nls', new Set())).toEqual(['cat <<A <<"B"', 'ls']);
    expect(segments('cat <<EOF\nnever closed\npytest', new Set())).toEqual(['cat <<EOF']);
  });

  it('heredocs: <<< is a here-string, a quoted << is text, and a << with no delimiter is no heredoc', () => {
    expect(segments('cat <<<"x"\nls', new Set())).toEqual(['cat <<<"x"', 'ls']);
    expect(segments('echo "a << EOF"\nls', new Set())).toEqual(['echo "a << EOF"', 'ls']);
    expect(segments('echo $((1 << 3))\nls', new Set())).toEqual(['echo $((1 << 3))', 'ls']);
  });

  it('splitting: at ; & | and newline, with && || |& splitting too', () => {
    expect(segments('a; b & c | d\ne && f || g |& h', new Set())).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });

  it('splitting: quotes and backslashes hide separators, and an & in a redirect does not split', () => {
    expect(segments(`echo 'a; b' "c | d" e\\;f`, new Set())).toEqual([`echo 'a; b' "c | d" e\\;f`]);
    expect(segments('make 2>&1 | tee x; ls >&2; cmd &> log; cmd2 &>> log', new Set())).toEqual(['make 2>&1', 'tee x', 'ls >&2', 'cmd &> log', 'cmd2 &>> log']);
    expect(segments('echo "line one\npytest"', new Set())).toEqual(['echo "line one\npytest"']);
  });

  it('leading parts: ( { ! and the shell keywords are dropped', () => {
    expect(segments('(pytest -q)', new Set())).toEqual(['pytest -q)']);
    expect(segments('! pytest; { jest; }', new Set())).toEqual(['pytest', 'jest', '}']);
    expect(segments('if pytest; then jest; elif x; then y; else z; fi', new Set())).toEqual(['pytest', 'jest', 'x', 'y', 'z', 'fi']);
    expect(segments('while pytest; do jest; done; until x; do y; done', new Set())).toEqual(['pytest', 'jest', 'done', 'x', 'y', 'done']);
  });

  it('leading parts: assignments, quoted or not, are dropped', () => {
    expect(segments('A=1 B="x y" C=\'z\' pytest -q', new Set())).toEqual(['pytest -q']);
    expect(segments('A=1', new Set())).toEqual([]);
  });

  it.each([
    ['env CI=1 -i -u X pytest', 'pytest'],
    ['time -p pytest', 'pytest'],
    ['nice -n 5 pytest', 'pytest'],
    ['nice -5 pytest', 'pytest'],
    ['nohup pytest', 'pytest'],
    ['sudo -u ci -E make test', 'make test'],
    ['command pytest', 'pytest'],
    ['exec pytest', 'pytest'],
    ['timeout -s KILL -k 5 --foreground 600 npm test', 'npm test'],
    ['timeout 600 nice -n 1 env A=1 pytest', 'pytest'],
    ['/usr/bin/env pytest', 'pytest'],
  ])('leading parts: wrapper words with their options are dropped: %s', (command, expected) => {
    expect(segments(command, new Set())).toEqual([expected]);
  });

  it('read-only: a segment whose program is read-only is skipped, by basename and unquoted', () => {
    expect(segments('grep pytest x; /usr/bin/grep pytest y; "cat" pytest; env A=1 sudo -u ci git log; pytest', READ_ONLY)).toEqual(['pytest']);
    expect(segments('source venv/bin/activate && . ./env.sh', READ_ONLY)).toEqual(['source venv/bin/activate', '. ./env.sh']);
  });

  it('read-only: an empty command and an empty segment give nothing', () => {
    expect(segments('', READ_ONLY)).toEqual([]);
    expect(segments(' ;; && \n ', READ_ONLY)).toEqual([]);
  });

  it('lookups: command -v and command -V name a program and run nothing, a plain command is a wrapper', () => {
    expect(segments('command -v pytest; command -V pytest; sudo command -v jest', new Set())).toEqual([]);
    expect(segments('command pytest -q', new Set())).toEqual(['pytest -q']);
  });

  it('headers: for, select and case words are data, and the body after do is its own segment', () => {
    expect(segments('for f in a b; do pytest $f; done', new Set())).toEqual(['pytest $f', 'done']);
    expect(segments('for x in pytest jest; do echo $x; done', new Set())).toEqual(['echo $x', 'done']);
    expect(segments('select t in a; do jest; done; case $1 in a) x;; esac', new Set())).toEqual(['jest', 'done', 'esac']);
    expect(segments('while pytest; do :; done', new Set())).toEqual(['pytest', ':', 'done']);
  });

  it('comments: an unquoted # that starts a word runs to the end of the line', () => {
    expect(segments('# run pytest\nls # and jest\npytest # note', new Set())).toEqual(['ls', 'pytest']);
    expect(segments('a;# c\nb', new Set())).toEqual(['a', 'b']);
  });

  it('comments: a # inside a word, a quote or after an escape is text', () => {
    expect(segments('echo a#b ${#x} $# "a #b" \'c #d\' \\#e', new Set())).toEqual(['echo a#b ${#x} $# "a #b" \'c #d\' \\#e']);
  });

  it('substitution: the commands inside $( ) and backticks run, ahead of the segment that holds them', () => {
    expect(segments('out=$(npm test 2>&1 | tail -3); echo "$out"', new Set())).toEqual(['npm test 2>&1', 'tail -3', 'echo "$out"']);
    expect(segments('echo "$(pytest -q)" done', new Set())).toEqual(['pytest -q', 'echo "$()" done']);
    expect(segments('x=`pytest -q`; y', new Set())).toEqual(['pytest -q', 'y']);
    expect(segments('echo `grep a b | wc`', new Set())).toEqual(['grep a b', 'wc', 'echo ``']);
  });

  it('substitution: nesting, quotes and parentheses inside it are tracked, and the holder keeps no inner text', () => {
    expect(segments('a $(b $(c) d) e', new Set())).toEqual(['c', 'b $() d', 'a $() e']);
    expect(segments('f $(echo ")" ; pytest) g', new Set())).toEqual(['echo ")"', 'pytest', 'f $() g']);
    expect(segments("f $(echo ')' \"x $(y) z\") g", new Set())).toEqual(['y', "echo ')' \"x $() z\"", 'f $() g']);
    expect(segments('f $( (pytest) ) g', new Set())).toEqual(['pytest)', 'f $() g']);
  });

  it('substitution: single quotes keep it literal, arithmetic is not one, and an unterminated one runs to the end', () => {
    expect(segments("echo '$(pytest) `jest`'", new Set())).toEqual(["echo '$(pytest) `jest`'"]);
    expect(segments('echo $((1 + 2)) | wc', new Set())).toEqual(['echo $((1 + 2))', 'wc']);
    expect(segments('echo $(pytest -q', new Set())).toEqual(['pytest -q', 'echo $()']);
  });

  it('substitution: its read-only programs are skipped like any segment, and a holder that only assigns is no segment', () => {
    expect(segments('x=$(cat log | grep pytest)', READ_ONLY)).toEqual([]);
    expect(segments('echo "$(pytest -q | tail -1)"', READ_ONLY)).toEqual(['pytest -q']);
  });
});
