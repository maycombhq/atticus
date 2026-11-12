import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { deserializeRecord, serializeRecord, type CatalogRecord } from "@maycombhq/core";
import { listHooks } from "../src/catalog-build-commands.js";
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

describe("undo, prune, edits --curate and the upgrade plan again under the lock (ADR 0195 point 2)", () => {
  const setting = "setting/portal-bff.ledger-read-timeout.yaml";
  const edit = async (root: string, to: string) => {
    const p = join(root, "catalog", "generated", ...setting.split("/"));
    await writeFile(p, (await readFile(p, "utf8")).replace(/valueOrRef: \S+/, `valueOrRef: ${to}`));
  };
  const meanwhile = (f: () => Promise<void>) => {
    listHooks.afterList = f;
  };

  it(
    "catalog undo --yes refuses, undoing nothing, when another build wrote after it planned",
    async () => {
      const root = await upgraded();
      let sources: Record<string, string> = {};
      meanwhile(async () => {
        await edit(root, "9000ms");
        expect((await atticus(root, "catalog", "edits", "--curate", "--by", "pat")).code).toBe(0);
        expect((await atticus(root, "catalog", "build")).code).toBe(0);
        sources = files(join(root, "catalog", "sources"));
      });
      const before = { g: () => files(join(root, "catalog", "generated")) };
      const r = await atticus(root, "catalog", "undo", "--yes");
      expect(r.code).toBe(1);
      expect(r.err.join("\n")).toMatch(/isn't what it listed any more/);
      // The build the hook ran stays; the upgrade isn't taken back.
      expect(files(join(root, "catalog", "sources"))).toEqual(sources);
      expect(before.g()[setting]).toMatch(/9000ms/);
    },
    T,
  );

  it(
    "after an undo took back the upgrade, a file written by hand since where the next undo would put one back stops it, and nothing is written",
    async () => {
      const root = await upgraded();
      expect((await atticus(root, "catalog", "undo", "--yes")).code).toBe(0);
      const slot = join(root, "catalog", "sources", "readers", "forge-ledger.json");
      expect(existsSync(slot)).toBe(false);
      // With no build.json the build's guard can't see it: a person wrote a slot by hand.
      await mkdir(dirname(slot), { recursive: true });
      await writeFile(slot, "{}\n");
      const before = {
        g: files(join(root, "catalog", "generated")),
        s: files(join(root, "catalog", "sources")),
      };
      const r = await atticus(root, "catalog", "undo", "--yes");
      expect(r.code).toBe(1);
      expect(r.err.join("\n")).toContain("catalog/sources/readers/forge-ledger.json");
      expect({
        g: files(join(root, "catalog", "generated")),
        s: files(join(root, "catalog", "sources")),
      }).toEqual(before);
      // Taken away again, the undo of the undo goes ahead.
      await rm(slot);
      const ok = await atticus(root, "catalog", "undo", "--yes");
      expect(ok.code, ok.all()).toBe(0);
      expect(existsSync(join(root, "catalog", "sources", "build.json"))).toBe(true);
    },
    T,
  );

  it(
    "catalog prune --yes refuses, removing nothing, when what it listed changed",
    async () => {
      const root = await upgraded();
      const copy = join(root, "catalog", "sources", "legacy", "generated-before-upgrade");
      meanwhile(async () => {
        await rm(join(copy, ...setting.split("/")));
      });
      const left = Object.keys(files(copy)).length - 1;
      const r = await atticus(root, "catalog", "prune", "--yes");
      expect(r.code).toBe(1);
      expect(Object.keys(files(copy)).length).toBe(left);
    },
    T,
  );

  it(
    "catalog edits --curate writes no decision when the hand edits changed after it listed them",
    async () => {
      const root = await upgraded();
      await edit(root, "7000ms");
      const curated = files(join(root, "catalog", "curated"));
      meanwhile(() => edit(root, "8000ms"));
      const r = await atticus(root, "catalog", "edits", "--curate", "--by", "pat");
      expect(r.code).toBe(1);
      expect(files(join(root, "catalog", "curated"))).toEqual(curated);
    },
    T,
  );

  it(
    "atticus upgrade --yes writes nothing when the catalog changed after it planned",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "atticus-slots-review-"));
      made.push(root);
      await cp(join(FIXTURES, "forge", "metarepo"), root, { recursive: true });
      await cp(join(FIXTURES, "forge-beta26", "catalog"), join(root, "catalog"), {
        recursive: true,
      });
      meanwhile(() => edit(root, "6000ms"));
      const r = await atticus(root, "upgrade", "--yes");
      expect(r.code).toBe(1);
      expect(r.err.join("\n")).toMatch(/isn't what it listed any more/);
      expect(existsSync(join(root, "catalog", "sources"))).toBe(false);
    },
    T,
  );
});

