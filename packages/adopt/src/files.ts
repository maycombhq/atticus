import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

/** Small file helpers shared by init, adopt, absorb and unadopt. Paths returned are POSIX. */

export const toPosix = (p: string) => p.split(sep).join("/");

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function readText(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
  } catch {
    return undefined;
  }
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Folders never walked: VCS data and dependencies. */
export const WALK_SKIP = new Set([".git", "node_modules"]);

/**
 * Every file under `dir`, as sorted POSIX paths relative to it. Symbolic links are not
 * followed. `skip` names folders (by path relative to `dir`, or by name anywhere) to leave out.
 */
export async function listFiles(
  dir: string,
  o: { skipNames?: ReadonlySet<string>; skipPaths?: readonly string[] } = {},
): Promise<string[]> {
  const out: string[] = [];
  const skipNames = o.skipNames ?? WALK_SKIP;
  const skipPaths = new Set(o.skipPaths ?? []);
  async function walk(abs: string) {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = join(abs, e.name);
      const rel = toPosix(relative(dir, full));
      if (e.isDirectory()) {
        if (!skipNames.has(e.name) && !skipPaths.has(rel)) await walk(full);
      } else if (e.isFile()) out.push(rel);
    }
  }
  await walk(dir);
  return out.sort();
}

/** Every folder under `dir` (relative POSIX paths), for removing the ones a tool created. */
export async function listDirs(
  dir: string,
  skipNames: ReadonlySet<string> = WALK_SKIP,
): Promise<string[]> {
  const out: string[] = [];
  async function walk(abs: string) {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || skipNames.has(e.name)) continue;
      const full = join(abs, e.name);
      out.push(toPosix(relative(dir, full)));
      await walk(full);
    }
  }
  await walk(dir);
  return out.sort();
}

/** Hash every file under `dir`: the snapshot adopt keeps and the removal test compares. */
export async function hashTree(
  dir: string,
  o: { skipPaths?: readonly string[] } = {},
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await listFiles(dir, o)) out[f] = sha256(await readFile(join(dir, f)));
  return out;
}

/** Write a file, creating its folder; returns false (and writes nothing) when it exists and `keep` is set. */
export async function writeNew(path: string, text: string, keep = true): Promise<boolean> {
  if (keep && (await exists(path))) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
  return true;
}

export async function copyDir(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true, force: false, errorOnExist: false });
}

/** A lowercase slug safe as a record id: a-z, 0-9, '.', '_' and '-', starting with a letter or digit. */
export function slug(s: string): string {
  const v = s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/g, "")
    .slice(0, 100)
    .replace(/[-.]+$/, "");
  return v || "item";
}

/** Split `---` YAML front matter from a Markdown body. */
export function frontMatter(text: string): { data: string | undefined; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  return m ? { data: m[1]!, body: m[2]! } : { data: undefined, body: text };
}
