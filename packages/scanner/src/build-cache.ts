import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cmpText, writeFileAtomic } from "@maycombhq/core";
import { BUILD_VERSION, SLOT_VERSION } from "./slots.js";

/**
 * The build cache of ADR 0195 point 9, in `.index/build-cache/` of the state folder: local,
 * git-ignored, and never needed for a correct result (a build without it gives the same bytes;
 * the property tests and build-cache.test.ts check that). It keeps three things:
 *
 * - `readers.json`: the readers slots already checked, by the hash of their bytes and their repo.
 *   A slot whose checked records are exactly its JSON (as every slot a writer wrote is) reads as
 *   its JSON next time, without the record checks.
 * - `last-build.jsonl`: the last build, whole, with the key of everything it was built from. A
 *   build whose key is the same returns it without running the passes (an unchanged build).
 * - in the same file, each record file's text with the hash of its record's JSON: a build with
 *   one slot changed writes YAML only for the records that changed.
 *
 * The key is the hash of every build input (each slot by the hash of its bytes, the rest as it
 * is in memory), the files the passes read themselves (the proposals, inputs/ and the wiki
 * folders, hashed again), the build's version and a stamp of the code that builds. A build with
 * federated catalogs is never kept: their folders are read outside the inputs.
 */

/** Bumped when what the cache holds changes shape. */
export const BUILD_CACHE_FORMAT = 1;

/** A test's switch: with `off`, nothing is read from or written to the cache. */
export const buildCacheHooks: { off?: boolean } = {};

const stats = { memoHits: 0, memoMisses: 0, textsReused: 0, readersTrusted: 0 };
/** How often the cache was used in this process (tests and the benchmark read it). */
export function buildCacheStats(): typeof stats {
  return { ...stats };
}

export function buildCacheDirOf(stateDir: string): string {
  return join(stateDir, ".index", "build-cache");
}

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// ------------------------------------------------------------------ the code's stamp

let stamp: string | undefined;
/**
 * A hash of the built code of the packages a build runs (their dist folders), so a cache made by
 * other code is never used, even at the same build version (a developer's build, say).
 */
function codeStamp(): string {
  if (stamp !== undefined) return stamp;
  const h = createHash("sha256");
  h.update(`${BUILD_VERSION}\u0000${SLOT_VERSION}\u0000${BUILD_CACHE_FORMAT}\u0000`);
  const here = dirname(fileURLToPath(import.meta.url));
  const dirs = new Set<string>([here]);
  for (const p of [
    "@maycombhq/core",
    "@maycombhq/features",
    "@maycombhq/glossary",
    "@maycombhq/extractors",
    "@maycombhq/intake",
    "@maycombhq/ingestors",
  ])
    try {
      dirs.add(dirname(fileURLToPath(import.meta.resolve(p))));
    } catch {
      h.update(`${p}\u0000unresolved\u0000`);
    }
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d).sort(cmpText);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      if (/\.(js|ts|mjs)$/.test(n) && !n.endsWith(".d.ts")) {
        try {
          h.update(`${p}\u0000${sha(readFileSync(p, "utf8"))}\u0000`);
        } catch {
          walk(p);
        }
      } else if (!n.includes(".")) walk(p);
    }
  };
  for (const d of [...dirs].sort(cmpText)) walk(d);
  stamp = h.digest("hex");
  return stamp;
}

// ------------------------------------------------------------------ encoding

class Unkeepable extends Error {}
const MAP = "\u0000map";
const SET = "\u0000set";
const UNDEF = "\u0000undefined";

/** JSON that keeps Maps, Sets and fields set to undefined; anything else not plain can't be kept. */
export function encodeKept(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v === undefined) return { [UNDEF]: 1 };
    if (v instanceof Map) return { [MAP]: [...v] };
    if (v instanceof Set) return { [SET]: [...v] };
    if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint")
      throw new Unkeepable(typeof v);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new Unkeepable("a class instance");
    }
    return v;
  });
}

export function decodeKept(text: string): unknown {
  return revive(JSON.parse(text));
}

