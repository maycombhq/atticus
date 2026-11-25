import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** RFC 4180 CSV rows with the line each starts on (work-item and service-request exports). */
export function parseCsv(s: string): { cells: string[]; line: number }[] {
  const rows: { cells: string[]; line: number }[] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else {
        if (c === "\n") line++;
        cell += c;
      }
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push({ cells: row, line: rowLine });
      row = [];
      cell = "";
      line++;
      rowLine = line;
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push({ cells: row, line: rowLine });
  return rows;
}

/**
 * The exports of one kind under inputs/, in path order: each file `read` takes (paths are
 * relative to the metarepo root and start with inputs/). Files only, never a link to one.
 */
export async function readExports<T>(
  o: { root: string; inputsDir?: string },
  read: (path: string, bytes: Uint8Array) => T[] | undefined,
): Promise<{ found: T[]; files: string[]; problems: { path: string; message: string }[] }> {
  const dir = o.inputsDir ?? join(o.root, "inputs");
  const files: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.name.startsWith(".")) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      // Files only: an export that is a link to a file elsewhere isn't read.
      else if (e.isFile() && /\.(json|ya?ml|csv)$/i.test(e.name)) files.push(full);
    }
  }
  await walk(dir);
  const out = {
    found: [] as T[],
    files: [] as string[],
    problems: [] as { path: string; message: string }[],
  };
  for (const full of files) {
    const path = `inputs/${relative(dir, full).split(sep).join("/")}`;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(full));
    } catch (e) {
      out.problems.push({ path, message: `can't read it: ${(e as Error).message}` });
      continue;
    }
    const items = read(path, bytes);
    if (!items) continue;
    out.files.push(path);
    out.found.push(...items);
  }
  return out;
}
