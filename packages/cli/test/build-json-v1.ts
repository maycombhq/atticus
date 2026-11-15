import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Of } from "@maycombhq/core";
import {
  manifestToV1,
  parseBuildManifest,
  serializeBuildManifest,
  serializeBuildManifestV1,
  undoDirOf,
} from "@maycombhq/scanner";

/**
 * ADR 0197: a metarepo as beta.28.1 built it, for the tests of a build.json of version 1. Each
 * build.json of version 2 a build of this Atticus wrote (catalog/sources/build.json, and in each
 * undo copy the build.json before and next-build.json) is written again as version 1, as
 * beta.28.1 wrote the same build, and each undo copy's record of build.json's hash after the
 * command (`undo.json`) is that of the version 1 it left. Nothing else changes.
 */

/**
 * A build.json's text of version 2 as version 1; any other text as it is. Each one is checked
 * to read back as the version 2 it came from, byte for byte (ADR 0197's round trip): every
 * world of the property tests, the goldens and the bench that writes one checks it.
 */
export function v1Of(text: string): string {
  const p = parseBuildManifest(text);
  if (!p.ok || (JSON.parse(text) as { version?: unknown }).version !== 2) return text;
  const v1 = serializeBuildManifestV1(manifestToV1(p.slot));
  const back = parseBuildManifest(v1);
  if (!back.ok || serializeBuildManifest(back.slot) !== text.replace(/\r\n?/g, "\n"))
    throw new Error("build.json's round trip, version 2 to 1 and back, differs");
  return v1;
}

const MANIFEST = "catalog/sources/build.json";

async function rewrite(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  const text = await readFile(path, "utf8");
  const v1 = v1Of(text);
  if (v1 !== text) await writeFile(path, v1);
  return v1;
}

/** Rewrite the metarepo's build.json and its undo copies' as beta.28.1 would have written them. */
export async function asBeta281(root: string): Promise<void> {
  await rewrite(join(root, ...MANIFEST.split("/")));
  const undo = await undoDirOf(root);
  for (const n of existsSync(undo) ? await readdir(undo) : []) {
    const dir = join(undo, n);
    await rewrite(join(dir, "files", ...MANIFEST.split("/")));
    const next = await rewrite(join(dir, "next-build.json"));
    const entryPath = join(dir, "undo.json");
    if (next === undefined || !existsSync(entryPath)) continue;
    const entry = JSON.parse(await readFile(entryPath, "utf8")) as {
      files: { path: string; after?: string | null }[];
    };
    for (const f of entry.files)
      if (f.path === MANIFEST && typeof f.after === "string") f.after = sha256Of(next);
    await writeFile(entryPath, JSON.stringify(entry, null, 2) + "\n");
  }
}
