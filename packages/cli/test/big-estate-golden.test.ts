import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { catalogDirOf } from "@maycombhq/core";
import { buildAndWrite } from "@maycombhq/scanner";
import { makeBigEstate } from "./big-estate.js";

/**
 * beta.28.1: a small generated estate (big-estate.ts: 6 repos in clusters of 3, 2 gateway
 * proxies, a few dozen entries each) built cold, its catalog's bytes pinned by digest: one per
 * record kind and one of build.json, with the number of each kind. The digests were recorded
 * from this branch, whose catalog the review of beta.28.1 found byte-identical with main's
 * (63869566) over 14,677 files; a change that moves one byte of any record shows here. After a
 * deliberate change of output, record them again: ATTICUS_GOLDEN_WRITE=1.
 */
const GOLDEN = join(import.meta.dirname, "golden", "big-estate.json");
let dir: string | undefined;
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function digests(root: string): Promise<Record<string, { files: number; sha256: string }>> {
  const generated = join(catalogDirOf(root), "generated");
  const files: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }))
      if (e.isDirectory()) await walk(join(d, e.name));
      else if (e.name.endsWith(".yaml")) files.push(join(d, e.name));
  };
  await walk(generated);
  const byKind = new Map<string, string[]>();
  for (const f of files.map((x) => relative(generated, x).split(sep).join("/")).sort()) {
    const kind = f.split("/")[0]!;
    byKind.set(kind, [...(byKind.get(kind) ?? []), f]);
  }
  const out: Record<string, { files: number; sha256: string }> = {};
  for (const [kind, paths] of [...byKind].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const h = createHash("sha256");
    for (const p of paths) h.update(`${p}\n`).update(await readFile(join(generated, p)));
    out[kind] = { files: paths.length, sha256: h.digest("hex") };
  }
  const manifest = await readFile(join(catalogDirOf(root), "sources", "build.json"));
  out["build.json"] = { files: 1, sha256: createHash("sha256").update(manifest).digest("hex") };
  return out;
}

describe("a generated estate's catalog, byte for byte (beta.28.1)", () => {
  it("builds the bytes recorded", async () => {
    dir = await mkdtemp(join(tmpdir(), "atticus-big-golden-"));
    const { root } = await makeBigEstate(dir, {
      repos: 6,
      clusters: 2,
      gateways: 2,
      entries: 40,
      calls: 30,
      tables: 4,
      settings: 10,
      routes: 10,
      checkouts: 0,
    });
    const b = await buildAndWrite(root, { command: "atticus catalog build" });
    expect(b.guard.refused).toBeUndefined();
    const now = await digests(root);
    if (process.env.ATTICUS_GOLDEN_WRITE)
      await writeFile(GOLDEN, JSON.stringify(now, null, 2) + "\n");
    expect(now).toEqual(JSON.parse(await readFile(GOLDEN, "utf8")));
    // The grouping is exercised: features of several entry points, more than one of them.
    expect(now.capability!.files).toBeGreaterThan(1);
  }, 300_000);
});