function revive(v: unknown): unknown {
  if (Array.isArray(v)) {
    for (let k = 0; k < v.length; k++) v[k] = revive(v[k]);
    return v;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1) {
      if (keys[0] === UNDEF) return undefined;
      if (keys[0] === MAP) return new Map((revive(o[MAP]) as [unknown, unknown][]) ?? []);
      if (keys[0] === SET) return new Set((revive(o[SET]) as unknown[]) ?? []);
    }
    for (const k of keys) o[k] = revive(o[k]);
    return o;
  }
  return v;
}

/** The same JSON value, key order and fields set to undefined included. */
export function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let k = 0; k < a.length; k++) if (!sameJsonValue(a[k], b[k])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  if (
    Object.getPrototypeOf(a) !== Object.prototype ||
    Object.getPrototypeOf(b) !== Object.prototype
  )
    return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (let k = 0; k < ka.length; k++) {
    if (ka[k] !== kb[k]) return false;
    if (
      !sameJsonValue((a as Record<string, unknown>)[ka[k]!], (b as Record<string, unknown>)[ka[k]!])
    )
      return false;
  }
  return true;
}

// ------------------------------------------------------------------ readers slots checked

/** `readers/` of the state folder whose build loaded last: each checked read, by its key. */
let readersDir: string | undefined;
/** The keys read or checked since that load (what the cache keeps). */
const used = new Set<string>();
/** Checked reads not on disk yet, by key: their JSON. */
const fresh = new Map<string, string>();
const FRESH_MAX = 512;

/** A readers slot's key: its repo and the hash of its bytes (and the code that checks it). */
export const readersKeyOf = (repo: string | undefined, textSha: string) =>
  sha(`${BUILD_CACHE_FORMAT}\u0000${codeStamp()}\u0000${repo ?? ""}\u0000${textSha}`);

/** The slot of this key as it was read and checked before, or undefined. */
export function keptReaders(key: string): unknown {
  if (buildCacheHooks.off) return undefined;
  let json = fresh.get(key);
  if (json === undefined && readersDir)
    try {
      json = readFileSync(join(readersDir, `${key}.json`), "utf8");
    } catch {
      return undefined;
    }
  if (json === undefined) return undefined;
  try {
    const v = JSON.parse(json) as unknown;
    used.add(key);
    stats.readersTrusted++;
    return v;
  } catch {
    return undefined;
  }
}

/** Keep a slot as read and checked, when its JSON gives it back exactly (no class, no undefined). */
export function keepReaders(key: string, slot: unknown): void {
  if (buildCacheHooks.off) return;
  const json = JSON.stringify(slot);
  if (!sameJsonValue(slot, JSON.parse(json))) return;
  if (fresh.size >= FRESH_MAX) fresh.clear();
  fresh.set(key, json);
  used.add(key);
}

/** Before a build reads its slots: the state folder whose cache it reads. */
export async function loadReadersTrust(stateDir: string): Promise<void> {
  used.clear();
  readersDir = buildCacheHooks.off ? undefined : join(buildCacheDirOf(stateDir), "readers");
  await Promise.resolve();
}

/** Write the checked reads this build used and take away those it didn't. */
async function keepReadersOnDisk(stateDir: string): Promise<void> {
  const dir = join(buildCacheDirOf(stateDir), "readers");
  for (const key of [...used].sort(cmpText)) {
    const json = fresh.get(key);
    if (json === undefined) continue;
    await writeFileAtomic(join(dir, `${key}.json`), json);
    fresh.delete(key);
  }
  for (const n of await readdir(dir).catch(() => [] as string[]))
    if (!used.has(n.replace(/\.json$/, "")) && /^[0-9a-f]{64}\.json$/.test(n))
      await rm(join(dir, n), { force: true });
}

// ------------------------------------------------------------------ the last build, kept

/** The texts of the last build's record files, by the hash of their record's JSON. */
export type KeptTexts = Map<string, string>;

const MEMO = "last-build.jsonl";
/** The build's own field order, in the kept meta. */
const ORDER = "\u0000order";

export interface KeptBuild<B> {
  key: string;
  build: B;
}

interface MemoHeader {
  format: number;
  stamp: string;
  key: string;
  records: number;
  files: number;
}

