/**
 * Reads the scalar keys of a markdown file's leading YAML frontmatter
 * (`---` ... `---`): `key: value` lines at column 0, and one level of nesting
 * under a key with no value of its own, read as `parent.child`. Lists and
 * block scalars are skipped. No frontmatter → {}.
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const fields: Record<string, string> = {};
  let parent: string | undefined;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '---') return fields;
    const top = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (top) {
      const value = scalar(top[2] ?? '');
      fields[top[1] as string] = value;
      parent = value === '' ? (top[1] as string) : undefined;
      continue;
    }
    const nested = /^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (nested && parent !== undefined) fields[`${parent}.${nested[1]}`] = scalar(nested[2] ?? '');
  }
  return {}; // unterminated: not frontmatter
}

function scalar(raw: string): string {
  const value = raw.trim();
  if (/^(["']).*\1$/.test(value)) return value.slice(1, -1);
  return value.replace(/\s+#.*$/, '');
}
