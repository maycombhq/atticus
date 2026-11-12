import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { listQuestions, raiseQuestions } from "@maycombhq/core";
import { buildWriteHooks, listUndo, undoDirOf } from "@maycombhq/scanner";
import { main } from "../src/main.js";
import { renameHooks } from "../src/repo-rename.js";

/**
 * ADR 0195 point 2, the joint review's blocker: `atticus repo rename` computes everything in
 * memory under the scan's lock (the repo's slots under the new id, the legacy joins, the manifest
 * entry, the facts files and their companions, the questions and the curated decisions), runs the
 * build's guards on that, and only then writes them all in one write with one undo copy. A refusal
 * writes nothing; a write that stops part way puts every file back. A beta.26 Forge metarepo
 * (fixtures/forge-beta26) upgraded to slots, so `legacy/joins.json` names the repo too. Invented
 * Forge estate only (CLAUDE.md rule 3).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../fixtures");
const FORGE = join(FIXTURES, "forge");
const BETA26 = join(FIXTURES, "forge-beta26");
const T = 240_000;
const NOW = new Date("2026-11-11T09:00:00.000Z");

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

/**
 * Every file of the metarepo but this machine's own state (the undo copies and build report in
 * .index, the run log, the read cache), by path, with its bytes.
 */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const local = new Set([".index", ".atticus/.index", ".atticus/logs", ".atticus/cache"]);
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const rel = relative(root, p).split("\\").join("/");
      if (local.has(rel)) continue;
      if (statSync(p).isDirectory()) walk(p);
      else out[rel] = readFileSync(p).toString("base64");
    }
  };
  walk(root);
  return out;
}

/**
 * A beta.26 Forge metarepo upgraded to slots, with forge-ledger's live facts file and a
 * corrections file, a question raised for it, and its manifest in CRLF (a Windows checkout).
 */
async function upgraded(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-rename-slots-"));
  made.push(root);
  await cp(join(FORGE, "metarepo"), root, { recursive: true });
  await cp(join(BETA26, "catalog"), join(root, "catalog"), { recursive: true });
  const manifest = join(root, "org-pack", "profiles", "forge", "repos.manifest.yaml");
  await writeFile(
    manifest,
    (await readFile(manifest, "utf8")).replace(/\r?\n/g, "\r\n"),
  );
  const up = await atticus(root, "upgrade", "--yes");
  expect(up.code, up.all()).toBe(0);
  expect(existsSync(join(root, "catalog", "sources", "legacy", "joins.json"))).toBe(true);
  await mkdir(join(root, "facts"), { recursive: true });
  await cp(
    join(FORGE, "slots", "facts", "forge-ledger.jsonl"),
    join(root, "facts", "forge-ledger.jsonl"),
  );
  await writeFile(join(root, "facts", "forge-ledger.corrections.jsonl"), "");
  await raiseQuestions(
    root,
    [{ question: "Is src/gen generated?", options: [], evidence: ["pom.xml:1"], scope: "repo" }],
    {
      step: "map",
      repo: "forge-ledger",
      command: "atticus verify forge-ledger",
      rerun: "atticus verify forge-ledger --write",
      at: NOW.toISOString(),
    },
  );
  const b = await atticus(root, "catalog", "build");
  expect(b.code, b.all()).toBe(0);
  return root;
}

