import { describe as suite, expect, it } from 'vitest';
import { DESCRIBE_LINE, LEVELS, denyText, describe, parseTag, stepEffort, stripTag } from '../plugins/agent-effort/src/effort.ts';

suite('parseTag', () => {
  it.each(LEVELS)('reads [effort: %s] at the start of the prompt', (level) => {
    expect(parseTag(`[effort: ${level}]\nMap the callers of X.`)).toEqual({ kind: 'ok', effort: level });
  });

  it('ignores case, inner spaces and leading blank lines', () => {
    expect(parseTag('\n  [ Effort :  XHigh ] do it')).toEqual({ kind: 'ok', effort: 'xhigh' });
  });

  it('reports an unknown level with its text as written', () => {
    expect(parseTag('[effort: extreme] go')).toEqual({ kind: 'bad', raw: 'extreme' });
    expect(parseTag('[effort:] go')).toEqual({ kind: 'bad', raw: '' });
  });

  it('finds no tag in an untagged prompt', () => {
    expect(parseTag('Map the callers of X.')).toEqual({ kind: 'none' });
  });

  it('reads no tag that is not the first thing in the prompt', () => {
    expect(parseTag('Map X. [effort: high]')).toEqual({ kind: 'none' });
    expect(parseTag('Note [effort: max] below')).toEqual({ kind: 'none' });
  });
});

suite('denyText', () => {
  it('names the bad level and every valid one', () => {
    const text = denyText('extreme');
    expect(text).toContain('"extreme"');
    for (const level of LEVELS) expect(text).toContain(level);
  });
});

suite('describe', () => {
  it('appends the tag usage to the Agent description', () => {
    expect(describe('Launch a new agent.')).toBe('Launch a new agent.' + DESCRIBE_LINE);
  });

  it('appends it only once', () => {
    const once = describe('Launch a new agent.');
    expect(describe(once)).toBe(once);
  });
});

suite('stripTag', () => {
  it('removes the tag and the line break after it', () => {
    expect(stripTag('[effort: low]\nMap the callers of X.')).toBe('Map the callers of X.');
  });

  it('removes a tag written on the same line as the task, with its spaces', () => {
    expect(stripTag('  [Effort: XHigh]   Map X.')).toBe('Map X.');
  });

  it('keeps a tag that is not the first thing in the prompt', () => {
    expect(stripTag('Map X. [effort: high]')).toBe('Map X. [effort: high]');
  });

  it('returns an untagged prompt unchanged', () => {
    expect(stripTag('Map X.')).toBe('Map X.');
  });
});

suite('stepEffort', () => {
  it('sends a tagged pin whatever the request carries', () => {
    expect(stepEffort({ level: 'low' }, 'high')).toEqual({ send: 'low' });
  });

  it('pins an untagged sub-agent to its first request effort', () => {
    expect(stepEffort({ level: null }, 'medium')).toEqual({ send: 'medium', pin: 'medium' });
  });

  it('keeps sending the pin after the session effort changes', () => {
    expect(stepEffort({ level: 'medium' }, 'low')).toEqual({ send: 'medium' });
  });

  it('pins nothing for a model that takes no effort', () => {
    expect(stepEffort({ level: null }, undefined)).toEqual({ send: undefined });
  });

  it('leaves a loop the plugin never saw spawn alone', () => {
    expect(stepEffort(undefined, 'high')).toEqual({ send: 'high' });
  });
});

suite('parseTag on a tag-only prompt', () => {
  it('reports the missing task', () => {
    expect(parseTag('[effort: low]\n  ')).toEqual({ kind: 'empty' });
  });
});
