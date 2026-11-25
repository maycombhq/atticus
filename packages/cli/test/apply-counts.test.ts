import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { catalogDirOf, RACY_MS } from "@maycombhq/core";
import { applyOnce, makeApplyEstate, type ApplyEstate } from "./apply-estate.js";

/**
 * Item 11 of docs/plan/ai-first.md, by counts not seconds (so in `pnpm test` on every platform):
 * on a small generated estate (8 repos, apply-estate.ts) with inputs/, a steady Apply opens only
 * the record files the last Apply wrote, reads no file of inputs/ that didn't change, and reads
 * the catalog for names once an intake. Before item 11 every input was read, classified and
 * screened on each Apply and the catalog read for every name; on a Windows machine whose kept
 * hashes don't hold, every record file is opened. The hand-edit guard still sees a same-size edit
 * whose time was put back, and takes a file changed to CRLF only for no edit. The speed itself:
 * apply-speed.test.ts (`pnpm test:speed`).
 */
let dir: string;
let e: ApplyEstate;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "atticus-apply-counts-"));
  e = await makeApplyEstate(dir, 8, { specs: 4, ops: 20, diagrams: 4, boxes: 20 });
  // The record files the cold build wrote are racily new for 2 s (RACY_MS): an Apply within
  // them reads them again, as it should. The first Apply here comes after.
  await new Promise((r) => setTimeout(r, RACY_MS + 100));
}, 600_000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("each Apply reads only what changed (item 11)", () => {
  it("opens only the files the last Apply wrote, and no unchanged input", async () => {
    const first = await applyOnce(e, 1);
    const steady = await applyOnce(e, 2);
    expect(steady.written?.written).toBeGreaterThan(0);
    // The record files the first Apply wrote, at most: none of the others.
    expect(steady.opened).toBeLessThanOrEqual(
      (first.written?.written ?? 0) + (first.written?.removed ?? 0),
    );
    expect(steady.opened).toBeLessThan(e.records.length / 20);
    expect(steady.intakes).toBeGreaterThan(0);
    expect(steady.inputsRead).toEqual([]);
    expect(steady.catalogReads).toBe(steady.intakes);
    // An input changed is read again, and only it.
    const spec = join(e.root, "inputs/partner-specs/spec-1.yaml");
    await writeFile(spec, `${await readFile(spec, "utf8")}# changed\n`);
    const changed = await applyOnce(e, 3);
    expect(changed.inputsRead).toEqual(["inputs/partner-specs/spec-1.yaml"]);
  }, 600_000);

  const recordFile = (n: number) => join(catalogDirOf(e.root), "generated", e.records[n]!);

  it("still sees a hand edit of the same size with its time put back", async () => {
    const file = recordFile(100);
    const before = await stat(file);
    const text = await readFile(file, "utf8");
    // One letter for another: the same size; then the file's times as they were.
    const edited = text.replace(
      /^(id: \S*?)([a-z])/m,
      (_, a: string, c: string) => a + (c === "a" ? "b" : "a"),
    );
    expect(edited).not.toBe(text);
    expect(edited.length).toBe(text.length);
    await writeFile(file, edited);
    await utimes(file, before.atimeMs / 1000, before.mtimeMs / 1000);
    try {
      expect(Math.floor((await stat(file)).mtimeMs)).toBe(Math.floor(before.mtimeMs));
      // Its change time moved (no program sets it): the kept hash isn't used, the edit is seen.
      const { refused } = await applyOnce(e, 4, { strict: true });
      expect(refused?.guard.refused?.reasons).toContain("hand-edits");
      expect(refused?.guard.edits.map((x) => x.path)).toEqual([
        `catalog/generated/${e.records[100]!.split(sep).join("/")}`,
      ]);
    } finally {
      await writeFile(file, text);
    }
  }, 600_000);

  it("doesn't take line endings changed to CRLF for a hand edit", async () => {
    const file = recordFile(150);
    await writeFile(file, (await readFile(file, "utf8")).replace(/\n/g, "\r\n"));
    const { written, refused } = await applyOnce(e, 5, { strict: true });
    expect(refused?.guard.refused).toBeUndefined();
    expect(written?.written).toBeGreaterThan(0);
  }, 600_000);
});
