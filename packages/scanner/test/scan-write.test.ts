import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { scanIntoCatalog } from "../src/index.js";

/**
 * ADR 0195 point 4, the review: `scanIntoCatalog` (the learning sandbox's scan) refuses as
 * `atticus scan` does when it read no repo in full, an estate with no repo to read included:
 * no slot, no build, no file. Invented Forge org pack (CLAUDE.md rule 3).
 */

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

describe("scanIntoCatalog writes nothing when it read no repo in full", () => {
  it("a manifest that lists no repo: nothing read, no slot, no build", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-scan-write-"));
    made.push(root);
    await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
    const manifest = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
    const m = parse(await readFile(manifest, "utf8")) as Record<string, unknown>;
    await writeFile(manifest, stringify({ ...m, repos: [] }));
    const r = await scanIntoCatalog({ root });
    expect(r.nothingRead).toBe(true);
    expect(r.result).toBeUndefined();
    expect(existsSync(join(root, "catalog"))).toBe(false);
  });
});
