import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  ChangeLifecycle,
  changesDirOf,
  RecordId,
  toCanonicalYaml,
  writeFileAtomic,
} from "@maycombhq/core";

/**
 * Where OpenSpec keeps changes in a metarepo made by `atticus init`; `archive/` under it
 * holds archived ones. Code resolves the real folder through the layout (`changesDirOf` and
 * `changesRelOf` in core), which a repo adopted in place may move (e.g. into `.atticus/`).
 */
export const CHANGES_DIR = "openspec/changes";
export const CHANGE_FILE = "change.yaml";

/** Keys printed first, in this order, at every level of change.yaml; the rest are alphabetical. */
const LEADING = [
  "schemaVersion",
  "id",
  "title",
  "type",
  "template",
  "phase",
  "state",
  "from",
  "to",
];

/** A name that is a path, not a folder: separators, `.`/`..`, a drive or nothing at all. */
const isPathLike = (id: string) =>
  !id ||
  id === "." ||
  id === ".." ||
  /[\\/]/.test(id) ||
  /^[A-Za-z]:/.test(id) ||
  id.includes("\0");

/** A change folder, or an archived one as `archive/<folder>` (how archived reviews are read). */
const isFolderRef = (id: string) => {
  const parts = id.split("/");
  if (parts.length === 2 && parts[0] === "archive") return !isPathLike(parts[1]!);
  return !isPathLike(id);
};

export function changeFolder(root: string, id: string): string {
  // A folder name, never a path: nothing outside the changes folder is read or written through
  // it. (Any plain folder name is taken, as a stray folder in openspec/changes is listed and skipped.)
  if (!isFolderRef(id)) throw new Error(`${id} isn't a change id.`);
  return join(changesDirOf(root), id);
}

export function changeFilePath(root: string, id: string): string {
  return join(changeFolder(root, id), CHANGE_FILE);
}

export class ChangeFileError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "ChangeFileError";
  }
}

const describe = (issues: { path: PropertyKey[]; message: string }[]) =>
  issues.map((i) => `${i.path.map(String).join(".") || "(file)"}: ${i.message}`).join("; ");

/** Canonical text of a change file. Throws if the value breaks the schema. */
export function serializeChange(value: ChangeLifecycle): string {
  const r = ChangeLifecycle.safeParse(value);
  if (!r.success) throw new Error(`change ${value.id}: ${describe(r.error.issues)}`);
  return toCanonicalYaml(r.data, LEADING);
}

/** Kept here for the packages that import it from changes; it lives in core. */
export { writeFileAtomic };

export interface ChangeStore {
  readonly root: string;
  /** Throws ChangeFileError when the file is missing or invalid. */
  read(id: string): Promise<ChangeLifecycle>;
  /** Undefined when the change has no change.yaml. */
  tryRead(id: string): Promise<ChangeLifecycle | undefined>;
  write(value: ChangeLifecycle): Promise<string>;
  /** Every change with a change.yaml, in id order. Archived folders are not listed. */
  list(): Promise<ChangeLifecycle[]>;
}

export function changeStore(root: string): ChangeStore {
  async function tryRead(id: string): Promise<ChangeLifecycle | undefined> {
    // Not an id (a stray folder, a mistyped argument): no change, as for a folder with no change.yaml.
    if (!RecordId.safeParse(id).success) return undefined;
    const path = changeFilePath(root, id);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return undefined;
    }
    let data: unknown;
    try {
      data = parse(text);
    } catch (e) {
      throw new ChangeFileError(`${path}: invalid YAML: ${(e as Error).message}`, path);
    }
    const r = ChangeLifecycle.safeParse(data);
    if (!r.success) throw new ChangeFileError(`${path}: ${describe(r.error.issues)}`, path);
    if (r.data.id !== id)
      throw new ChangeFileError(`${path}: says change ${r.data.id}, expected ${id}`, path);
    return r.data;
  }

  return {
    root,
    tryRead,
    async read(id) {
      const c = await tryRead(id);
      if (!c) {
        const path = changeFilePath(root, id);
        throw new ChangeFileError(`No change ${id}: ${path} doesn't exist.`, path);
      }
      return c;
    },
    async write(value) {
      const path = changeFilePath(root, value.id);
      await writeFileAtomic(path, serializeChange(value));
      return path;
    },
    async list() {
      let names: string[];
      try {
        names = (await readdir(changesDirOf(root), { withFileTypes: true }))
          .filter(
            (d) => d.isDirectory() && d.name !== "archive" && RecordId.safeParse(d.name).success,
          )
          .map((d) => d.name)
          .sort();
      } catch {
        return [];
      }
      const out: ChangeLifecycle[] = [];
      for (const n of names) {
        const c = await tryRead(n);
        if (c) out.push(c);
      }
      return out;
    },
  };
}
