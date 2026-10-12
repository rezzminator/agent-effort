import { LEVELS, type Effort } from './effort.ts';

const RANK: Readonly<Record<Effort, number>> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

export function isLevel(value: unknown): value is Effort {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value);
}

export function rank(level: Effort): number {
  return RANK[level];
}

/** `level` brought into floor..ceiling. */
export function clamp(level: Effort, floor: Effort, ceiling: Effort): Effort {
  return LEVELS[Math.min(rank(ceiling), Math.max(rank(floor), rank(level)))] as Effort;
}

/** `level` moved `delta` steps along low < medium < high < xhigh < max, held within floor..ceiling. */
export function step(level: Effort, delta: number, floor: Effort, ceiling: Effort): Effort {
  const moved = Math.min(LEVELS.length - 1, Math.max(0, rank(level) + delta));
  return clamp(LEVELS[moved] as Effort, floor, ceiling);
}
