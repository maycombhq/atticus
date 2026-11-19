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
    "a later curate of the same field wins over an earlier decision whose `at` has an offset (its text sorts after now)",
    async () => {
      const root = await upgraded();
      const path = join(root, "catalog", "generated", ...SETTING.split("/"));
      await writeFile(path, (await readFile(path, "utf8")).replace("5000ms", "7000ms"));
      expect((await atticus(root, "catalog", "edits", "--curate", "--by", "alice")).code).toBe(0);
      // Alice's decision, dated an hour ago in +14:00: its text is tomorrow's, after now's.
      const aliceFile = join(root, ...DECISIONS, FIRST);
      const p = deserializeRecord(await readFile(aliceFile, "utf8"));
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      const hourAgo = new Date(Date.now() - 3_600_000 + 14 * 3_600_000);
      const at = `${hourAgo.toISOString().slice(0, 19)}+14:00`;
      expect(at > new Date().toISOString()).toBe(true);
      await writeFile(aliceFile, serializeRecord({ ...p.record, at } as CatalogRecord));
      expect((await atticus(root, "catalog", "build")).code).toBe(0);
      await writeFile(path, (await readFile(path, "utf8")).replace("7000ms", "9000ms"));
      const second = await atticus(root, "catalog", "edits", "--curate", "--by", "bob");
      expect(second.code, second.all()).toBe(0);
      const b = await atticus(root, "catalog", "build");
      expect(b.code, b.all()).toBe(0);
      expect(await readFile(path, "utf8")).toMatch(/valueOrRef: 9000ms/);
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
      expect(only.all()).toMatch(/it only removes target, which a kept edit can't remove/);
      expect(only.all()).not.toMatch(/says the same as the build's/);
      expect(files(join(root, ...DECISIONS))).toEqual(decisionsBefore);
      // A deletion with a change: listed, and made curated only with --drop-fields <count>.
      await writeFile(
        path,
        original.replace("target: ledger-api\n", "").replace("5000ms", "7000ms"),
      );
      const list = await atticus(root, "catalog", "edits");
      expect(list.all()).toMatch(/removes target, which a kept edit can't remove/);
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
      expect(ok.all()).toMatch(/kept as your edit without target/);
      const b = await atticus(root, "catalog", "build");
      expect(b.code, b.all()).toBe(0);
      const built = await readFile(path, "utf8");
      expect(built).toMatch(/valueOrRef: 7000ms/);
      expect(built).toMatch(/target: ledger-api$/m);
    },
    T,
  );
});

