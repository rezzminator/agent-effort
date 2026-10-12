import { isEffort, isParentTag, LEVELS, type Effort, type ParentTag } from './effort.ts';
import { parseFrontmatter } from './frontmatter.ts';
import { parseTripwires, type Tripwire } from './judge.ts';
import { rank } from './ladder.ts';
import { parseDecay } from './settings.ts';

export type AgentFs = {
  exists: (path: string) => Promise<boolean>;
  read: (path: string) => Promise<string>;
  /** File names (no directory part) of the `.md` files in a directory. */
  listMarkdown: (dir: string) => Promise<string[]>;
};

/** What an agent's `effortControl` frontmatter resolves to; every field has its default filled in. */
export type ControlConfig = {
  floor: Effort;
  ceiling: Effort;
  /** Agent types whose spawn lands the flight: the steered agent steps one below its home level. */
  landing: string[];
  judge: boolean;
  /** The armed tripwire kinds; empty arms none. */
  tripwires: Tripwire[];
  /** The requests without a new tripwire after which an open struggle's level comes home; 0: never. */
  struggleDecay: number;
};

/** The option values a frontmatter key falls back to. */
export type ControlDefaults = { floor: Effort; ceiling: Effort; judge: boolean; tripwires: readonly Tripwire[]; parentTag: ParentTag; struggleDecay: number };

export type Definition = {
  /** The definition file, or undefined when the type has none (or it could not be read). */
  path: string | undefined;
  /** The definition's `effort:` when it is a level. */
  effort: Effort | undefined;
  /** Undefined when steering is off, absent or unreadable. */
  control: ControlConfig | undefined;
  /** Whether a tag wins over this type's `effort:`: its `effortControl.parentTag`, else the option; read even when steering is off. */
  parentTag: ParentTag;
  /** Every line logged while resolving this type. */
  errors: string[];
};