describe("atticus upgrade --yes leaves a build report; a count that isn't one refuses", () => {
  it(
    "--accept-changes with a non-integer writes nothing; --yes writes the report with its slots and undo copy",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "atticus-slots-review-"));
      made.push(root);
      await cp(join(FIXTURES, "forge", "metarepo"), root, { recursive: true });
      await cp(join(FIXTURES, "forge-beta26", "catalog"), join(root, "catalog"), {
        recursive: true,
      });
      const bad = await atticus(root, "upgrade", "--yes", "--accept-changes", "all");
      expect(bad.code).toBe(2);
      expect(bad.err.join("\n")).toMatch(/--accept-changes takes the count/);
      expect(existsSync(join(root, "catalog", "sources"))).toBe(false);
      const yes = await atticus(root, "upgrade", "--yes");
      expect(yes.code, yes.all()).toBe(0);
      const { readBuildReport } = await import("@maycombhq/scanner");
      const report = await readBuildReport(root);
      expect(report).toMatchObject({
        outcome: "written",
        command: "atticus upgrade --yes",
        counts: { added: 0, changed: 0, removed: 0, written: 0 },
      });
      expect(report!.slots).toContain("catalog/sources/readers/forge-ledger.json");
      expect(report!.slots).toContain("catalog/sources/legacy/joins.json");
      expect(report!.slots.some((s) => s.includes("generated-before-upgrade"))).toBe(false);
      expect(report!.undo).toBeGreaterThan(0);
    },
    T,
  );
});

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

