import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fsRepo, memoryScanCache, scanRepo, type Extractor } from "@maycombhq/sdk";
import { withExcludes } from "../src/scan-settings.js";

/**
 * Review round 49: a scan setting's exclusion changes what an extractor is listed, so the stored
 * result of the same commit can't be reused across it (it was: the key had only the dialects).
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const lister: Extractor = {
  id: "lister",
  version: "1.0.0",
  claims: ["**/*.txt"],
  // eslint-disable-next-line require-yield -- it only says which files it was listed
  async *scan(repo, ctx) {
    for await (const f of repo.listFiles(["**/*.txt"])) ctx.warn("saw", f);
  },
};

describe("withExcludes and the stored scan", () => {
  it("scans again when the exclusions change, and reuses the result when they don't", async () => {
    const d = mkdtempSync(join(tmpdir(), "atticus-scanner-r49-"));
    dirs.push(d);
    mkdirSync(join(d, "src"));
    mkdirSync(join(d, "gen"));
    writeFileSync(join(d, "src", "a.txt"), "x");
    writeFileSync(join(d, "gen", "b.txt"), "y");
    const cache = memoryScanCache();
    const base = fsRepo("forge-ledger", d, "a".repeat(40));
    const run = async (ex: RegExp[]) => {
      const r = await scanRepo({
        repo: withExcludes(base, ex),
        extractors: [lister],
        cache,
        scannedAt: "2026-01-01T00:00:00Z",
      });
      return { paths: r.warnings.map((w) => w.path), status: r.runs[0]!.status };
    };
    expect(await run([])).toEqual({ paths: ["gen/b.txt", "src/a.txt"], status: "ran" });
    expect(await run([/^gen\//])).toEqual({ paths: ["src/a.txt"], status: "ran" });
    expect(await run([/^gen\//])).toEqual({ paths: ["src/a.txt"], status: "cached" });
    expect(await run([])).toEqual({ paths: ["gen/b.txt", "src/a.txt"], status: "cached" });
  });
});
