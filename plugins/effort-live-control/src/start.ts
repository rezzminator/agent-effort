import type { Effort, ParentTag } from './effort.ts';
import { clamp } from './ladder.ts';

export type Row = Record<string, unknown>;

/** Where a spawned agent starts: its level (undefined: the first request decides) and the log row the choice earns. */
export type Start = { level: Effort | undefined; row?: Row };

/**
 * The level a spawn starts at. Under `honor` a tag beats the definition's own `effort:`;
 * under `ignore` the definition keeps it and the tag is logged as ignored. An untagged
 * spawn starts at the definition's effort, else (undefined) at its first request's.
 * A steered agent (`range` given) starts clamped into floor..ceiling.
 */
export function startOf(input: { tagged: Effort | undefined; own: Effort | undefined; parentTag: ParentTag; range: { floor: Effort; ceiling: Effort } | undefined }): Start {
  const { tagged, own, parentTag, range } = input;
  if (tagged !== undefined && own !== undefined && parentTag === 'ignore') {
    return { level: own, row: { event: 'tag-ignored', tag: tagged, effort: own } };
  }
  const chosen = parentTag === 'honor' ? (tagged ?? own) : (own ?? tagged);
  const level = chosen !== undefined && range ? clamp(chosen, range.floor, range.ceiling) : chosen;
  if (tagged === undefined || parentTag === 'ignore' || (own === undefined && range === undefined)) return { level };
  const row: Row = { event: 'tag', tag: tagged, effort: own ?? null };
  if (range && level !== undefined) {
    row.home = level;
    if (level !== tagged) row.clamped = true;
  }
  return { level, row };
}
