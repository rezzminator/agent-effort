import { describe, expect, it } from 'vitest';
import { announceLine, BUTTON_DOWN, BUTTON_UP, boundText, buttonText, REFUSED, whyChild, whyRedispatch } from '../plugins/effort-live-control/src/text.ts';

describe('button texts', () => {
  it('R-12: the two descriptions are the spec text, character for character', () => {
    expect(BUTTON_UP).toBe(
      'Raise your own reasoning effort one step for your next replies. Use it when you are stuck: a check still fails after your fix, results do not fit your understanding of the code, a sub-task came back red for a reason you did not foresee — or right before a design decision that is hard to undo. Not for routine steps; it makes every later reply slower and costlier.',
    );
    expect(BUTTON_DOWN).toBe(
      'Lower your own reasoning effort one step for your next replies. Use it when what is left is routine: spawning and waiting, relaying results, bookkeeping, or a fix whose every line you already know.',
    );
  });

  it('R-12: the results name the level and the range', () => {
    expect(buttonText('up', 'high', 'medium', 'xhigh')).toBe('Effort raised to high for your next replies (your range medium..xhigh).');
    expect(buttonText('down', 'medium', 'medium', 'xhigh')).toBe('Effort lowered to medium for your next replies (your range medium..xhigh).');
    expect(boundText('up', 'xhigh')).toBe('Your effort is already xhigh, the ceiling of your range; nothing changed.');
    expect(boundText('down', 'medium')).toBe('Your effort is already medium, the floor of your range; nothing changed.');
    expect(REFUSED).toBe("Not available here: this agent's effort is not live-controlled (its definition does not turn on effortControl). Nothing changed.");
  });
});

describe('announcements', () => {
  it('names the new level and why', () => {
    expect(announceLine('high', '2nd failing test run in a row')).toBe('effort-live-control: your reasoning effort is now high — 2nd failing test run in a row.');
    expect(whyChild('lander', 'BLOCKED')).toBe('lander returned BLOCKED');
    expect(whyRedispatch('builder')).toBe('builder sent back a red result');
  });
});
