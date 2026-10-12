import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../plugins/effort-live-control/src/frontmatter.ts';

describe('parseFrontmatter', () => {
  it('reads top-level scalars between the fences', () => {
    expect(parseFrontmatter('---\nname: builder\neffort: High\n---\nbody: not me')).toEqual({ name: 'builder', effort: 'High' });
  });

  it('reads one level of nesting as parent.child', () => {
    const text = '---\nname: lead\neffortControl:\n  floor: medium\n  landing: lander, reviewer\n---\n';
    expect(parseFrontmatter(text)).toEqual({ name: 'lead', effortControl: '', 'effortControl.floor': 'medium', 'effortControl.landing': 'lander, reviewer' });
  });

  it('strips quotes and trailing comments', () => {
    expect(parseFrontmatter('---\na: "x y"\nb: z # note\n---\n')).toEqual({ a: 'x y', b: 'z' });
  });

  it('reads no frontmatter from a file without fences or with an unterminated one', () => {
    expect(parseFrontmatter('name: x')).toEqual({});
    expect(parseFrontmatter('---\nname: x\n')).toEqual({});
  });

  it('survives a byte-order mark and CRLF line ends', () => {
    expect(parseFrontmatter('﻿---\r\nname: x\r\n---\r\n')).toEqual({ name: 'x' });
  });
});
