import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/main.js";

/**
 * ADR 0195, the joint review's findings on the build after an upgrade: a legacy join leaves
 * joins.json only when a slot its derived record comes from changed (point 6), so a person's
 * curated decision about one Setting retires nothing and rewrites no other file. A beta.26 Forge
 * metarepo (fixtures/forge-beta26) upgraded to slots. Invented Forge estate only (rule 3).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../fixtures");
const T = 240_000;

const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

async function atticus(root: string, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...args, "--root", root], {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out, err, all: () => [...out, ...err].join("\n") };
}

function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split("\\").join("/")] = readFileSync(p, "utf8");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

async function upgraded(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-slots-review-"));
  made.push(root);
  await cp(join(FIXTURES, "forge", "metarepo"), root, { recursive: true });
  await cp(join(FIXTURES, "forge-beta26", "catalog"), join(root, "catalog"), { recursive: true });
  const up = await atticus(root, "upgrade", "--yes");
  expect(up.code, up.all()).toBe(0);
  return root;
}

describe("a legacy join retires only when a slot its derived record comes from changed (ADR 0195 point 6)", () => {
  it(
    "after the upgrade, one catalog edits --curate of a Setting retires nothing and rewrites no other file",
    async () => {
      const root = await upgraded();
      const gen = join(root, "catalog", "generated");
      const joins = join(root, "catalog", "sources", "legacy", "joins.json");
      const joinsBefore = readFileSync(joins, "utf8");
      const setting = "setting/portal-bff.ledger-read-timeout.yaml";
      const before = files(gen);
      const path = join(gen, ...setting.split("/"));
      await writeFile(path, (await readFile(path, "utf8")).replace("5000ms", "7000ms"));
      const curate = await atticus(root, "catalog", "edits", "--curate", "--by", "pat");
      expect(curate.code, curate.all()).toBe(0);
      const b = await atticus(root, "catalog", "build", "--json");
      expect(b.code, b.all()).toBe(0);
      const report = JSON.parse(b.out.join("\n")) as { retired: unknown[]; removed: unknown[] };
      expect(report.retired).toEqual([]);
      expect(report.removed).toEqual([]);
      expect(readFileSync(joins, "utf8")).toBe(joinsBefore);
      const after = files(gen);
      const changed = Object.keys({ ...before, ...after }).filter((p) => before[p] !== after[p]);
      expect(changed).toEqual([setting]);
      expect(after[setting]).toMatch(/valueOrRef: 7000ms/);
    },
    T,
  );
});
