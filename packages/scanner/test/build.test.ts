import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile, appendFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { loadOrgPack, parseFacts, trustKeptFiles } from "@maycombhq/core";
import {
  applyUndo,
  buildAndWrite,
  buildCatalog,
  buildWriteHooks,
  factsSnapshotWrites,
  keepCatalogsInMemory,
  listUndo,
  loadBuildInputs,
  parseReadersSlot,
  planUndo,
  readBuildReport,
  readCatalog,
  readersSlotPath,
  serializeBuildManifest,
  serializeReadersSlot,
  undoDirOf,
  UNDO_KEEP,
} from "../src/index.js";
import { compareCatalog } from "./compare.js";

/**
 * The build of ADR 0195 (ticket CS2): the Forge golden slots build to the hand-written oracle
 * (fixtures/forge/expected/scan.yaml), the same slots always give the same bytes, and the guards
 * write nothing they refuse: an unexplained removal, a large removal without its count, a hand
 * edit without its discard. Undo puts back what a build replaced, and can itself be undone.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const SLOTS = join(FORGE, "slots");
const T = 180_000;
const update = process.env.UPDATE_GOLDEN === "1";
const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

const expected = (
  parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<string, unknown>[]
).map(
  (r) =>
    ({ status: "current", ...r }) as unknown as Record<string, unknown> & {
      kind: string;
      id: string;
    },
);

/** A metarepo of the Forge org pack and the golden readers slots, and no catalog yet. */
async function forge(o: { inputs?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-build-"));
  made.push(root);
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(SLOTS, "readers"), join(root, "catalog/sources/readers"), { recursive: true });
  if (o.inputs) await cp(join(FORGE, "inputs"), join(root, "inputs"), { recursive: true });
  return root;
}

