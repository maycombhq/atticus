import { cp, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { Desc } from "./commands.js";
import { commitCode, writeOrgPack, type Estate } from "./estate.js";
import { Model, type Changes } from "./model.js";
import type { Confirm, Outcome } from "./seam.js";

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
    const sorted = entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    const files = sorted.filter((e) => !e.isDirectory());
    const texts = await Promise.all(files.map((e) => readFile(join(d, e.name), "utf8")));
    files.forEach((e, i) => out.set(`${rel}${e.name}`, texts[i]!));
    for (const e of sorted) if (e.isDirectory()) await walk(join(d, e.name), `${rel}${e.name}/`);
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
  confidence?: string;
  raw?: string;
  [k: string]: unknown;
}

const parsed = new WeakMap<Map<string, string>, Map<string, Rec>>();
const parsedText = new Map<string, Rec | null>();

/** The records of a tree of files, by path (memoised: the checks read the same snap often). */
export function records(files: Map<string, string>): Map<string, Rec> {
  const hit = parsed.get(files);
  if (hit) return hit;
  const out = new Map<string, Rec>();
  for (const [path, text] of files) {
    let r = parsedText.get(text);
    if (r === undefined) {
      try {
        const p = parse(text) as Rec;
        r = p && typeof p === "object" && p.kind && p.id ? p : null;
      } catch {
        // A file a person broke by hand is still a file; it just isn't a record.
        r = null;
      }
      if (parsedText.size > 50_000) parsedText.clear();
      parsedText.set(text, r);
    }
    if (r) out.set(path, r);
  }
  parsed.set(files, out);
  return out;
}

/** A record as a removal listing names it: `<Kind>/<id>`. */
export const recId = (r: Pick<Rec, "kind" | "id">) => `${r.kind}/${r.id}`;

/** The repos a record's evidence names. */
export const repoOf = (r: Rec): Set<string> =>
  new Set((r.evidence ?? []).flatMap((e) => (e.repo ? [e.repo] : [])));

/** Paths whose bytes differ between two trees (added, removed or changed). */
export function changedPaths(a: Map<string, string>, b: Map<string, string>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].filter((p) => a.get(p) !== b.get(p)).sort();
}

export const sameTree = (a: Map<string, string>, b: Map<string, string>) =>
  changedPaths(a, b).length === 0;

/** A command a guard refused, kept so a confirmation can run it again (ADR point 4). */
export interface Pending {
  /** What a confirmation runs again: the refused command, as a rerun. */
  desc: Desc;
  /** The confirmations it was run with. */
  confirm: Confirm;
  removals?: { count: number; ids: string[] };
  edits?: string[];
  /** The command count when it was refused: a confirmation right after it must match exactly. */
  at: number;
}

/** A write that changed a byte: what `atticus catalog undo` takes back (ADR point 7). */
export interface UndoEntry {
  desc: Desc;
  before: Snap;
  after: Snap;
  /** The model before the command, and what the write explained. */
  model: Model;
  changes: Changes;
}

/** Rename a folder, retrying a while on Windows, where a scan's handles can hold it briefly. */
export async function move(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}

/** The temporary metarepo of one sequence, and the clones of its repos. */
export class World {
  readonly root: string;
  /** The building command to run again for `again`: the last that wrote, nothing acted since. */
  lastWriter: Desc | undefined;
  /** The last command a guard refused, waiting for its confirmation. */
  pending: Pending | undefined;
  /** The writes that changed a byte, latest last, at most five: what undo takes back. */
  undoable: UndoEntry[] = [];
  /** Commands that acted so far. */
  steps = 0;
  /** The outcome of the last command that called the system. */
  lastOutcome: Outcome | undefined;

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
    const commits = await Promise.all(
      estate.repos.map((r) => commitCode(join(root, "workspace", r.base.id), r.base, r.code, 0)),
    );
    const w = new World(top, new Model(estate, commits));
    await writeOrgPack(root, w.model.manifest());
    return w;
  }

  /** The same metarepo, clones and model, in a folder of its own. */
  async copy(): Promise<World> {
    const top = await mkdtemp(join(tmpdir(), "cs4-"));
    await cp(this.top, top, { recursive: true });
    const w = new World(top, this.model.clone());
    w.lastWriter = this.lastWriter;
    w.pending = this.pending && structuredClone(this.pending);
    w.undoable = [...this.undoable];
    w.steps = this.steps;
    return w;
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
