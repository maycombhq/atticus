import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isScalar, isSeq, parse, parseDocument, stringify, type Document } from "yaml";
import { bundledOpenSpecBin, openspecEnv } from "./adapter.js";

/**
 * OpenSpec stores (beta; ADR 0126, an addendum to ADR 0006). A store is an `openspec/` folder in
 * its own Git repo, marked by `.openspec-store/store.yaml`; a code repo names stores it reads
 * under `references:` in its `openspec/config.yaml`. Atticus only writes the marker (to make a
 * metarepo a store, when asked) and adds one `references:` entry (at hand-down, when the org pack
 * asks); it reads stores read-only. It never registers, clones, pulls or pushes a store.
 *
 * The format is beta and may change, so everything about it is in this one file and every read
 * is tolerant: an unknown version or extra key is a note, never a failure.
 *
 * The shape of store.yaml is OpenSpec 1.14.0's (`dist/core/store/foundation.js`,
 * `MetadataStateSchema`, a strict object): `version: 1`, `id` (kebab-case, the store's name) and
 * an optional `remote`. Ids follow its `KEBAB_ID_REGEX` (`dist/core/id.js`). A references entry
 * is a store id, or `{ id, remote }` (`dist/core/project-config.js`, `parseDeclarationList`).
 */

/** The marker's folder and file, relative to the store's root (the folder holding openspec/). */
export const STORE_MARKER_DIR = ".openspec-store";
export const STORE_MARKER = `${STORE_MARKER_DIR}/store.yaml`;
/** The store.yaml version this Atticus writes and fully understands. */
export const STORE_MARKER_VERSION = 1;

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface StoreMarker {
  /** The store's name: kebab-case. */
  id: string;
  /** Where teammates clone it from, when known. */
  remote?: string;
}

/** A store id OpenSpec accepts made from a name (an org pack name): undefined when none can be. */
export function storeIdOf(name: string): string | undefined {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id && KEBAB.test(id) ? id : undefined;
}

/** store.yaml's text for a marker. Throws on an id OpenSpec would refuse. */
export function storeMarkerText(m: StoreMarker): string {
  if (!KEBAB.test(m.id))
    throw new Error(
      `"${m.id}" can't be an OpenSpec store id: it must be kebab-case (lowercase letters, numbers, single hyphens)`,
    );
  return stringify({
    version: STORE_MARKER_VERSION,
    id: m.id,
    ...(m.remote ? { remote: m.remote } : {}),
  });
}

/**
 * Read store.yaml's text, tolerantly: the id and remote of any version, with a note when the
 * version isn't one this Atticus knows. Never throws.
 */
export function parseStoreMarker(text: string): { marker?: StoreMarker; notes: string[] } {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    return { notes: [`store.yaml isn't YAML: ${(e as Error).message.split("\n")[0]}`] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { notes: ["store.yaml isn't a mapping"] };
  const o = raw as Record<string, unknown>;
  const notes: string[] = [];
  if (o.version !== STORE_MARKER_VERSION)
    notes.push(
      `store.yaml is version ${String(o.version ?? "(none)")}, newer than the version ${STORE_MARKER_VERSION} Atticus knows; read its id and remote only (the store format is beta)`,
    );
  if (typeof o.id !== "string" || !o.id) return { notes: [...notes, "store.yaml has no id"] };
  return {
    marker: {
      id: o.id,
      ...(typeof o.remote === "string" && o.remote ? { remote: o.remote } : {}),
    },
    notes,
  };
}

/** A folder's store.yaml: `missing` when there is none. Never throws. */
export async function readStoreMarker(
  dir: string,
): Promise<{ marker?: StoreMarker; notes: string[]; missing: boolean }> {
  let text: string;
  try {
    text = await readFile(join(dir, STORE_MARKER_DIR, "store.yaml"), "utf8");
  } catch {
    return { missing: true, notes: [] };
  }
  return { ...parseStoreMarker(text), missing: false };
}

/**
 * Write store.yaml in a folder when it has none. One that is there is never replaced: `present`
 * when it says the same id, `differs` when it names another (its marker is returned).
 */
export async function writeStoreMarker(
  dir: string,
  m: StoreMarker,
): Promise<{ action: "created" | "present" | "differs"; marker?: StoreMarker }> {
  const text = storeMarkerText(m);
  const have = await readStoreMarker(dir);
  if (!have.missing)
    return {
      action: have.marker?.id === m.id ? "present" : "differs",
      ...(have.marker ? { marker: have.marker } : {}),
    };
  await mkdir(join(dir, STORE_MARKER_DIR), { recursive: true });
  await writeFile(join(dir, STORE_MARKER_DIR, "store.yaml"), text, {
    encoding: "utf8",
    flag: "wx",
  });
  return { action: "created", marker: { id: m.id, ...(m.remote ? { remote: m.remote } : {}) } };
}

/**
 * Add a store to `references:` in an openspec/config.yaml's text, keeping its comments, order
 * and every other key. An entry for the id that is there already (plain or with a remote) is
 * left as it is. A file that isn't a mapping, or whose references isn't a list, is not changed.
 */
export function addStoreReference(
  text: string,
  ref: StoreMarker,
): { text: string; action: "added" | "present" } | { problem: string } {
  const parsed = parseDocument(text);
  if (parsed.errors.length)
    return {
      problem: `openspec/config.yaml isn't YAML: ${parsed.errors[0]!.message.split("\n")[0]}`,
    };
  // An empty file is an empty mapping; the document is edited as a plain one from here.
  const doc = parsed as unknown as Document;
  if (doc.contents === null || doc.contents === undefined) doc.contents = doc.createNode({});
  if (!isMap(doc.contents))
    return { problem: "openspec/config.yaml isn't a mapping; left as it is" };
  const entry = ref.remote ? { id: ref.id, remote: ref.remote } : ref.id;
  const list = doc.get("references", true);
  if (list === undefined || list === null || (isScalar(list) && list.value === null)) {
    doc.set("references", doc.createNode([entry]));
    return { text: doc.toString(), action: "added" };
  }
  if (!isSeq(list))
    return { problem: "references: in openspec/config.yaml isn't a list; left as it is" };
  const idOf = (item: unknown): unknown =>
    isScalar(item) ? item.value : isMap(item) ? item.get("id") : undefined;
  if (list.items.some((i) => idOf(i) === ref.id)) return { text, action: "present" };
  list.add(doc.createNode(entry));
  return { text: doc.toString(), action: "added" };
}

export interface StoreChangeEntry {
  id: string;
  /** The proposal's first heading. */
  title?: string;
  /** Ticked and all checkboxes in tasks.md. */
  tasks?: { done: number; total: number };
  dir: string;
}

export interface StoreSpecEntry {
  id: string;
  /** The first line of the spec's Purpose section. */
  purpose?: string;
  file: string;
}

/** What Atticus reads from a store: never more than names, titles, task counts and purposes. */
export interface StoreView {
  /** The store's root (the folder holding openspec/ and .openspec-store/). */
  dir: string;
  /** From store.yaml, when it has one. */
  id?: string;
  remote?: string;
  /** Open changes (not archive/), by id. */
  changes: StoreChangeEntry[];
  specs: StoreSpecEntry[];
  /** What couldn't be read, or was read with a caveat. */
  notes: string[];
}

const isDir = (p: string) =>
  stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );

async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The first line of a spec's Purpose section: outside code fences, with a heading's closing
 * hashes allowed (as OpenSpec reads it for its references index).
 */
export function purposeLine(markdown: string): string | undefined {
  let fence: string | undefined;
  let inPurpose = false;
  for (const line of markdown.split(/\r?\n/)) {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) {
      if (fence === undefined) fence = f[1];
      else if (f[1] === fence) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const h = /^#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (h) {
      if (inPurpose) return undefined;
      inPurpose = h[1]!.trim().toLowerCase() === "purpose";
      continue;
    }
    if (inPurpose && line.trim()) return line.trim();
  }
  return undefined;
}

/**
 * Read a store, read-only: its store.yaml (when there is one), its open changes and its specs.
 * Never throws and never writes; what can't be read becomes a note.
 */
export async function readStore(dir: string): Promise<StoreView> {
  const view: StoreView = { dir, changes: [], specs: [], notes: [] };
  if (!(await isDir(dir))) {
    view.notes.push(`${dir} isn't there`);
    return view;
  }
  const m = await readStoreMarker(dir);
  if (m.missing) view.notes.push(`no ${STORE_MARKER}: read as a plain OpenSpec folder`);
  view.notes.push(...m.notes);
  if (m.marker) {
    view.id = m.marker.id;
    if (m.marker.remote) view.remote = m.marker.remote;
  }
  const os = join(dir, "openspec");
  if (!(await isDir(os))) {
    view.notes.push("no openspec/ folder: nothing to read");
    return view;
  }
  for (const id of await subdirs(join(os, "changes"))) {
    if (id === "archive") continue;
    const cdir = join(os, "changes", id);
    const proposal = await readFile(join(cdir, "proposal.md"), "utf8").catch(() => "");
    const title = /^#\s+(.+?)\s*#*\s*$/m.exec(proposal)?.[1];
    const tasks = await readFile(join(cdir, "tasks.md"), "utf8").catch(() => undefined);
    const boxes = tasks ? [...tasks.matchAll(/^\s*[-*]\s+\[([ xX])\]/gm)].map((x) => x[1]) : [];
    view.changes.push({
      id,
      ...(title ? { title } : {}),
      ...(boxes.length
        ? { tasks: { done: boxes.filter((b) => b !== " ").length, total: boxes.length } }
        : {}),
      dir: cdir,
    });
  }
  for (const id of await subdirs(join(os, "specs"))) {
    const file = join(os, "specs", id, "spec.md");
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const purpose = purposeLine(text);
    view.specs.push({ id, ...(purpose ? { purpose } : {}), file });
  }
  return view;
}

/**
 * Whether an OpenSpec CLI has stores (`openspec store --help` runs). The bundled, pinned one by
 * default. Offline: no telemetry, no update check.
 */
export function openspecHasStores(
  o: { bin?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<boolean> {
  return new Promise((done) => {
    let bin: string;
    try {
      bin = o.bin ?? bundledOpenSpecBin();
    } catch {
      done(false);
      return;
    }
    execFile(
      process.execPath,
      [bin, "store", "--help"],
      {
        env: openspecEnv(o.env),
        timeout: o.timeoutMs ?? 30_000,
        windowsHide: true,
        encoding: "utf8",
      },
      (err, stdout) => done(!err && /\bregister\b/.test(stdout)),
    );
  });
}