describe("the app's confirm is of the list the page showed, checked under the lock (the review, S3)", () => {
  const setting = "setting/portal-bff.ledger-read-timeout.yaml";
  const quiet = () => {
    const lines: string[] = [];
    return { lines, io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) } };
  };
  const edit = async (root: string, rel: string, from: RegExp, to: string) => {
    const p = join(root, "catalog", "generated", ...rel.split("/"));
    await writeFile(p, (await readFile(p, "utf8")).replace(from, to));
  };

  it(
    "catalog edits --curate with the page's plan writes no decision when the hand edits changed since the page listed them",
    async () => {
      const root = await upgraded();
      await edit(root, setting, /valueOrRef: \S+/, "valueOrRef: 7000ms");
      const { catalogBuildView } = await import("../src/build-report.js");
      const { catalogEdits } = await import("../src/catalog-build-commands.js");
      const plan = (await catalogBuildView(root)).pending.plan;
      // Another hand edit lands after the page listed one, before the job.
      const other = Object.keys(files(join(root, "catalog", "generated"))).find(
        (p) => p.startsWith("setting/") && p !== setting,
      )!;
      await edit(root, other, /valueOrRef: \S+/, "valueOrRef: 1234ms");
      const curated = files(join(root, "catalog", "curated"));
      const q = quiet();
      expect(await catalogEdits(root, { curate: true, by: "pat", plan }, q.io)).toBe(1);
      expect(q.lines.join("\n")).toMatch(/isn't what the page listed any more/);
      expect(files(join(root, "catalog", "curated"))).toEqual(curated);
      // With the plan the page shows now, it goes ahead.
      const now = (await catalogBuildView(root)).pending.plan;
      expect(await catalogEdits(root, { curate: true, by: "pat", plan: now }, q.io)).toBe(0);
    },
    T,
  );

  it(
    "catalog undo --yes with the page's plan undoes nothing when another build wrote since the page listed it",
    async () => {
      const root = await upgraded();
      const { catalogUndoView } = await import("../src/build-report.js");
      const { catalogUndo } = await import("../src/catalog-build-commands.js");
      const plan = (await catalogUndoView(root)).plan!.hash;
      await edit(root, setting, /valueOrRef: \S+/, "valueOrRef: 9000ms");
      expect((await atticus(root, "catalog", "edits", "--curate", "--by", "pat")).code).toBe(0);
      expect((await atticus(root, "catalog", "build")).code).toBe(0);
      const before = {
        g: files(join(root, "catalog", "generated")),
        s: files(join(root, "catalog", "sources")),
      };
      const q = quiet();
      expect(await catalogUndo(root, { yes: true, plan }, q.io)).toBe(1);
      expect(q.lines.join("\n")).toMatch(/isn't what the page listed any more/);
      expect({
        g: files(join(root, "catalog", "generated")),
        s: files(join(root, "catalog", "sources")),
      }).toEqual(before);
    },
    T,
  );

  it(
    "catalog prune --yes with the page's plan removes nothing when what it lists changed since the page listed it",
    async () => {
      const root = await upgraded();
      const { catalogPruneView } = await import("../src/build-report.js");
      const { catalogPrune } = await import("../src/catalog-build-commands.js");
      const plan = (await catalogPruneView(root)).plan;
      const copy = join(root, "catalog", "sources", "legacy", "generated-before-upgrade");
      await rm(join(copy, ...setting.split("/")));
      const left = files(copy);
      const q = quiet();
      expect(await catalogPrune(root, { yes: true, plan }, q.io)).toBe(1);
      expect(q.lines.join("\n")).toMatch(/isn't what the page listed any more/);
      expect(files(copy)).toEqual(left);
    },
    T,
  );
});

describe("a second catalog edits --curate of a record is its own decision (the review, N6 and its second review)", () => {
  const SETTING = "setting/portal-bff.ledger-read-timeout.yaml";
  const DECISIONS = ["catalog", "curated", "curateddecision"];
  const FIRST = "cd-edit-assert-portal-bff-ledger-read-timeout.yaml";
  const SECOND = "cd-edit-assert-portal-bff-ledger-read-timeout-2.yaml";

  it(
    "alice curates one field (her decision proposed: pr set), bob another: her file untouched, his its own, the build keeps both",
    async () => {
      const root = await upgraded();
      const path = join(root, "catalog", "generated", ...SETTING.split("/"));
      await writeFile(path, (await readFile(path, "utf8")).replace("5000ms", "7000ms"));
      const first = await atticus(root, "catalog", "edits", "--curate", "--by", "alice");
      expect(first.code, first.all()).toBe(0);
      // Alice proposes her decision: its file says the pull request.
      const aliceFile = join(root, ...DECISIONS, FIRST);
      const p = deserializeRecord(await readFile(aliceFile, "utf8"));
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      const pr = "https://git.forge.example/forge/metarepo/pull/12";
      await writeFile(aliceFile, serializeRecord({ ...p.record, pr } as CatalogRecord));
      const aliceText = await readFile(aliceFile, "utf8");
      expect((await atticus(root, "catalog", "build")).code).toBe(0);
      await writeFile(
        path,
        (await readFile(path, "utf8")).replace("target: ledger-api", "target: ledger-api-v2"),
      );
      const second = await atticus(root, "catalog", "edits", "--curate", "--by", "bob");
      expect(second.code, second.all()).toBe(0);
      expect(second.out.join("\n")).toContain(SECOND);
      // Alice's decision is hers, byte for byte: by alice, her pr, her one field.
      expect(await readFile(aliceFile, "utf8")).toBe(aliceText);
      expect(aliceText).toMatch(/^by: alice$/m);
      expect(aliceText).toContain(`pr: ${pr}`);
      const bob = await readFile(join(root, ...DECISIONS, SECOND), "utf8");
      expect(bob).toMatch(/^by: bob$/m);
      expect(bob).toMatch(/target: ledger-api-v2/);
      expect(bob).not.toMatch(/valueOrRef/);
      expect(bob).not.toMatch(/^pr:/m);
      // Bob's applies after Alice's (later wins), and both fields survive.
      const at = (t: string) => /^at: (.+)$/m.exec(t)![1]!;
      expect(at(bob) > at(aliceText)).toBe(true);
      const b = await atticus(root, "catalog", "build");
      expect(b.code, b.all()).toBe(0);
      const built = await readFile(path, "utf8");
      expect(built).toMatch(/valueOrRef: 7000ms/);
      expect(built).toMatch(/target: ledger-api-v2/);
    },
    T,
  );

  it(
    "a field deleted in a hand edit is said and refused (a decision can't remove a field), never silently put back",
    async () => {
      const root = await upgraded();
      const path = join(root, "catalog", "generated", ...SETTING.split("/"));
      const original = await readFile(path, "utf8");
      const decisionsBefore = files(join(root, ...DECISIONS));
      // Only a deletion: nothing a decision can say, so it can't be made curated at all.
      await writeFile(path, original.replace("target: ledger-api\n", ""));
      const only = await atticus(root, "catalog", "edits", "--curate", "--by", "pat");
      expect(only.code).toBe(1);
      expect(only.all()).toMatch(/it only removes target, which a curated decision can't remove/);
      expect(only.all()).not.toMatch(/says the same as the build's/);
      expect(files(join(root, ...DECISIONS))).toEqual(decisionsBefore);
      // A deletion with a change: listed, and made curated only with --drop-fields <count>.
      await writeFile(
        path,
        original.replace("target: ledger-api\n", "").replace("5000ms", "7000ms"),
      );
      const list = await atticus(root, "catalog", "edits");
      expect(list.all()).toMatch(/removes target, which a curated decision can't remove/);
      expect(list.all()).toMatch(/atticus catalog edits --curate --drop-fields 1/);
      const plain = await atticus(root, "catalog", "edits", "--curate", "--by", "pat");
      expect(plain.code).toBe(1);
      expect(plain.all()).toMatch(/it also removes target/);
      expect(files(join(root, ...DECISIONS))).toEqual(decisionsBefore);
      expect((await atticus(root, "catalog", "build")).code).toBe(1);
      const ok = await atticus(
        root,
        "catalog",
        "edits",
        "--curate",
        "--drop-fields",
        "1",
        "--by",
        "pat",
      );
      expect(ok.code, ok.all()).toBe(0);
      expect(ok.all()).toMatch(/made curated without target/);
      const b = await atticus(root, "catalog", "build");
      expect(b.code, b.all()).toBe(0);
      const built = await readFile(path, "utf8");
      expect(built).toMatch(/valueOrRef: 7000ms/);
      expect(built).toMatch(/target: ledger-api$/m);
    },
    T,
  );
});
