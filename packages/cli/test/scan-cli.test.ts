import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
const T = 120_000;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

function git(cwd: string, ...args: string[]) {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, stdio: "pipe" },
  );
}

/**
 * A copy of the Forge fixture (its dialect tests read ../../repos beside the metarepo), with
 * each fixture repo also committed as a git base clone under the metarepo's workspace/.
 */
async function forgeRoot(): Promise<string> {
  const top = await mkdtemp(join(tmpdir(), "atticus-cli-scan-"));
  await cp(FORGE, top, { recursive: true });
  const root = join(top, "metarepo");
  for (const id of await readdir(join(top, "repos"))) {
    const dir = join(root, "workspace", id);
    await cp(join(top, "repos", id), dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fixture");
  }
  return root;
}

describe("atticus scan", () => {
  it(
    "writes catalog/generated, reports what changed, and is quiet on a rescan",
    async () => {
      const root = await forgeRoot();
      const c = capture();
      const code = await main(["scan", "--root", root], c.io);
      expect(c.err).toEqual([]);
      expect(code).toBe(0);
      expect(existsSync(join(root, "catalog/generated/interface"))).toBe(true);
      expect(c.out.join("\n")).toMatch(/Scanned 7 repos/);
      expect(c.out.join("\n")).toMatch(/7 interfaces/);
      expect(c.out.join("\n")).toMatch(/\+ Interface\/if-/);

      const again = capture();
      expect(await main(["scan", "--root", root], again.io)).toBe(0);
      expect(again.out.join("\n")).toMatch(/from cache/);
      expect(again.out.join("\n")).toMatch(/No catalog changes/);
    },
    T,
  );

  it(
    "prints JSON, and --dry-run writes nothing",
    async () => {
      const root = await forgeRoot();
      const c = capture();
      expect(await main(["scan", "--root", root, "--json", "--dry-run", "--full"], c.io)).toBe(0);
      const report = JSON.parse(c.out.join("\n")) as {
        stats: { interfaces: number; cachedRuns: number };
        diff: { added: unknown[] };
        problems: unknown[];
        written: boolean;
      };
      expect(report.stats.interfaces).toBe(7);
      expect(report.stats.cachedRuns).toBe(0);
      expect(report.diff.added.length).toBeGreaterThan(20);
      expect(report.written).toBe(false);
      expect(existsSync(join(root, "catalog/generated"))).toBe(false);
    },
    T,
  );

  it(
    "exits 1 and names the repo when a base clone is missing",
    async () => {
      const root = await forgeRoot();
      await rm(join(root, "workspace", "forge-ledger"), { recursive: true });
      const c = capture();
      expect(await main(["scan", "--root", root], c.io)).toBe(1);
      expect(c.err.join("\n")).toMatch(/forge-ledger.*atticus workspace sync/);
    },
    T,
  );

  it(
    "exits 2 for repos not in any manifest",
    async () => {
      const root = await forgeRoot();
      const c = capture();
      expect(await main(["scan", "--root", root, "--repos", "nope"], c.io)).toBe(2);
      expect(c.err.join("\n")).toMatch(/nope/);
    },
    T,
  );
});

describe("atticus catalog diff", () => {
  it(
    "exits 0 for the same catalog and 1 with the changes listed otherwise",
    async () => {
      const root = await forgeRoot();
      expect(await main(["scan", "--root", root], capture().io)).toBe(0);
      const a = join(root, "catalog/generated");
      const b = await mkdtemp(join(tmpdir(), "atticus-cli-diff-"));
      await cp(a, b, { recursive: true });
      const same = capture();
      expect(await main(["catalog", "diff", a, b], same.io)).toBe(0);
      expect(same.out.join("\n")).toMatch(/No catalog changes/);

      const sys = join(b, "system/audit.yaml");
      await writeFile(
        sys,
        (await readFile(sys, "utf8")).replace("name: Audit", "name: Audit Service"),
      );
      await rm(join(b, "system/reports.yaml"));
      const diff = capture();
      expect(await main(["catalog", "diff", a, b], diff.io)).toBe(1);
      const text = diff.out.join("\n");
      expect(text).toMatch(/- System\/reports/);
      expect(text).toMatch(/~ System\/audit \(name\)/);
    },
    T,
  );

  it("exits 2 without two folders", async () => {
    const c = capture();
    expect(await main(["catalog", "diff", "only-one"], c.io)).toBe(2);
  });
});
