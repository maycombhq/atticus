import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { applyMapEdits } from "../src/catalog-build-commands.js";
import { main } from "../src/main.js";
import { upgradeBeforeWrite, upgradeCommand } from "../src/upgrade.js";
import { unresolvedIdsNamedOld } from "../src/upgrade-unresolved-ids.js";

/**
 * beta.32, the owner's Apply of 2026-11-23: a metarepo never upgraded to beta.30's loose-end
 * names, whose changes name loose ends the old way. The write verified for a minute and a half,
 * then its build refused ("Run atticus upgrade: it renames 22 loose ends …"). Now a write says
 * so before it verifies anything, and writes nothing. On beta.30's upgrade fixture.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../../../fixtures/upgrade-b30/unresolved-ids/metarepo");
const B30 = "2.0.0-beta.30";
const T = 300_000;
const roots: string[] = [];
afterAll(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});
async function metarepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "b32-upw-"));
  roots.push(dir);
  const root = join(dir, "forge");
  await cp(FIXTURE, root, { recursive: true });
  return root;
}
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      const rel = relative(dir, p).split(sep).join("/");
      if (rel.startsWith(".atticus/") && rel !== ".atticus/metarepo.yaml") continue;
      if (e.isDirectory()) await walk(p);
      else out[rel] = await readFile(p, "utf8");
    }
  };
  await walk(dir);
  return out;
}
const quiet = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

describe("an upgrade owed is run before a write (ADR 0210 part 3; beta.32 said it and stopped)", () => {
  it(
    "verify <repo> --write runs atticus upgrade first, says so, and goes on",
    async () => {
      const root = await metarepo();
      expect(await unresolvedIdsNamedOld(root)).toBe(true);
      const q = quiet();
      await main(["verify", "forge-notify", "--write", "--root", root], q.io);
      expect(q.err[0]).toMatch(/^Ran atticus upgrade first, which this metarepo still needed/);
      // It went on to the verify (the fixture has no checkout, which verify says).
      expect(q.err.join("\n")).toContain("No checkout of forge-notify");
      expect(await upgradeBeforeWrite(root)).toBeUndefined();
    },
    T,
  );

  it(
    "verify --all --write and the map's Apply do the same; a verify that doesn't write doesn't",
    async () => {
      const all = await metarepo();
      const q = quiet();
      await main(["verify", "--all", "--write", "--root", all], q.io);
      expect(q.err[0]).toMatch(/^Ran atticus upgrade first/);
      expect(await upgradeBeforeWrite(all)).toBeUndefined();

      const map = await metarepo();
      const m = quiet();
      await applyMapEdits(map, { edits: [] }, m.io);
      expect(m.err[0]).toMatch(/^Ran atticus upgrade first/);
      expect(await upgradeBeforeWrite(map)).toBeUndefined();

      const read = await metarepo();
      const before = await tree(read);
      const r = quiet();
      await main(["verify", "forge-notify", "--root", read], r.io);
      expect(r.err.join("\n")).not.toMatch(/upgrade/);
      expect(await tree(read)).toEqual(before);
    },
    T,
  );

  it(
    "once the upgrade ran, the stamp names its step and nothing is checked again",
    async () => {
      const root = await metarepo();
      expect(await upgradeCommand(root, { by: "pat", yes: true }, quiet().io, B30)).toBe(0);
      expect(await upgradeBeforeWrite(root)).toBeUndefined();
    },
    T,
  );
});