describe("an edit of a record a person's suppress, not yet built, takes out (property seed 1560540612)", () => {
  const DECISIONS = ["catalog", "curated", "curateddecision"];

  /** The Forge metarepo built from its golden readers slots: no upgrade, no legacy slot. */
  async function built(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "atticus-slots-review-"));
    made.push(root);
    await cp(join(FIXTURES, "forge", "metarepo"), root, { recursive: true });
    await cp(
      join(FIXTURES, "forge", "slots", "readers"),
      join(root, "catalog", "sources", "readers"),
      { recursive: true },
    );
    const b = await atticus(root, "catalog", "build");
    expect(b.code, b.all()).toBe(0);
    return root;
  }

  it(
    "edits --curate drafts the assert against the record as the last build made it, and it waits while the suppress holds",
    async () => {
      const root = await built();
      const dir = join(root, "catalog", "generated", "endpoint");
      const file = readdirSync(dir).sort()[0]!;
      const path = join(dir, file);
      const p = deserializeRecord(await readFile(path, "utf8"));
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      const rec = p.record as CatalogRecord & { auth?: string };
      const auth = rec.auth === "mtls" ? "basic" : "mtls";
      // The person's suppress, its build not run yet (or refused for a large removal): the
      // catalog still holds the record as the last build made it, and they edit that file.
      await mkdir(join(root, ...DECISIONS), { recursive: true });
      await writeFile(
        join(root, ...DECISIONS, "cd-suppress-endpoint.yaml"),
        [
          "schemaVersion: 5",
          "kind: CuratedDecision",
          "id: cd-suppress-endpoint",
          "status: current",
          "confidence: asserted",
          `target: ${rec.id}`,
          "action: suppress",
          "value: null",
          "reason: A person's decision in a test.",
          "by: pat",
          "at: 2026-11-11T10:00:00Z",
          "",
        ].join("\n"),
      );
      await writeFile(path, serializeRecord({ ...rec, auth } as CatalogRecord));
      const curate = await atticus(root, "catalog", "edits", "--curate", "--by", "pat");
      expect(curate.all()).not.toMatch(/the build no longer makes it/);
      expect(curate.code, curate.all()).toBe(0);
      const drafted = Object.entries(files(join(root, ...DECISIONS))).filter(([f]) =>
        f.startsWith("cd-edit-assert-"),
      );
      expect(drafted).toHaveLength(1);
      expect(drafted[0]![1]).toMatch(/action: assert/);
      expect(drafted[0]![1]).toContain(`auth: ${auth}`);
      expect(drafted[0]![1]).toContain(`target: ${rec.id}`);
      // The build takes the record out (the suppress), the edit's file with it, as no hand edit:
      // the assert is kept, waiting for the record to come back.
      const b = await atticus(root, "catalog", "build", "--json");
      const refused = (
        JSON.parse(b.out.join("\n")) as {
          refused?: { allowRemovals?: number; reasons: string[] };
        }
      ).refused;
      expect(refused?.reasons ?? []).not.toContain("hand-edits");
      if (refused?.allowRemovals !== undefined)
        expect(
          (
            await atticus(
              root,
              "catalog",
              "build",
              "--allow-removals",
              String(refused.allowRemovals),
            )
          ).code,
        ).toBe(0);
      expect(existsSync(path)).toBe(false);
      expect(Object.keys(files(join(root, ...DECISIONS)))).toContain(drafted[0]![0]);
      // The draft holds only what the person changed.
      const d = deserializeRecord(drafted[0]![1]);
      if (!d.ok) throw new Error(JSON.stringify(d.issues));
      expect((d.record as unknown as { value: Record<string, unknown> }).value).toEqual({ auth });
      // The suppress taken away, the record comes back as it was, with the edit's field.
      await rm(join(root, ...DECISIONS, "cd-suppress-endpoint.yaml"));
      const back = await atticus(root, "catalog", "build");
      expect(back.code, back.all()).toBe(0);
      const now = deserializeRecord(await readFile(path, "utf8"));
      if (!now.ok) throw new Error(JSON.stringify(now.issues));
      // An assert's record: the person's field, `asserted`, and their evidence beside the code's.
      const {
        confidence: _c,
        evidence,
        ...fields
      } = now.record as CatalogRecord & {
        auth?: string;
      };
      const { confidence: _o, evidence: was, ...before } = rec;
      expect(fields).toEqual({ ...before, auth });
      expect(evidence).toEqual(expect.arrayContaining(was));
    },
    T,
  );

  it(
    "reads it against the record only as the last build wrote it: a slot changed since widens no draft",
    async () => {
      const root = await built();
      const dir = join(root, "catalog", "generated", "endpoint");
      const file = readdirSync(dir).sort()[0]!;
      const path = join(dir, file);
      const p = deserializeRecord(await readFile(path, "utf8"));
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      const rec = p.record as CatalogRecord & { auth?: string; pathOrTopic?: string };
      await mkdir(join(root, ...DECISIONS), { recursive: true });
      await writeFile(
        join(root, ...DECISIONS, "cd-suppress-endpoint.yaml"),
        [
          "schemaVersion: 5",
          "kind: CuratedDecision",
          "id: cd-suppress-endpoint",
          "status: current",
          "confidence: asserted",
          `target: ${rec.id}`,
          "action: suppress",
          "value: null",
          "reason: A person's decision in a test.",
          "by: pat",
          "at: 2026-11-11T10:00:00Z",
          "",
        ].join("\n"),
      );
      // A read since the last build changed the record's auth in its slot (its build not run).
      const repo = String(rec.evidence[0]!.repo);
      const slotPath = join(root, "catalog", "sources", "readers", `${repo}.json`);
      const slot = JSON.parse(await readFile(slotPath, "utf8")) as {
        records: { id: string; auth?: string }[];
      };
      const inSlot = slot.records.find((r) => r.id === rec.id)!;
      expect(inSlot, "the slot holds the record by its id").toBeDefined();
      inSlot.auth = rec.auth === "basic" ? "mtls" : "basic";
      await writeFile(slotPath, JSON.stringify(slot, null, 2) + "\n");
      // The person edits only the path.
      await writeFile(
        path,
        serializeRecord({ ...rec, pathOrTopic: `${rec.pathOrTopic}/v2` } as CatalogRecord),
      );
      const curate = await atticus(root, "catalog", "edits", "--curate", "--by", "pat");
      const drafts = Object.entries(files(join(root, ...DECISIONS))).filter(([f]) =>
        f.startsWith("cd-edit-assert-"),
      );
      // Never an assert of auth, which the person didn't change.
      for (const [, t] of drafts) expect(t, curate.all()).not.toMatch(/^\s*auth:/m);
      if (drafts.length) expect(drafts[0]![1]).toContain(`pathOrTopic: ${rec.pathOrTopic}/v2`);
      else expect(curate.all()).toContain(file);
    },
    T,
  );
});

describe("edits --curate on a catalog whose upgrade was undone (property seed 1562698156)", () => {
  it(
    "refuses, saying the catalog is from before beta.27 and the upgrade adopts its files, and writes no decision",
    async () => {
      const root = await upgraded();
      const undo = await atticus(root, "catalog", "undo", "--yes");
      expect(undo.code, undo.all()).toBe(0);
      expect(existsSync(join(root, "catalog", "sources", "build.json"))).toBe(false);
      // A record added by hand: before the upgrade, no file is a hand edit yet.
      const dir = join(root, "catalog", "generated", "endpoint");
      const file = readdirSync(dir).sort()[0]!;
      const text = await readFile(join(dir, file), "utf8");
      await writeFile(join(dir, `by-hand.${file}`), text);
      const decisions = join(root, "catalog", "curated", "curateddecision");
      const before = files(decisions);
      for (const args of [["--curate", "--by", "pat"], []]) {
        const r = await atticus(root, "catalog", "edits", ...args, "--json");
        expect(r.code, r.all()).toBe(1);
        expect(r.all()).toMatch(/written before beta\.27/);
        expect(r.all()).toMatch(/atticus upgrade/);
        expect(r.all()).not.toMatch(/No file under catalog\/generated was changed by hand/);
        const j = JSON.parse(r.out.join("\n")) as { refused?: { reasons: string[] } };
        expect(j.refused?.reasons).toEqual(["not-upgraded"]);
      }
      expect(files(decisions)).toEqual(before);
    },
    T,
  );
});
