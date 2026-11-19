import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FORGE_FIELD_DIR, sameFixtureText, writeForgeField } from "./forge-field.js";

/**
 * Beta.30 (slice 9): fixtures/forge-field is what field-estate.ts makes at its shape, byte for
 * byte. With UPDATE_GOLDEN=1 (node scripts/write-field-fixture.mjs) it is written again.
 */

const files = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.filter((f) => f !== "README.md").sort();
};

let tmp: string | undefined;
afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("fixtures/forge-field", () => {
  it("is up to date with field-estate.ts (else: node scripts/write-field-fixture.mjs)", async () => {
    if (process.env.UPDATE_GOLDEN) {
      await writeForgeField(FORGE_FIELD_DIR);
      return;
    }
    tmp = await mkdtemp(join(tmpdir(), "b30-fd-check-"));
    await writeForgeField(tmp);
    const made = files(tmp);
    expect(files(FORGE_FIELD_DIR), "the fixture's files").toEqual(made);
    const differ: string[] = [];
    for (const f of made)
      if (
        !sameFixtureText(
          f,
          await readFile(join(tmp, ...f.split("/")), "utf8"),
          await readFile(join(FORGE_FIELD_DIR, ...f.split("/")), "utf8"),
        )
      )
        differ.push(f);
    expect(differ, "files that differ: run node scripts/write-field-fixture.mjs").toEqual([]);
  }, 300_000);
});
