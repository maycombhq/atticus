import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { ChangeLifecycle, toCanonicalYaml } from "@maycombhq/core";

/** Where OpenSpec keeps changes in the metarepo; `archive/` under it holds archived ones. */
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

export function changeFolder(root: string, id: string): string {
  return join(root, CHANGES_DIR, id);
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

/**
 * Write a file so a crash never leaves it half-written: write a temporary file beside it,
 * then rename it over the old one (a rename within a folder is atomic on every platform
 * Atticus supports).
 */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

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
        names = (await readdir(join(root, CHANGES_DIR), { withFileTypes: true }))
          .filter((d) => d.isDirectory() && d.name !== "archive")
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
