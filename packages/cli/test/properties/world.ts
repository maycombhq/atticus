import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { commitCode, writeOrgPack, type Estate } from "./estate.js";
import { Model } from "./model.js";

/** Every file under a folder, by its path from there (forward slashes), with its text. */
export async function readTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(d: string, rel: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isDirectory()) await walk(join(d, e.name), `${rel}${e.name}/`);
      else out.set(`${rel}${e.name}`, await readFile(join(d, e.name), "utf8"));
    }
  }
  await walk(dir, "");
  return out;
}

/** What the invariants compare: the catalog, the slots, the facts, the curated decisions. */
export interface Snap {
  generated: Map<string, string>;
  /** catalog/sources: the slots and build.json (none today). */
  sources: Map<string, string>;
  /** The assistant's facts folder (its live files and their companions). */
  facts: Map<string, string>;
  curated: Map<string, string>;
  /** .index/build-undo: the undo copies (none today). */
  undo: Map<string, string>;
}

/** A catalog record as its file holds it, with what the checks read of it. */
export interface Rec {
  kind: string;
  id: string;
  evidence?: { repo?: string; by?: string }[];
  from?: string;
  to?: string;
  method?: string;
  normalizedPath?: string;
  component?: string;
  pathOrTopic?: string;
  endpointType?: string;
  auth?: string;
  [k: string]: unknown;
}

export function records(files: Map<string, string>): Map<string, Rec> {
  const out = new Map<string, Rec>();
  for (const [path, text] of files) {
    try {
      const r = parse(text) as Rec;
      if (r && typeof r === "object" && r.kind && r.id) out.set(path, r);
    } catch {
      // A file a person broke by hand is still a file; it just isn't a record.
    }
  }
  return out;
}

/** The repos a record's evidence names. */
export const repoOf = (r: Rec): Set<string> =>
  new Set((r.evidence ?? []).flatMap((e) => (e.repo ? [e.repo] : [])));

/** Paths whose bytes differ between two trees (added, removed or changed). */
export function changedPaths(a: Map<string, string>, b: Map<string, string>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].filter((p) => a.get(p) !== b.get(p)).sort();
}

export const sameTree = (a: Map<string, string>, b: Map<string, string>) =>
  changedPaths(a, b).length === 0;

/** The temporary metarepo of one sequence, and the clones of its repos. */
export class World {
  readonly root: string;
  /** The writer last run and nothing changed since: what `again` repeats. */
  lastWriter: ((w: World) => Promise<unknown>) | undefined;
  /** The catalog before and after the last command that wrote and changed it: what undo restores. */
  lastWrite: { before: Snap; after: Snap } | undefined;

  private constructor(
    readonly top: string,
    readonly model: Model,
  ) {
    this.root = join(top, "metarepo");
  }

  /** A metarepo for the estate: its org pack, and each repo's clone at its first commit. */
  static async create(estate: Estate): Promise<World> {
    const top = await mkdtemp(join(tmpdir(), "cs4-"));
    const root = join(top, "metarepo");
    const commits: string[] = [];
    for (const r of estate.repos)
      commits.push(await commitCode(join(root, "workspace", r.base.id), r.base, r.code, 0));
    const w = new World(top, new Model(estate, commits));
    await writeOrgPack(root, w.model.manifest());
    return w;
  }

  /** The same metarepo, clones and model, in a folder of its own. */
  async copy(): Promise<World> {
    const top = await mkdtemp(join(tmpdir(), "cs4-"));
    await cp(this.top, top, { recursive: true });
    return new World(top, this.model.clone());
  }

  clone(id: string): string {
    return join(this.root, "workspace", id);
  }

  async snap(): Promise<Snap> {
    const at = (rel: string) => readTree(join(this.root, ...rel.split("/")));
    const [generated, sources, facts, curated, undo] = await Promise.all([
      at("catalog/generated"),
      at("catalog/sources"),
      at("facts"),
      at("catalog/curated"),
      at(".index/build-undo"),
    ]);
    return { generated, sources, facts, curated, undo };
  }

  async dispose(): Promise<void> {
    await rm(this.top, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
