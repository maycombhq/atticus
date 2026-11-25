import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The lint script `scripts/check-size-budget.mjs` (ADR 0210 part 8), tested as a module: no more
 * lines of non-test source than the recorded baseline of the last release, 2.0.0-beta.32, and
 * every run says the total and the packages that grew most.
 */

interface Pkg {
  name: string;
  was: number;
  now: number;
  grew: number;
}
interface Result {
  total: number;
  baseline: number;
  grew: number;
  budget: number;
  over: boolean;
  packages: Pkg[];
}
interface Lint {
  BUDGET: number;
  BASELINE_TAG: string;
  EXCLUDE: Record<string, string>;
  BASELINE: Record<string, number>;
  count(root?: string): Record<string, number>;
  check(root?: string, o?: { baseline?: Record<string, number>; budget?: number }): Result;
  report(r: Result, top?: number): string[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "../../../scripts/check-size-budget.mjs");
const lint = async () => (await import(pathToFileURL(SCRIPT).href)) as Lint;

const text = (lines: number, eol = "\n") =>
  Array.from({ length: lines }, (_, i) => `// line ${i + 1}`).join(eol) + eol;

/** A repo of files, by path: a number of lines each. */
async function repoWith(files: Record<string, number>, eol = "\n"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "b31-size-"));
  for (const [path, n] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text(n, eol));
  }
  return root;
}

describe("the size budget for non-test source", () => {
  it("is no more lines than the last release, recorded per package", async () => {
    const { BUDGET, BASELINE_TAG, BASELINE } = await lint();
    // ADR 0210 part 8: none, but for beta.33's one allowance over beta.32, which ends with it.
    expect(BUDGET).toBe(BASELINE_TAG === "v2.0.0-beta.32" ? 3200 : 0);
    expect(BASELINE_TAG).toBe("v2.0.0-beta.32");
    expect(Object.keys(BASELINE)).toEqual(expect.arrayContaining(["cli", "core", "scripts"]));
    expect(Object.values(BASELINE).every((n) => Number.isInteger(n) && n > 0)).toBe(true);
  });

  it("marks each folder it leaves out by path as generated or as test code", async () => {
    const { EXCLUDE } = await lint();
    expect(Object.values(EXCLUDE).every((why) => why === "generated" || why === "test")).toBe(true);
  });

  it("counts source code only: not tests, fixtures, docs, markdown or data", async () => {
    const { count } = await lint();
    const root = await repoWith({
      "packages/core/src/a.ts": 10,
      "packages/core/src/ui/b.tsx": 5,
      "packages/core/src/c.test.ts": 100,
      "packages/core/src/fixtures/d.ts": 100,
      "packages/core/src/notes.md": 100,
      "packages/core/src/e.yaml": 100,
      "packages/core/test/f.ts": 100,
      "packages/core/dist/g.js": 100,
      "packages/core/.turbo/h.js": 100,
      "packages/core/node_modules/x/i.js": 100,
      // Code outside src/ counts: a bench, a package's scripts, its config.
      "packages/core/bench/run.ts": 4,
      "packages/core/vite.config.ts": 2,
      "packages/core/scripts/gen.py": 3,
      "packages/core/scripts/gen.sh": 1,
      "packages/core/scripts/gen.ps1": 1,
      "packages/ui/src/App.vue": 6,
      "packages/intellij/src/main/kotlin/H.kt": 7,
      "packages/intellij/src/test/kotlin/HTest.kt": 100,
      "packages/docs-only/README.md": 100,
      // The listed folders: generated, or test code by another name.
      "packages/sdk/npm/index.js": 100,
      "packages/ui/dist-lib/index.js": 100,
      "packages/ui/e2e/a.ts": 100,
      "packages/vscode/test-vscode/a.ts": 100,
      "packages/journeys/support/a.ts": 100,
      "packages/m3-exit/live/a.mjs": 100,
      "fixtures/x/y.ts": 100,
      "docs/z.ts": 100,
      "scripts/check-a.mjs": 3,
    });
    expect(count(root)).toEqual({ core: 26, intellij: 7, ui: 6, scripts: 3 });
    // CRLF line ends count the same.
    const crlf = await repoWith({ "packages/core/src/a.ts": 10 }, "\r\n");
    expect(count(crlf)).toEqual({ core: 10 });
  });

  it("passes at the budget, fails one line over it, and names the packages that grew most", async () => {
    const { check, report } = await lint();
    const baseline = { core: 100, cli: 100, ui: 100 };
    const at = await repoWith({
      "packages/core/src/a.ts": 100 + 20,
      "packages/cli/src/a.ts": 100 + 10,
      "packages/ui/src/a.ts": 100,
    });
    const ok = check(at, { baseline, budget: 30 });
    expect(ok).toMatchObject({ total: 330, baseline: 300, grew: 30, over: false });
    expect(report(ok)).toEqual([
      "Non-test source: 330 lines, +30 over v2.0.0-beta.32 (300); budget +30, 0 left.",
      "Grew most: core +20, cli +10.",
    ]);
    const over = await repoWith({
      "packages/core/src/a.ts": 100 + 20,
      "packages/cli/src/a.ts": 100 + 10,
      "packages/ui/src/a.ts": 100,
      "packages/naysayer/src/new.ts": 1,
    });
    const r = check(over, { baseline, budget: 30 });
    expect(r).toMatchObject({ grew: 31, over: true });
    expect(r.packages.map((p) => `${p.name} ${p.grew}`)).toEqual([
      "core 20",
      "cli 10",
      "naysayer 1",
    ]);
    const lines = report(r);
    expect(lines[0]).toContain("over by 1");
    expect(lines[1]).toBe("Grew most: core +20, cli +10, naysayer +1.");
    expect(lines[2]).toContain("raise BUDGET");
  });

  it("counts code taken out against code added", async () => {
    const { check } = await lint();
    const root = await repoWith({ "packages/core/src/a.ts": 140, "packages/cli/src/a.ts": 60 });
    const r = check(root, { baseline: { core: 100, cli: 100, gone: 50 }, budget: 0 });
    expect(r).toMatchObject({ grew: -50, over: false });
    expect(r.packages.map((p) => `${p.name} ${p.grew}`)).toEqual([
      "core 40",
      "cli -40",
      "gone -50",
    ]);
  });

  it("the repo as it is is within the budget", async () => {
    const { check } = await lint();
    const r = check();
    expect(r.over, (await lint()).report(r).join("\n")).toBe(false);
  });
});