describe("atticus repo rename computes first, then writes everything in one step (ADR 0195 point 2)", () => {
  for (const at of ["after-slots", "mid-records"] as const)
    it(
      `a write that stops ${at} puts every file back: slots, joins.json, manifest, facts, questions, curated, catalog`,
      async () => {
        const root = await upgraded();
        const before = tree(root);
        const undoDir = await undoDirOf(root);
        const copies = (await listUndo(undoDir)).map((c) => c.n);
        buildWriteHooks.crash = at;
        const err: string[] = [];
        await expect(
          main(["repo", "rename", "forge-ledger", "forge-ledger-core", "--root", root], {
            out: () => undefined,
            err: (l) => err.push(l),
          }),
        ).rejects.toThrow(/the write stopped/);
        buildWriteHooks.crash = undefined;
        expect(err.join("\n")).toMatch(/every file it had written was put back/);
        expect(tree(root)).toEqual(before);
        // The copy the stopped write took is gone with it: undo lists the builds it did before.
        expect((await listUndo(undoDir)).map((c) => c.n)).toEqual(copies);
        // And the metarepo still builds to what it holds.
        const check = await atticus(root, "catalog", "build", "--check");
        expect(check.code, check.all()).toBe(0);
      },
      T,
    );

  it(
    "new slots that don't read: refused, and no file is written, the legacy joins included",
    async () => {
      const root = await upgraded();
      const before = tree(root);
      const undoDir = await undoDirOf(root);
      const copies = (await listUndo(undoDir)).map((c) => c.n);
      renameHooks.breakNewSlots = true;
      const r = await atticus(root, "repo", "rename", "forge-ledger", "forge-ledger-core", "--json");
      expect(r.code).toBe(1);
      expect(JSON.parse(r.out.join("\n"))).toMatchObject({
        renamed: false,
        refused: { reasons: ["build-failed"] },
      });
      expect(tree(root)).toEqual(before);
      expect((await listUndo(undoDir)).map((c) => c.n)).toEqual(copies);
    },
    T,
  );

  it(
    "a guard's refusal (a hand edit) writes nothing: no input is renamed before the build is checked",
    async () => {
      const root = await upgraded();
      const hand = join(root, "catalog", "generated", "setting", "portal-bff.ledger-read-timeout.yaml");
      await writeFile(hand, (await readFile(hand, "utf8")).replace("5000ms", "7000ms"));
      const before = tree(root);
      const r = await atticus(root, "repo", "rename", "forge-ledger", "forge-ledger-core", "--json");
      expect(r.code).toBe(1);
      expect(JSON.parse(r.out.join("\n")).refused.reasons).toContain("hand-edits");
      expect(tree(root)).toEqual(before);
    },
    T,
  );

  it(
    "succeeds whole: the inputs renamed with the slots, the manifest's CRLF kept, and the next check has nothing to do",
    async () => {
      const root = await upgraded();
      const r = await atticus(root, "repo", "rename", "forge-ledger", "forge-ledger-core", "--json");
      expect(r.code, r.all()).toBe(0);
      const report = JSON.parse(r.out.join("\n")) as { renamed: boolean; slots: string[] };
      expect(report.renamed).toBe(true);
      // Only slot files are listed as slots; the inputs it moved are said in words.
      for (const s of report.slots) expect(s).toMatch(/^catalog\/sources\//);
      const manifest = readFileSync(
        join(root, "org-pack", "profiles", "forge", "repos.manifest.yaml"),
        "utf8",
      );
      expect(manifest).toContain("id: forge-ledger-core\r\n");
      expect(existsSync(join(root, "facts", "forge-ledger.jsonl"))).toBe(false);
      expect(existsSync(join(root, "facts", "forge-ledger-core.jsonl"))).toBe(true);
      expect(existsSync(join(root, "facts", "forge-ledger-core.corrections.jsonl"))).toBe(true);
      expect(existsSync(join(root, "catalog", "sources", "readers", "forge-ledger.json"))).toBe(
        false,
      );
      const joins = readFileSync(join(root, "catalog", "sources", "legacy", "joins.json"), "utf8");
      expect(joins).toContain("readers/forge-ledger-core.json");
      expect(joins).not.toMatch(/"repo": "forge-ledger"/);
      const qs = (await listQuestions(root)).questions;
      expect(qs.map((q) => q.repo)).toEqual(["forge-ledger-core"]);
      // build.json recorded the inputs as written: the catalog is what they build.
      const check = await atticus(root, "catalog", "build", "--check");
      expect(check.code, check.all()).toBe(0);
    },
    T,
  );
});
