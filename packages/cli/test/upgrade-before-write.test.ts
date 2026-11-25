import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { acquireLock } from "@maycombhq/core";
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
/** A checkout of a repo whose lines are what its facts cite (as upgrade-unresolved-ids.test.ts). */
async function checkoutFromFacts(root: string, repo: string): Promise<void> {
  const files = new Map<string, string[]>();
  for (const l of (await readFile(join(root, "facts", `${repo}.jsonl`), "utf8")).split("\n")) {
    if (!l.trim()) continue;
    const f = JSON.parse(l) as {
      cite?: { file: string; line: number; quote?: string; value: string };
    };
    if (!f.cite) continue;
    const lines = files.get(f.cite.file) ?? [];
    while (lines.length < f.cite.line) lines.push("");
    lines[f.cite.line - 1] = f.cite.quote ?? f.cite.value;
    files.set(f.cite.file, lines);
  }
  for (const [file, lines] of files) {
    const to = join(root, "workspace", repo, ...file.split("/"));
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, lines.join("\n") + "\n");
  }
}
const quiet = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

describe("an upgrade owed is run before a write (ADR 0210 part 3; beta.32 said it and stopped)", () => {
  it(
    "verify <repo> --write runs atticus upgrade first, says so, and writes (exit 0); --json says upgraded",
    async () => {
      const root = await metarepo();
      await checkoutFromFacts(root, "forge-notify");
      expect(await unresolvedIdsNamedOld(root)).toBe(true);
      const q = quiet();
      const code = await main(["verify", "forge-notify", "--write", "--root", root], q.io);
      expect(code, [...q.out, ...q.err].join("\n")).toBe(0);
      expect(q.err[0]).toMatch(/^Ran atticus upgrade first, which this metarepo still needed/);
      expect(await upgradeBeforeWrite(root)).toBeUndefined();

      const j = await metarepo();
      await checkoutFromFacts(j, "forge-notify");
      const jq = quiet();
      const jc = await main(["verify", "forge-notify", "--write", "--json", "--root", j], jq.io);
      expect(jc, jq.err.join("\n")).toBe(0);
      expect(JSON.parse(jq.out.join("\n")).upgraded).toBe(true);
    },
    T,
  );

  it(
    "verify --all --write and the map's Apply do the same; a verify that doesn't write doesn't",
    async () => {
      const all = await metarepo();
      // forge-notify's read alone (the others' facts don't fit a checkout made from them).
      for (const r of ["forge-ledger", "forge-payments"])
        await rm(join(all, "facts", `${r}.jsonl`));
      await checkoutFromFacts(all, "forge-notify");
      const q = quiet();
      const code = await main(["verify", "--all", "--write", "--root", all], q.io);
      expect(q.err[0]).toMatch(/^Ran atticus upgrade first/);
      expect(code, [...q.out, ...q.err].join("\n")).toBe(0);
      expect(await upgradeBeforeWrite(all)).toBeUndefined();

      const map = await metarepo();
      const m = quiet();
      const r = await applyMapEdits(map, { edits: [] }, m.io);
      expect(m.err[0]).toMatch(/^Ran atticus upgrade first/);
      expect(r.code, [...m.out, ...m.err].join("\n")).toBe(0);
      expect(r.built).toBe(true);
      expect(await upgradeBeforeWrite(map)).toBeUndefined();

      // The upgrade it runs first stops (another writer holds the lock): no change is tried, and
      // it says so, with one outcome per change.
      const held = await metarepo();
      const lock = await acquireLock(held, "scan", "another writer");
      try {
        const hq = quiet();
        const h = await applyMapEdits(
          held,
          {
            edits: [
              { kind: "delete", delete: { interfaces: ["interface.x"], from: "a", to: "b" } },
            ],
            by: "pat",
          },
          hq.io,
        );
        expect(h.code).toBe(1);
        expect(h.built).toBe(false);
        expect(h.edits.map((e) => e.state)).toEqual(["not-tried"]);
        expect(hq.err.join("\n")).toContain("Nothing was saved and nothing was built.");
        expect(await upgradeBeforeWrite(held)).toBeDefined();
      } finally {
        await lock.release();
      }

      const read = await metarepo();
      const before = await tree(read);
      const v = quiet();
      await main(["verify", "forge-notify", "--root", read], v.io);
      expect(v.err.join("\n")).not.toMatch(/upgrade/);
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