/** Hash a folder's files in path order (what the passes read of it), or a marker when none. */
async function folderHash(dir: string): Promise<string> {
  const lines: string[] = [];
  async function walk(d: string, rel: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => cmpText(a.name, b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(d, e.name), r);
      else if (e.isFile())
        lines.push(`${r}\u0000${sha(await readFile(join(d, e.name), "utf8").catch(() => ""))}`);
    }
  }
  await walk(dir, "");
  return sha(lines.join("\n"));
}

const isUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);

/**
 * The key of a build: everything it reads. `inputs` is the build's inputs object as it is (each
 * slot replaced by the hash of its bytes); `folders` are what the passes read themselves.
 * Undefined when the build can't be kept (the cache is off, or an input isn't plain data).
 */
export async function buildKeyOf(o: {
  inputs: Record<string, unknown>;
  slots: unknown;
  proposalsDir: string;
  orgPackDir: string;
  wikis: readonly { id: string; type: string; location: string }[];
  /** Other files the passes read themselves (a repo's corrections, read again for its pairs). */
  files?: readonly string[];
}): Promise<string | undefined> {
  if (buildCacheHooks.off) return undefined;
  const folders: [string, string][] = [];
  folders.push(["proposals", await folderHash(o.proposalsDir)]);
  const inputsDir = o.inputs.inputsDir;
  if (typeof inputsDir === "string") folders.push(["inputs", await folderHash(inputsDir)]);
  for (const w of o.wikis)
    if (!isUrl(w.location)) {
      const dir = isAbsolute(w.location) ? w.location : resolve(o.orgPackDir, w.location);
      folders.push([`wiki ${w.id}`, await folderHash(dir)]);
    }
  for (const f of [...(o.files ?? [])].sort(cmpText))
    folders.push([f, sha(await readFile(f, "utf8").catch(() => "\u0000absent"))]);
  const rest: Record<string, unknown> = {};
  for (const k of Object.keys(o.inputs).sort(cmpText)) if (k !== "slots") rest[k] = o.inputs[k];
  try {
    return sha(
      encodeKept({
        format: BUILD_CACHE_FORMAT,
        stamp: codeStamp(),
        helpersOff: process.env.ATTICUS_HELPERS_OFF ?? null,
        slots: o.slots,
        inputs: rest,
        folders,
      }),
    );
  } catch (e) {
    if (e instanceof Unkeepable) return undefined;
    throw e;
  }
}

/** What a build loads of the last build: whole when its key is this one, else its texts. */
export async function loadKept<B>(
  stateDir: string,
  key: string | undefined,
): Promise<{ hit?: B; texts?: KeptTexts }> {
  if (buildCacheHooks.off) return {};
  const text = await readFile(join(buildCacheDirOf(stateDir), MEMO), "utf8").catch(() => undefined);
  if (!text) return {};
  try {
    const lines = text.split("\n");
    const h = JSON.parse(lines[0]!) as MemoHeader;
    if (h.format !== BUILD_CACHE_FORMAT || h.stamp !== codeStamp()) return {};
    if (lines.length < 2 + h.records + h.files) return {};
    const fileLines = lines.slice(2 + h.records, 2 + h.records + h.files);
    if (key !== undefined && h.key === key) {
      const meta = decodeKept(lines[1]!) as Record<string, unknown>;
      if ("manifest" in meta) meta.manifest = unpackManifest(meta.manifest);
      const records = lines.slice(2, 2 + h.records).map((l) => decodeKept(l));
      const files = new Map<string, string>();
      for (const l of fileLines) {
        const [path, t] = JSON.parse(l) as [string, string, string];
        files.set(path, t);
      }
      const { [ORDER]: order, ...fields } = meta;
      // The build's own field order, records and files in their places.
      const all: Record<string, unknown> = { ...fields, records, files };
      const build: Record<string, unknown> = {};
      for (const k of order as string[]) build[k] = all[k];
      stats.memoHits++;
      return { hit: build as B };
    }
    stats.memoMisses++;
    const texts: KeptTexts = new Map();
    for (const l of fileLines) {
      const [, t, k] = JSON.parse(l) as [string, string, string];
      if (k) texts.set(k, t);
    }
    return { texts };
  } catch {
    return {};
  }
}

const PACKED = "\u0000packed";
const keysAre = (o: object, keys: readonly string[]) => {
  const k = Object.keys(o);
  return k.length === keys.length && k.every((x, n) => x === keys[n]);
};