function join(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** on/true/yes → true, off/false/no → false, case-insensitive; anything else undefined. */
function parseSwitch(raw: string): boolean | undefined {
  const word = raw.trim().toLowerCase();
  if (word === 'on' || word === 'true' || word === 'yes') return true;
  if (word === 'off' || word === 'false' || word === 'no') return false;
  return undefined;
}

/**
 * Resolves an agent type to its definition's effort and effortControl: `<dir>/<type>.md`
 * in each directory in order (its `name:` absent or the type), then any file whose
 * frontmatter `name:` is the type (the directories scanned once), else no definition.
 * Every failure is logged and read as no definition; results are cached per type.
 */
export class Definitions {
  private readonly byType = new Map<string, Promise<Definition>>();
  private nameIndex: Promise<Map<string, string>> | undefined;

  constructor(
    private readonly dirs: readonly string[],
    private readonly defaults: ControlDefaults,
    private readonly fs: AgentFs,
    private readonly log: (line: string) => void,
  ) {}

  resolve(type: string): Promise<Definition> {
    let hit = this.byType.get(type);
    if (!hit) {
      hit = this.lookup(type);
      this.byType.set(type, hit);
    }
    return hit;
  }

  private async lookup(type: string): Promise<Definition> {
    const errors: string[] = [];
    const report = (line: string) => {
      errors.push(line);
      this.log(line);
    };
    for (const dir of this.dirs) {
      const path = join(dir, `${type}.md`);
      let found = false;
      try {
        found = await this.fs.exists(path);
      } catch (error) {
        report(`effort-live-control: checking ${path} failed: ${message(error)}; treating ${type} as having no definition there`);
      }
      if (!found) continue;
      const fields = await this.fields(path, type, report);
      if (fields === 'failed') return this.none(errors);
      if (!fields.name || fields.name === type) return this.fromFields(type, path, fields, errors, report);
    }
    const byName = (await this.index(report)).get(type);
    if (byName) {
      const fields = await this.fields(byName, type, report);
      if (fields !== 'failed') return this.fromFields(type, byName, fields, errors, report);
    }
    return this.none(errors);
  }

  private none(errors: string[]): Definition {
    return { path: undefined, effort: undefined, control: undefined, parentTag: this.defaults.parentTag, errors };
  }

  private fromFields(type: string, path: string, fields: Record<string, string>, errors: string[], report: (line: string) => void): Definition {
    const level = (fields.effort ?? '').trim().toLowerCase();
    const effort = isEffort(level) ? level : undefined;
    return { path, effort, control: this.control(type, path, fields, report), parentTag: this.parentTag(type, path, fields, report), errors };
  }

  /** `effortControl.parentTag` over the option; read whether or not the type is steered. */
  private parentTag(type: string, path: string, fields: Record<string, string>, report: (line: string) => void): ParentTag {
    const fallback = this.defaults.parentTag;
    const raw = fields['effortControl.parentTag'];
    if (raw === undefined) return fallback;
    const value = raw.trim().toLowerCase();
    if (isParentTag(value)) return value;
    report(`effort-live-control: ${path} effortControl.parentTag for ${type} is invalid (not honor or ignore); using ${fallback}`);
    return fallback;
  }

  private control(type: string, path: string, fields: Record<string, string>, report: (line: string) => void): ControlConfig | undefined {
    const invalid = (key: string, why: string, fallback: string) =>
      report(`effort-live-control: ${path} ${key} for ${type} is invalid (${why}); using ${fallback}`);
    const { floor: defaultFloor, ceiling: defaultCeiling, judge: defaultJudge, tripwires: defaultTripwires, struggleDecay: defaultDecay } = this.defaults;
    const bare = fields.effortControl;
    if (bare !== undefined && bare.trim() !== '') {
      const on = parseSwitch(bare);
      if (on === undefined) {
        invalid('effortControl', 'not on, off, true, false, yes or no', 'off');
        return undefined;
      }
      return on ? { floor: defaultFloor, ceiling: defaultCeiling, landing: [], judge: defaultJudge, tripwires: [...defaultTripwires], struggleDecay: defaultDecay } : undefined;
    }
    // `parentTag` steers nothing: alone it pins a type without turning steering on.
    if (!Object.keys(fields).some((key) => key.startsWith('effortControl.') && key !== 'effortControl.parentTag')) return undefined;

    const level = (key: 'floor' | 'ceiling', fallback: Effort): Effort => {
      const raw = fields[`effortControl.${key}`];
      if (raw === undefined) return fallback;
      const value = raw.trim().toLowerCase();
      if (isEffort(value)) return value;
      invalid(`effortControl.${key}`, `not a level: ${LEVELS.join(', ')}`, fallback);
      return fallback;
    };
    const flag = (key: 'enabled' | 'judge', fallback: boolean): boolean => {
      const raw = fields[`effortControl.${key}`];
      if (raw === undefined) return fallback;
      const value = parseSwitch(raw);
      if (value !== undefined) return value;
      invalid(`effortControl.${key}`, 'not on, off, true, false, yes or no', fallback ? 'on' : 'off');
      return fallback;
    };

    if (!flag('enabled', true)) return undefined;
    let floor = level('floor', defaultFloor);
    let ceiling = level('ceiling', defaultCeiling);
    if (rank(floor) > rank(ceiling)) {
      invalid('effortControl.floor', `above effortControl.ceiling ${ceiling}`, `${defaultFloor}..${defaultCeiling}`);
      floor = defaultFloor;
      ceiling = defaultCeiling;
    }
    const landing = (fields['effortControl.landing'] ?? '').split(/[\s,]+/).filter((name) => name !== '');
    let tripwires = [...defaultTripwires];
    const rawTripwires = fields['effortControl.tripwires'];
    if (rawTripwires !== undefined) {
      const found = parseTripwires(rawTripwires);
      if (found.ok) tripwires = found.value;
      else invalid('effortControl.tripwires', found.why, tripwires.join(','));
    }
    let struggleDecay = defaultDecay;
    const rawDecay = fields['effortControl.struggleDecay'];
    if (rawDecay !== undefined) {
      const found = parseDecay(rawDecay);
      if (found.ok) struggleDecay = found.value;
      else invalid('effortControl.struggleDecay', `${JSON.stringify(rawDecay)} is ${found.why}`, String(defaultDecay));
    }
    return { floor, ceiling, landing, judge: flag('judge', defaultJudge), tripwires, struggleDecay };
  }

  private async fields(path: string, type: string, report: (line: string) => void): Promise<Record<string, string> | 'failed'> {
    try {
      return parseFrontmatter(await this.fs.read(path));
    } catch (error) {
      report(`effort-live-control: reading ${path} failed: ${message(error)}; treating ${type} as having no definition`);
      return 'failed';
    }
  }

  private index(report: (line: string) => void): Promise<Map<string, string>> {
    this.nameIndex ??= (async () => {
      const names = new Map<string, string>();
      for (const dir of this.dirs) {
        let files: string[] = [];
        try {
          if (!(await this.fs.exists(dir))) continue;
          files = await this.fs.listMarkdown(dir);
        } catch (error) {
          this.log(`effort-live-control: listing ${dir} failed: ${message(error)}; its agents are found by file name only`);
          continue;
        }
        for (const file of files) {
          const path = join(dir, file);
          let name: string | undefined;
          try {
            name = parseFrontmatter(await this.fs.read(path)).name;
          } catch (error) {
            this.log(`effort-live-control: reading ${path} failed: ${message(error)}; skipping it in the name index`);
          }
          if (name && !names.has(name)) names.set(name, path);
        }
      }
      return names;
    })();
    return this.nameIndex;
  }
}
