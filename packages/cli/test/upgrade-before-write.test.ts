import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
const FIRST = /^Run atticus upgrade first: /;

describe("an upgrade owed is said before a write verifies anything (beta.32)", () => {
  it(
    "verify <repo> --write and verify --all --write: refused at once, the upgrade's commands said, nothing written",
    async () => {
      const root = await metarepo();
      expect(await unresolvedIdsNamedOld(root)).toBe(true);
      const before = await tree(root);
      for (const argv of [
        ["verify", "forge-notify", "--write"],
        ["verify", "--all", "--write"],
      ]) {
        const q = quiet();
        expect(await main([...argv, "--root", root], q.io), argv.join(" ")).toBe(1);
        expect(q.err[0]).toMatch(FIRST);
        expect(q.err.join("\n")).toContain("atticus upgrade --dry-run");
        // Nothing was verified: no repo's line, no verify words.
        expect(q.err.join("\n")).not.toMatch(/Repo 1 of|don't verify|facts verified/i);
        expect(await tree(root)).toEqual(before);
      }
      // --json: the refusal as data too.
      const j = quiet();
      expect(
        await main(["verify", "forge-notify", "--write", "--json", "--root", root], j.io),
      ).toBe(1);
      expect(JSON.parse(j.out.join("\n"))).toEqual({ written: false, upgradeFirst: true });
      // The map's Apply (the app's "Apply 1 change to the map") too.
      const m = quiet();
      const r = await applyMapEdits(root, { edits: [] }, m.io);
      expect(r.code).toBe(1);
      expect(r.built).toBe(false);
      expect(m.err[0]).toMatch(FIRST);
      expect(await tree(root)).toEqual(before);
      // A verify that doesn't write is untouched by it.
      const read = quiet();
      await main(["verify", "forge-notify", "--root", root], read.io);
      expect(read.err.join("\n")).not.toMatch(FIRST);
    },
    T,
  );

  it(
    "once the upgrade ran, the stamp names its step and nothing is checked again",
    async () => {
      const root = await metarepo();
      expect(await upgradeCommand(root, { by: "pat", yes: true }, quiet().io, B30)).toBe(0);
      expect(await upgradeBeforeWrite(root)).toBeUndefined();
      // Even with a change naming a loose end the old way again, nothing is read: the stamp says.
      await writeFile(
        join(root, "catalog", "curated", "curateddecision", "dec-b32-old-name.yaml"),
        [
          "schemaVersion: 5",
          "kind: CuratedDecision",
          "id: dec-b32-old-name",
          "status: current",
          "confidence: asserted",
          "action: suppress",
          "at: 2026-11-23T00:00:00Z",
          "by: sam",
          "evidence: []",
          "reason: an old name",
          "target: unresolved.c-7",
          "value: null",
          "",
        ].join("\n"),
      );
      expect(await upgradeBeforeWrite(root)).toBeUndefined();
    },
    T,
  );
});