async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(d: string, rel: string) {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) await walk(join(d, e.name), `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = await readFile(join(d, e.name), "utf8");
    }
  }
  await walk(dir, "");
  return out;
}

const snap = async (root: string) => ({
  generated: await tree(join(root, "catalog/generated")),
  sources: await tree(join(root, "catalog/sources")),
});

/** A repo's readers slot with some of its records taken out (a read that no longer finds them). */
async function dropRecords(root: string, repo: string, keep: (kind: string) => boolean) {
  const path = readersSlotPath(root, repo);
  const p = parseReadersSlot(await readFile(path, "utf8"), repo);
  if (!p.ok) throw new Error("slot doesn't read");
  return {
    path,
    text: serializeReadersSlot({ ...p.slot, records: p.slot.records.filter((r) => keep(r.kind)) }),
  };
}

describe("the build makes catalog/generated from the source slots (ADR 0195 point 2)", () => {
  it(
    "the Forge golden slots build to the hand-written oracle, and build.json is golden",
    async () => {
      const root = await forge({ inputs: true });
      const b = await buildCatalog(await loadBuildInputs(root));
      expect(b.problems).toEqual([]);
      expect(b.sources.every((s) => s.source === "readers")).toBe(true);
      const kinds = [...new Set(expected.map((e) => e.kind))];
      const c = compareCatalog(b.records, expected, kinds, {
        ignoreFields: { Column: ["glossaryTerm"] },
      });
      expect(c.missing).toEqual([]);
      expect(c.extra.filter((k) => !k.startsWith("SourceDocument/"))).toEqual([]);
      expect(c.fieldDiffs).toEqual([]);
      expect(
        c.evidenceDiffs.filter((d) => !d.startsWith("System/") && !d.startsWith("Component/")),
      ).toEqual([]);
      // build.json of these slots, without inputs/ (the golden is of the slots alone).
      const bare = await forge();
      const m = serializeBuildManifest((await buildCatalog(await loadBuildInputs(bare))).manifest);
      if (update) await writeFile(join(SLOTS, "build.json"), m);
      expect(m).toBe(readFileSync(join(SLOTS, "build.json"), "utf8"));
    },
    T,
  );

  it(
    "is deterministic: the same slots give the same bytes, and building again writes no file and takes no undo copy",
    async () => {
      const root = await forge();
      const first = await buildAndWrite(root, { command: "atticus catalog build" });
      expect(first.guard.refused).toBeUndefined();
      expect(first.write!.written).toBeGreaterThan(0);
      const after = await snap(root);
      const again = await buildAndWrite(root, { command: "atticus catalog build" });
      expect(again.write).toMatchObject({ written: 0, removed: 0, slots: [] });
      expect(again.write!.undo).toBeUndefined();
      expect(await snap(root)).toEqual(after);
      // A fresh metarepo given only the slots builds the same bytes (the equivalence oracle).
      const other = await forge();
      await buildAndWrite(other, { command: "atticus catalog build" });
      expect((await snap(other)).generated).toEqual(after.generated);
      expect((await listUndo(await undoDirOf(root))).length).toBe(1);
    },
    T,
  );

  it(
    "a facts slot is the repo's source, whatever order the facts slots were written in",
    async () => {
      const ledger = (repo: string, commit: string) =>
        [
          {
            kind: "entry",
            id: "e-balance",
            repo,
            commit,
            entryType: "rest",
            method: "GET",
            path: "/accounts/{id}/balance",
            cite: {
              file: "src/main/java/forge/ledger/LedgerEndpoints.java",
              line: 8,
              value: "/accounts/{id}/balance",
            },
            verified: "line",
            by: "assistant",
            conf: "declared",
          },
        ]
          .map((f) => JSON.stringify(f))
          .join("\n");
      const job = JSON.stringify({
        kind: "call",
        id: "c-post",
        repo: "forge-reports-job",
        commit: "b".repeat(40),
        callType: "rest",
        method: "GET",
        path: "/accounts/{id}/balance",
        host: "ledger.forge.internal",
        cite: { file: "src/main/java/forge/reports/LedgerClient.java", line: 12, value: "x" },
        verified: "line",
        by: "assistant",
        conf: "declared",
      });
      const writesOf = (root: string, repo: string, text: string) => {
        const p = parseFacts(text);
        if (!p.ok) throw new Error("bad facts");
        return factsSnapshotWrites(root, repo, p.facts, {
          commit: p.facts[0]!.commit,
          contracts: null,
        });
      };
      const run = async (order: string[]) => {
        const root = await forge();
        await buildAndWrite(root, { command: "atticus catalog build" });
        for (const repo of order)
          await buildAndWrite(root, {
            command: `atticus verify ${repo} --write`,
            slots: writesOf(
              root,
              repo,
              repo === "forge-ledger" ? ledger(repo, "a".repeat(40)) : job,
            ),
            allowRemovals: undefined,
          }).then(async (r) =>
            r.guard.refused
              ? buildAndWrite(root, {
                  command: `atticus verify ${repo} --write`,
                  slots: writesOf(
                    root,
                    repo,
                    repo === "forge-ledger" ? ledger(repo, "a".repeat(40)) : job,
                  ),
                  allowRemovals: r.guard.refused.allowRemovals!,
                })
              : r,
          );
        return snap(root);
      };
      const a = await run(["forge-ledger", "forge-reports-job"]);
      const b = await run(["forge-reports-job", "forge-ledger"]);
      expect(a).toEqual(b);
      const eps = Object.entries(a.generated).filter(
        ([p, t]) => p.startsWith("endpoint/") && t.includes("repo: forge-ledger"),
      );
      expect(eps).toHaveLength(1);
      expect(eps[0]![1]).toContain("by: assistant");
    },
    T,
  );
});

describe("the guards write nothing they refuse (ADR 0195 point 4)", () => {
  it(
    "a removal no changed slot or input explains refuses, with no flag to force it",
    async () => {
      const root = await forge();
      await buildAndWrite(root, { command: "atticus catalog build" });
      // build.json says the last build wrote a record this one won't, from sources unchanged.
      const path = join(root, "catalog/sources/build.json");
      const m = JSON.parse(await readFile(path, "utf8")) as {
        files: { path: string; sha256: string; sources: unknown[] }[];
      };
      const one = m.files.find((f) => f.path.includes("/endpoint/"))!;
      const ghost = { ...one, path: "catalog/generated/endpoint/ghost.yaml" };
      m.files.push(ghost);
      m.files.sort((x, y) => (x.path < y.path ? -1 : 1));
      await writeFile(path, JSON.stringify(m, null, 2) + "\n");
      await writeFile(
        join(root, "catalog/generated/endpoint/ghost.yaml"),
        await readFile(join(root, one.path), "utf8"),
      );
      const before = await snap(root);
      const r = await buildAndWrite(root, { command: "atticus catalog build", allowRemovals: 1 });
      expect(r.guard.refused?.reasons).toContain("unexplained-removals");
      expect(r.guard.refused?.unexplained?.map((x) => x.path)).toEqual([ghost.path]);
      expect(r.guard.refused?.message).toMatch(/That is a bug/);
      expect(await snap(root)).toEqual(before);
    },
    T,
  );

  it(
    "large removals wait for --allow-removals with the count listed; a wrong count refuses again; small ones are written and reported",
    async () => {
      const root = await forge();
      await buildAndWrite(root, { command: "atticus catalog build" });
      const before = await snap(root);
      const w = await dropRecords(root, "forge-ledger", (k) => k === "Component");
      const r = await buildAndWrite(root, { command: "atticus scan", slots: [w] });
      expect(r.guard.refused?.reasons).toEqual(["large-removals"]);
      const n = r.guard.refused!.allowRemovals!;
      expect(n).toBeGreaterThan(0);
      expect(r.guard.refused!.removals!.every((x) => x.explainedBy.length > 0)).toBe(true);
      expect(r.guard.refused!.message).toContain(`--allow-removals ${n}`);
      expect(await snap(root)).toEqual(before);
      const wrong = await buildAndWrite(root, {
        command: "atticus scan",
        slots: [w],
        allowRemovals: n + 1,
      });
      expect(wrong.guard.refused?.reasons).toEqual(["large-removals"]);
      expect(await snap(root)).toEqual(before);
      const ok = await buildAndWrite(root, {
        command: "atticus scan",
        slots: [w],
        allowRemovals: n,
      });
      expect(ok.write!.removals).toHaveLength(n);
      expect(ok.write!.slots).toEqual(["catalog/sources/readers/forge-ledger.json"]);
    },
    T,
  );

  it(
    "a repo taken out of the manifests leaves only through the confirmed removal guard, and its slot stays",
    async () => {
      const root = await forge();
      await buildAndWrite(root, { command: "atticus catalog build" });
      const manifest = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
      const m = parse(await readFile(manifest, "utf8")) as { repos: { id: string }[] };
      m.repos = m.repos.filter((r) => r.id !== "forge-reports-job");
      await writeFile(manifest, stringify(m));
      const r = await buildAndWrite(root, { command: "atticus catalog build" });
      expect(r.guard.refused?.reasons).toEqual(["large-removals"]);
      expect(r.build.orphaned.map((x) => x.repo)).toEqual(["forge-reports-job"]);
      const ok = await buildAndWrite(root, {
        command: "atticus catalog build",
        allowRemovals: r.guard.refused!.allowRemovals!,
      });
      expect(ok.write!.removals.length).toBe(r.guard.refused!.allowRemovals);
      expect(existsSync(readersSlotPath(root, "forge-reports-job"))).toBe(true);
    },
    T,
  );

  it(
    "a hand edit, an added file or a deleted one refuses the build; a discard with the count copies the edit into the undo copy first",
    async () => {
      const root = await forge();
      await buildAndWrite(root, { command: "atticus catalog build" });
      const gen = join(root, "catalog/generated");
      const [changed] = readdirSync(join(gen, "endpoint")).sort();
      await appendFile(join(gen, "endpoint", changed!), "# edited by hand\n");
      await writeFile(join(gen, "endpoint", "added-by-hand.yaml"), "kind: Endpoint\n");
      const [deleted] = readdirSync(join(gen, "table")).sort();
      await rm(join(gen, "table", deleted!));
      const before = await snap(root);
      const r = await buildAndWrite(root, { command: "atticus catalog build" });
      expect(r.guard.refused?.reasons).toEqual(["hand-edits"]);
      expect(r.guard.refused?.edits?.map((e) => `${e.how} ${e.path}`)).toEqual(
        [
          `changed catalog/generated/endpoint/${changed}`,
          "added catalog/generated/endpoint/added-by-hand.yaml",
          `deleted catalog/generated/table/${deleted}`,
        ].sort((a, b) => (a.split(" ")[1]! < b.split(" ")[1]! ? -1 : 1)),
      );
      expect(await snap(root)).toEqual(before);
      expect(
        (await buildAndWrite(root, { command: "atticus catalog build", discardEdits: 2 })).guard
          .refused?.reasons,
      ).toEqual(["hand-edits"]);
      const ok = await buildAndWrite(root, { command: "atticus catalog build", discardEdits: 3 });
      expect(ok.write!.discarded).toHaveLength(3);
      const undo = await tree(await undoDirOf(root));
      expect(Object.values(undo)).toContain(before.generated[`endpoint/${changed}`]);
      expect(Object.values(undo)).toContain("kind: Endpoint\n");
    },
    T,
  );

  it(
    "the very first build cut short part way through its records is caught up, not refused as a catalog from before the slots",
    async () => {
      const root = await forge();
      buildWriteHooks.crash = "mid-records";
      await expect(buildAndWrite(root, { command: "atticus scan" })).rejects.toThrow(
        /the write stopped mid-records/,
      );
      expect(existsSync(join(root, "catalog/sources/build.json"))).toBe(false);
      expect(readdirSync(join(root, "catalog/generated")).length).toBeGreaterThan(0);
      const r = await buildAndWrite(root, { command: "atticus catalog build" });
      expect(r.guard.refused).toBeUndefined();
      const other = await forge();
      await buildAndWrite(other, { command: "atticus catalog build" });
      expect((await snap(root)).generated).toEqual((await snap(other)).generated);
    },
    T,
  );

  it(
    "a file a build cut short wrote (it matches that build's manifest in its undo copy) isn't a hand edit",
    async () => {
      const root = await forge();
      await buildAndWrite(root, { command: "atticus catalog build" });
      const w = await dropRecords(root, "forge-ledger", (k) => k !== "Setting");
      const r = await buildAndWrite(root, {
        command: "atticus scan",
        slots: [w],
        allowRemovals: 0,
      });
      const n = r.guard.refused?.allowRemovals ?? 0;
      // The write runs, then build.json is put back as if the build stopped before its last step.
      const manifest = join(root, "catalog/sources/build.json");
      const old = await readFile(manifest, "utf8");
      await buildAndWrite(root, { command: "atticus scan", slots: [w], allowRemovals: n });
      await writeFile(manifest, old);
      const again = await buildAndWrite(root, {
        command: "atticus catalog build",
        allowRemovals: n,
      });
      expect(again.guard.refused?.reasons ?? []).not.toContain("hand-edits");
    },
    T,
  );
});

describe("atticus catalog undo restores the last builds (ADR 0195 point 7)", () => {
  it(
    "takes back the latest build byte for byte, an undo can be undone, and only the last five are kept",
    async () => {
      const root = await forge();
      const undoDir = await undoDirOf(root);
      const s0 = await snap(root);
      await buildAndWrite(root, { command: "atticus catalog build" });
      const s1 = await snap(root);
      const w = await dropRecords(root, "forge-ledger", (k) => k === "Component");
      const r = await buildAndWrite(root, { command: "atticus scan", slots: [w] });
      await buildAndWrite(root, {
        command: "atticus scan",
        slots: [w],
        allowRemovals: r.guard.refused!.allowRemovals!,
      });
      const s2 = await snap(root);
      const plan = await planUndo(undoDir);
      if ("problem" in plan) throw new Error(plan.problem);
      await applyUndo(root, undoDir, plan, "atticus catalog undo");
      expect(await snap(root)).toEqual(s1);
      const back = await planUndo(undoDir);
      if ("problem" in back) throw new Error(back.problem);
      await applyUndo(root, undoDir, back, "atticus catalog undo");
      expect(await snap(root)).toEqual(s2);
      // Back to before build 1: the catalog and the build manifest go, the slots stay as before.
      // `undo <n>` takes back the n latest (two builds and two undos so far).
      expect((await listUndo(undoDir)).length).toBe(4);
      const all = await planUndo(undoDir, 4);
      if ("problem" in all) throw new Error(all.problem);
      await applyUndo(root, undoDir, all, "atticus catalog undo 1");
      expect(await snap(root)).toEqual(s0);
      for (let i = 0; i < 6; i++) {
        await writeFile(w.path, w.text.replace("forge-ledger", "forge-ledger") + " ".repeat(i));
        await buildAndWrite(root, { command: "atticus catalog build", allowRemovals: 9999 });
      }
      expect((await listUndo(undoDir)).length).toBeLessThanOrEqual(UNDO_KEEP);
    },
    T,
  );
});

describe("writeCatalog is the build's alone (ADR 0195, CS2)", () => {
  it("no source file but build.ts imports writeCatalog", async () => {
    const pkgs = join(HERE, "../..");
    const hits: string[] = [];
    for (const p of readdirSync(pkgs)) {
      const src = join(pkgs, p, "src");
      if (!existsSync(src)) continue;
      const walk = async (d: string) => {
        for (const e of await readdir(d, { withFileTypes: true })) {
          const f = join(d, e.name);
          if (e.isDirectory()) await walk(f);
          else if (/\.tsx?$/.test(e.name)) {
            const t = await readFile(f, "utf8");
            if (
              /\bwriteCatalog\b/.test(t) &&
              !f.endsWith(join("scanner", "src", "build.ts")) &&
              !f.endsWith(join("scanner", "src", "files.ts"))
            )
              hits.push(f.slice(pkgs.length + 1));
          }
        }
      };
      await walk(src);
    }
    expect(hits).toEqual([]);
  });

  it(
    "the merge-input comment holds: the catalog never depends on which writer wrote it last",
    async () => {
      // A scan's write and a build after it give the bytes a build of the same slots gives.
      const root = await forge();
      const w = await dropRecords(root, "forge-ledger", () => true);
      await buildAndWrite(root, { command: "atticus scan", slots: [w] });
      const a = await snap(root);
      await mkdir(join(root, "x"), { recursive: true });
      const other = await forge();
      await buildAndWrite(other, { command: "atticus catalog build" });
      expect((await snap(other)).generated).toEqual(a.generated);
    },
    T,
  );
});

describe("a long-running server's kept reads never reach a build (CS3, with ADR 0119)", () => {
  it(
    "a curated decision and a manifest change written after the app read them are what the next build reads",
    async () => {
      const root = await forge();
      // The app's server: catalogs and small files kept in memory, its watcher quiet.
      keepCatalogsInMemory(true);
      trustKeptFiles(() => true);
      try {
        await buildAndWrite(root, { command: "atticus catalog build" });
        // A page read the curated folder and the org pack: both are kept.
        await readCatalog(join(root, "catalog/curated"), { cacheRoot: root });
        await loadOrgPack(join(root, "org-pack"));
        // Then `catalog edits --curate` writes a decision, before the watcher says anything.
        await mkdir(join(root, "catalog/curated/curateddecision"), { recursive: true });
        await writeFile(
          join(root, "catalog/curated/curateddecision/cd-ledger-api-type.yaml"),
          [
            "schemaVersion: 5",
            "kind: CuratedDecision",
            "id: cd-ledger-api-type",
            "status: current",
            "confidence: asserted",
            "target: ledger-api",
            "action: assert",
            "value:",
            "  type: forge-batch",
            "reason: a person said so",
            "by: pat",
            "at: 2026-11-11T10:00:00Z",
            "",
          ].join("\n"),
        );
        const r = await buildAndWrite(root, { command: "atticus catalog build" });
        expect(r.guard.refused).toBeUndefined();
        const ledger = r.build.records.find((x) => x.kind === "Component" && x.id === "ledger-api");
        expect(ledger).toMatchObject({ type: "forge-batch", confidence: "asserted" });
        // And a repo archived in the manifests: the build reads the manifest as it is now.
        const manifest = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
        const text = await readFile(manifest, "utf8");
        await writeFile(
          manifest,
          text.replace("  - id: forge-infra\n", "  - id: forge-infra\n    archived: true\n"),
        );
        const a = await buildAndWrite(root, { command: "atticus catalog build" });
        const removals = a.guard.refused?.removals ?? a.guard.removals;
        expect(removals.length).toBeGreaterThan(0);
        expect(removals.every((x) => x.reasons.includes("archived"))).toBe(true);
      } finally {
        trustKeptFiles(undefined);
        keepCatalogsInMemory(false);
      }
    },
    T,
  );
});

describe("every build leaves its report, refusals included (CS3: the app reads it)", () => {
  it(
    "a written build lists what it added, changed and removed with why; a refused one its reason, counts and the command to run; a check writes none",
    async () => {
      const root = await forge();
      expect(await readBuildReport(root)).toBeUndefined();
      await buildAndWrite(root, { command: "atticus catalog build", check: true });
      expect(await readBuildReport(root)).toBeUndefined();
      const first = await buildAndWrite(root, {
        command: "atticus catalog build",
        now: new Date("2026-11-11T10:00:00Z"),
      });
      const r1 = await readBuildReport(root);
      expect(r1).toMatchObject({
        version: 1,
        at: "2026-11-11T10:00:00.000Z",
        command: "atticus catalog build",
        outcome: "written",
        run: [],
        undo: first.write!.undo,
      });
      expect(r1!.counts).toEqual({
        records: first.build.files.size,
        added: first.build.files.size,
        changed: 0,
        removed: 0,
        written: first.write!.written,
        unchanged: first.write!.unchanged,
      });
      expect(r1!.added[0]).toMatchObject({ path: expect.stringMatching(/^catalog\/generated\//) });
      expect(r1!.added.every((x) => x.kind && x.id)).toBe(true);

      // A large removal refuses: the report says so, with the count to confirm and the command.
      const w = await dropRecords(root, "forge-ledger", (k) => k === "Component");
      const refused = await buildAndWrite(root, { command: "atticus scan", slots: [w] });
      const n = refused.guard.refused!.allowRemovals!;
      const r2 = await readBuildReport(root);
      expect(r2).toMatchObject({
        command: "atticus scan",
        outcome: "refused",
        refused: { reasons: ["large-removals"], allowRemovals: n },
        run: [`atticus scan --allow-removals ${n}`],
      });
      expect(r2!.counts.removed).toBe(n);
      expect(r2!.removed).toHaveLength(n);
      expect(r2!.removed.every((x) => x.reasons.includes("slot") && x.explainedBy.length)).toBe(
        true,
      );
      expect(r2!.undo).toBeUndefined();

      // Confirmed, it is written, and the removals are listed with their reasons.
      await buildAndWrite(root, { command: "atticus scan", slots: [w], allowRemovals: n });
      const r3 = await readBuildReport(root);
      expect(r3).toMatchObject({ outcome: "written", counts: { removed: n } });

      // A hand edit: the two ways on, curate or discard with the count.
      const gen = join(root, "catalog/generated");
      const [changed] = readdirSync(join(gen, "endpoint")).sort();
      await appendFile(join(gen, "endpoint", changed!), "# edited by hand\n");
      await buildAndWrite(root, { command: "atticus catalog build" });
      expect(await readBuildReport(root)).toMatchObject({
        outcome: "refused",
        refused: { reasons: ["hand-edits"], discardEdits: 1 },
        run: ["atticus catalog edits --curate", "atticus catalog build --discard-edits 1"],
      });
      // Nothing to do: the report says unchanged.
      await buildAndWrite(root, { command: "atticus catalog build", discardEdits: 1 });
      await buildAndWrite(root, { command: "atticus catalog build" });
      expect(await readBuildReport(root)).toMatchObject({
        outcome: "unchanged",
        counts: { added: 0, changed: 0, removed: 0 },
      });
    },
    T,
  );
});
