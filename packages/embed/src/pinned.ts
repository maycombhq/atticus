import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readTarGz } from "@maycombhq/core";

/**
 * Pinned files for the packages that carry the embedding model and its runtime (ADR 0116
 * addendum): each file a package publishes comes from one pinned source (a URL at an exact
 * revision, or one entry of a pinned npm tarball) and is checked against a sha256 committed in
 * the package's `pins.json`. Fetched only when a package is packed for publishing (`prepack`,
 * `pnpm model:fetch`), cached by sha256 so a second run downloads nothing. Never at run time,
 * in a test or in an install.
 */

export interface PinSource {
  url: string;
  sha256: string;
  /** What it is, for a person reading pins.json. */
  what?: string;
}

export interface PinnedFile {
  /** Where it goes in the package. */
  path: string;
  /** The source it comes from (a key of `sources`). */
  source: string;
  /** The entry inside the source, when the source is a .tgz (npm's package/ prefix dropped). */
  entry?: string;
  sha256: string;
}

export interface Pins {
  sources: Record<string, PinSource>;
  files: PinnedFile[];
}

export const sha256Of = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export class PinError extends Error {
  override name = "PinError";
}

/** Throws when the bytes aren't the pinned ones. */
export function checkPinned(bytes: Uint8Array, sha256: string, what: string): void {
  const got = sha256Of(bytes);
  if (got !== sha256)
    throw new PinError(`${what} has sha256 ${got}, not the pinned ${sha256}: refused`);
}

/** How a source is downloaded: `fetch` by default; tests pass their own. */
export type Getter = (url: string) => Promise<Uint8Array>;

export const httpGet: Getter = async (url) => {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new PinError(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

/**
 * A pinned source's bytes: from the cache (`<cacheDir>/<sha256>`) when it is there and still
 * matches, else downloaded once, checked, and kept.
 */
export async function fetchSource(
  src: PinSource,
  o: { cacheDir: string; get?: Getter; offline?: boolean },
): Promise<{ bytes: Uint8Array; cached: boolean }> {
  const file = join(o.cacheDir, src.sha256);
  const kept = await readFile(file).catch(() => undefined);
  if (kept && sha256Of(kept) === src.sha256) return { bytes: kept, cached: true };
  if (o.offline) throw new PinError(`${src.url} isn't in the cache and this run may not download`);
  const bytes = await (o.get ?? httpGet)(src.url);
  checkPinned(bytes, src.sha256, src.url);
  await mkdir(o.cacheDir, { recursive: true });
  await writeFile(`${file}.part`, bytes);
  await rename(`${file}.part`, file);
  return { bytes, cached: false };
}

/** Every pinned file of a package written into its folder, each checked. */
export async function materialize(
  dir: string,
  pins: Pins,
  o: { cacheDir: string; get?: Getter; offline?: boolean },
): Promise<{ written: string[]; downloaded: string[] }> {
  const downloaded: string[] = [];
  const bySource = new Map<string, Uint8Array>();
  const sourceBytes = async (name: string) => {
    let b = bySource.get(name);
    if (b) return b;
    const src = pins.sources[name];
    if (!src) throw new PinError(`pins.json names no source ${name}`);
    const r = await fetchSource(src, o);
    if (!r.cached) downloaded.push(src.url);
    bySource.set(name, (b = r.bytes));
    return b;
  };
  const archives = new Map<string, ReturnType<typeof readTarGz>>();
  const written: string[] = [];
  for (const f of pins.files) {
    if (f.path.split(/[\\/]/).includes("..")) throw new PinError(`${f.path} leaves the package`);
    let bytes: Uint8Array;
    if (f.entry) {
      let a = archives.get(f.source);
      if (!a)
        archives.set(
          f.source,
          (a = readTarGz(await sourceBytes(f.source), {
            maxEntries: 20_000,
            maxEntryBytes: 256 * 1024 * 1024,
            maxTotalBytes: 1024 * 1024 * 1024,
          })),
        );
      const e = a.read(f.entry);
      if (!e) throw new PinError(`${f.source} has no ${f.entry}`);
      bytes = e;
    } else bytes = await sourceBytes(f.source);
    checkPinned(bytes, f.sha256, f.path);
    const out = join(dir, ...f.path.split("/"));
    const was = await readFile(out).catch(() => undefined);
    if (!was || sha256Of(was) !== f.sha256) {
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, bytes);
    }
    written.push(f.path);
  }
  return { written, downloaded };
}

/** The pinned files that are missing from a package's folder or don't match. Reads only. */
export async function checkMaterialized(dir: string, pins: Pins): Promise<string[]> {
  const bad: string[] = [];
  for (const f of pins.files) {
    const b = await readFile(join(dir, ...f.path.split("/"))).catch(() => undefined);
    if (!b || sha256Of(b) !== f.sha256) bad.push(f.path);
  }
  return bad;
}