/**
 * build.json as kept: most files share their list of sources (the repo's slot, every slot,
 * the inputs), so each list is kept once. Any other shape is kept as it is.
 */
function packManifest(m: unknown): unknown {
  const x = m as { files?: unknown };
  if (!m || typeof m !== "object" || !Array.isArray(x.files)) return m;
  const lists: unknown[][] = [];
  const at = new Map<string, number>();
  const files: [string, string, number][] = [];
  for (const f of x.files as { path: string; sha256: string; sources: unknown[] }[]) {
    if (!f || typeof f !== "object" || !keysAre(f, ["path", "sha256", "sources"])) return m;
    const srcs = f.sources as { path: string; sha256: string }[];
    if (!Array.isArray(srcs) || !srcs.every((s) => s && keysAre(s, ["path", "sha256"]))) return m;
    const key = srcs.map((s) => `${s.path}\u0000${s.sha256}`).join("\n");
    let n = at.get(key);
    if (n === undefined) {
      n = lists.length;
      lists.push(srcs);
      at.set(key, n);
    }
    files.push([f.path, f.sha256, n]);
  }
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) if (k !== "files") rest[k] = v;
  return { [PACKED]: { rest, order: Object.keys(m), lists, files } };
}

function unpackManifest(m: unknown): unknown {
  const p = (m as Record<string, unknown> | undefined)?.[PACKED] as
    | {
        rest: Record<string, unknown>;
        order: string[];
        lists: { path: string; sha256: string }[][];
        files: [string, string, number][];
      }
    | undefined;
  if (!p) return m;
  const files = p.files.map(([path, sha256, n]) => ({
    path,
    sha256,
    sources: p.lists[n]!.map((s) => ({ path: s.path, sha256: s.sha256 })),
  }));
  const all: Record<string, unknown> = { ...p.rest, files };
  const out: Record<string, unknown> = {};
  for (const k of p.order) out[k] = all[k];
  return out;
}

/** The hash a record's JSON is kept by (its text is a function of it). */
export const recordJsonKey = (json: string) => sha(json);

/** Note that a kept text was used (the statistics). */
export function textReused(): void {
  stats.textsReused++;
}

/** What a build stages for the cache, until its writer keeps it (a check keeps nothing). */
const staged = new WeakMap<object, { stateDir: string; key: string; keys: Map<string, string> }>();

export function stageKept(
  build: object,
  stateDir: string,
  key: string | undefined,
  keys: Map<string, string>,
): void {
  if (key === undefined || buildCacheHooks.off) return;
  staged.set(build, { stateDir, key, keys });
}

/**
 * Keep a build that was written (or refused: the cache is of what the inputs build, not of what
 * was written) and the readers slots checked. Never fails a build: a cache that can't be
 * written is no cache.
 */
export async function keepBuild(
  build: { records: unknown[]; files: Map<string, string> } & Record<string, unknown>,
  stateDir: string,
): Promise<void> {
  if (buildCacheHooks.off) return;
  const dir = buildCacheDirOf(stateDir);
  try {
    await keepReadersOnDisk(stateDir).catch(() => undefined);
    const s = staged.get(build);
    if (!s) return;
    staged.delete(build);
    const order = Object.keys(build);
    const meta: Record<string, unknown> = { [ORDER]: order };
    for (const k of order)
      if (k !== "records" && k !== "files")
        meta[k] = k === "manifest" ? packManifest(build[k]) : build[k];
    const parts: string[] = [];
    const header: MemoHeader = {
      format: BUILD_CACHE_FORMAT,
      stamp: codeStamp(),
      key: s.key,
      records: build.records.length,
      files: build.files.size,
    };
    parts.push(JSON.stringify(header), encodeKept(meta));
    for (const r of build.records) parts.push(encodeKept(r));
    for (const [path, text] of build.files)
      parts.push(JSON.stringify([path, text, s.keys.get(path) ?? ""]));
    await writeFileAtomic(join(dir, MEMO), `${parts.join("\n")}\n`);
  } catch {
    // A build that can't be kept (too big for one string, not plain data) or a cache that can't
    // be written is no cache: the last build kept, now out of date, is taken away.
    await rm(join(dir, MEMO), { force: true }).catch(() => undefined);
  }
}
