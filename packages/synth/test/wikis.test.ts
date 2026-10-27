import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MANY_WIKIS, writeWikiEstate } from "../src/index.js";

/** The 12-source wiki estate (ADR 0132): deterministic, the planted pages and the filler. */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

async function digest(dir: string): Promise<{ files: number; sha: string }> {
  const h = createHash("sha256");
  const files = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();
  for (const f of files) h.update(f.slice(dir.length)).update(await readFile(f));
  return { files: files.length, sha: h.digest("hex") };
}

describe("the many-wikis estate", () => {
  it("writes 12 sources: 2 standards, 2 platforms, 2 frameworks, 5 teams and 1 reference", () => {
    const voices = MANY_WIKIS.map((w) => w.voice);
    expect(voices.filter((v) => v === "standard")).toHaveLength(2);
    expect(voices.filter((v) => v === "platform")).toHaveLength(2);
    expect(voices.filter((v) => v === "framework")).toHaveLength(2);
    expect(voices.filter((v) => v === "team")).toHaveLength(5);
    expect(voices.filter((v) => v === "reference")).toHaveLength(1);
    expect(MANY_WIKIS.reduce((n, w) => n + w.pages, 0)).toBe(4800);
  });

  it("writes the same files every time", async () => {
    const a = await mkdtemp(join(tmpdir(), "atticus-wikis-a-"));
    const b = await mkdtemp(join(tmpdir(), "atticus-wikis-b-"));
    const ra = await writeWikiEstate(a, { fixtures: FIXTURES, scale: 0.1 });
    await writeWikiEstate(b, { fixtures: FIXTURES, scale: 0.1 });
    expect(await digest(join(a, "wikis"))).toEqual(await digest(join(b, "wikis")));
    expect(ra.pages["ea-standards"]).toBe(70);
    expect(ra.mirrored).toBeGreaterThan(0);
    // The planted pages are there beside the filler.
    expect(
      await readFile(join(a, "wikis/stock-team/warehouse/legacy-warehouse-link.md"), "utf8"),
    ).toMatch(/WVR-2291/);
    expect(await readFile(join(a, "wikis/payments-team/metadata.csv"), "utf8")).toMatch(
      /Fraud-thresholds\.html,.*TRUE\n/,
    );
  });
});
