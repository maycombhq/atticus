import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MockWorkTracker } from "@maycombhq/adapters";
import { MockRuntime } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord, type CatalogRecord } from "@maycombhq/core";
import { scanEstate } from "@maycombhq/scanner";
import {
  catalogMigrate,
  featureLink,
  featureList,
  featureMerge,
  featureName,
  featureShow,
  featureSpec,
  featureSplit,
  featureSuggestLinks,
  featureSuggestNames,
  featureTag,
} from "../src/feature-commands.js";

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

/** A metarepo with the Forge org pack, the expected catalog as generated files, and the inputs. */
async function forgeRoot(): Promise<string> {
  // The Forge dialect's own tests read ../../../repos/forge-ledger from its folder.
  const top = await mkdtemp(join(tmpdir(), "atticus-cli-feature-"));
  const root = join(top, "metarepo");
  await cp(join(FORGE, "repos/forge-ledger"), join(top, "repos/forge-ledger"), { recursive: true });
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack/sources.yaml"),
    "schemaVersion: 1\nwikis:\n  - { id: forge-wiki, type: markdown-folder, location: inputs/wiki }\n",
  );
  await cp(join(FORGE, "inputs"), join(root, "inputs"), { recursive: true });
  for (const r of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(String(r.id));
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  return root;
}

const scan = (root: string) =>
  scanEstate({
    root,
    repoDir: (id) => join(FORGE, "repos", id),
    repoState: async () => ({ commit: "a".repeat(40), dirty: false }),
    cache: null,
    scannedAt: "2026-10-18T09:00:00Z",
    inputsDir: join(root, "inputs"),
  });
const capabilities = (records: CatalogRecord[]) =>
  records.filter((r) => r.kind === "Capability") as (CatalogRecord & {
    name: string;
    namedBy: string;
    tags: string[];
  })[];

describe("features in the scan path", () => {
  it("every scan adds detected features, and a person's name wins over detection on the next scan", async () => {
    const root = await forgeRoot();
    const first = await scan(root);
    expect(first.problems).toEqual([]);
    expect(capabilities(first.records).map((f) => [f.id, f.name, f.namedBy])).toEqual([
      ["feature.account-balance", "Account balance", "detected"],
      ["feature.daily-entries-report", "Daily entries report", "detected"],
      ["feature.payments", "Payments", "detected"],
      ["feature.transfers", "Transfers", "detected"],
    ]);
    const c = capture();
    expect(
      await featureName(
        root,
        "transfers",
        "Money transfers",
        { by: "a.owner", owner: "team-ledger" },
        c.io,
      ),
    ).toBe(0);
    expect(c.out).toEqual([
      'Wrote catalog/curated/curateddecision/feature-name.transfers.yaml: feature.transfers is "Money transfers". Commit it so every scan keeps it.',
    ]);
    const second = await scan(root);
    expect(second.problems).toEqual([]);
    expect(capabilities(second.records).find((f) => f.id === "feature.transfers")).toMatchObject({
      name: "Money transfers",
      namedBy: "person",
      owner: "team-ledger",
      confidence: "asserted",
    });
  }, 120_000);
});

describe("atticus feature list and show", () => {
  it("lists the features with how each was named, and what no feature covers", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await featureList(root, {}, c.io)).toBe(0);
    expect(c.out).toEqual([
      "ID                            NAME                  NAMED BY  OWNER  ENTRY POINTS  LINKS",
      "feature.account-balance       Account balance       detected  -      2             0",
      "feature.daily-entries-report  Daily entries report  detected  -      1             0",
      "feature.payments              Payments              detected  -      1             0",
      "feature.transfers             Transfers             detected  -      2             0",
      "4 features: 0 confirmed, 4 detected only. No feature covers audit-svc.",
    ]);
    const j = capture();
    await featureList(root, { json: true }, j.io);
    const data = JSON.parse(j.out.join("\n")) as {
      features: { id: string }[];
      coverage: { unknown: string[] };
    };
    expect(data.features).toHaveLength(4);
    expect(data.coverage.unknown).toEqual(["audit-svc"]);
  });

  it("shows one feature: entry points, what it spans and its loose ends", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await featureShow(root, "feature.transfers", {}, c.io)).toBe(0);
    expect(c.out).toEqual([
      "Transfers (feature.transfers)",
      "  named by: detected, inferred",
      "  owner: -",
      "  tags: -",
      "  links: -",
      "Entry points:",
      "  ledger-api.post-transfer  POST /transfers on ledger-api",
      "  if-f1cd1f189eaa4b7b       event transfers.completed from ledger-api to reports-job",
      "Spans:",
      "  Component: ledger-api, portal-bff, reports-job",
      "  Endpoint: ledger-api.post-transfer, topic.transfers-completed",
      "  Interface: if-d99f508a2ac9b6e0, if-f1cd1f189eaa4b7b",
      "  Table: ledger-db.entry",
      "Loose ends:",
      "  nothing Atticus found makes portal-bff call POST /transfers",
    ]);
    const missing = capture();
    expect(await featureShow(root, "refunds", {}, missing.io)).toBe(1);
    expect(missing.err).toEqual([
      "There is no feature feature.refunds. List them with: atticus feature list",
    ]);
  });
});

describe("people name, tag, merge, split and link", () => {
  it("writes each answer as a curated decision the next listing already shows", async () => {
    const root = await forgeRoot();
    const io = capture();
    expect(
      await featureTag(root, "payments", ["Payments", "vendor"], { by: "a.owner" }, io.io),
    ).toBe(0);
    expect(await featureMerge(root, "transfers", ["payments"], { by: "a.owner" }, io.io)).toBe(0);
    expect(
      await featureSplit(
        root,
        "account-balance",
        ["ledger-api.get-balance"],
        { by: "a.owner", name: "Ledger balance" },
        io.io,
      ),
    ).toBe(0);
    expect(
      await featureLink(root, "transfers", "ado:102", { by: "a.owner", title: "Transfers" }, io.io),
    ).toBe(0);
    expect(io.out).toEqual([
      "Wrote catalog/curated/curateddecision/feature-tags.payments.yaml: feature.payments is tagged payments, vendor. Commit it so every scan keeps it.",
      "Wrote catalog/curated/curateddecision/feature-merge.transfers.payments.yaml: feature.payments is now part of feature.transfers. Commit it so every scan keeps it.",
      "Wrote catalog/curated/curateddecision/feature-split.ledger-balance.yaml and catalog/curated/curateddecision/feature-members.account-balance.yaml: ledger-api.get-balance now starts feature.ledger-balance. Commit them so every scan keeps them.",
      "Wrote catalog/curated/curateddecision/feature-link.transfers.ado-102.yaml: feature.transfers is linked to ado 102. Commit it so every scan keeps it.",
    ]);
    const c = capture();
    await featureList(root, { json: true }, c.io);
    const features = (JSON.parse(c.out.join("\n")) as { features: Record<string, unknown>[] })
      .features;
    expect(features.map((f) => [f.id, f.name, (f.entryPoints as string[]).length])).toEqual([
      ["feature.account-balance", "Balance", 1],
      ["feature.daily-entries-report", "Daily entries report", 1],
      ["feature.ledger-balance", "Ledger balance", 1],
      ["feature.transfers", "Transfers", 3],
    ]);
    expect(features.find((f) => f.id === "feature.transfers")!.externalRefs).toEqual([
      { system: "ado", id: "102", title: "Transfers" },
    ]);
  });

  it("refuses unknown features and bad input with clear messages", async () => {
    const root = await forgeRoot();
    const a = capture();
    expect(await featureName(root, "refunds", "Refunds", { by: "a.owner" }, a.io)).toBe(1);
    expect(a.err).toEqual([
      "There is no feature feature.refunds. List them with: atticus feature list",
    ]);
    const b = capture();
    expect(await featureTag(root, "payments", ["not a tag"], { by: "a.owner" }, b.io)).toBe(2);
    expect(b.err).toEqual(['"not a tag" isn\'t a tag: use lower-case words joined by "-".']);
    const d = capture();
    expect(await featureLink(root, "payments", "words", { by: "a.owner" }, d.io)).toBe(2);
    expect(d.err[0]).toMatch(/^"words" isn't a reference Atticus knows/);
    const e = capture();
    expect(
      await featureSplit(
        root,
        "payments",
        ["if-32d38aecd11b86b1"],
        { by: "a.owner", name: "X" },
        e.io,
      ),
    ).toBe(2);
    expect(e.err).toEqual([
      "That would move every entry point of feature.payments; rename it instead.",
    ]);
  });
});

describe("atticus feature suggest-links", () => {
  it("suggests links from the exported work items in inputs/ when the tracker has none", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await featureSuggestLinks(root, {}, c.io)).toBe(1);
    expect(c.out).toEqual([
      "2 links to confirm.",
      "",
      "feature-link.account-balance.ado-101",
      '  ADO story 101 "As a customer I can see my available balance" may be what built Account balance (feature.account-balance): it shares "balance".',
      "  at inputs/tickets/ado-stories.json:2",
      "  → atticus feature link feature.account-balance ado:101",
      "",
      "feature-link.transfers.ado-102",
      '  ADO story 102 "Transfers" may be what built Transfers (feature.transfers): it shares "transfer".',
      "  at inputs/tickets/ado-stories.json:3",
      "  → atticus feature link feature.transfers ado:102",
    ]);
  });

  it("reads the work tracker when it answers, and falls back to the exports when it can't be reached", async () => {
    const root = await forgeRoot();
    const tracker = new MockWorkTracker([
      {
        id: "9001",
        type: "epic",
        title: "Daily entries report",
        description: "",
        acceptanceCriteria: "",
        state: "Active",
        tags: [],
        url: "https://work.example.com/items/9001",
      },
    ]);
    const j = capture();
    await featureSuggestLinks(root, { json: true, workTracker: tracker }, j.io);
    const items = (JSON.parse(j.out.join("\n")) as { items: { id: string }[] }).items;
    expect(items.map((i) => i.id)).toEqual([
      "feature-link.account-balance.ado-101",
      "feature-link.daily-entries-report.ado-9001",
      "feature-link.transfers.ado-102",
    ]);
    tracker.failNext("unavailable");
    const down = capture();
    expect(await featureSuggestLinks(root, { workTracker: tracker }, down.io)).toBe(1);
    expect(down.err[0]).toMatch(
      /^The work tracker can't be reached \(.*\); using the work-item exports in inputs\/ instead\.$/,
    );
    expect(down.out[0]).toBe("2 links to confirm.");
  });
});

describe("atticus feature spec", () => {
  it("drafts a spec for a confirmed feature and never overwrites one", async () => {
    const root = await forgeRoot();
    const unconfirmed = capture();
    expect(await featureSpec(root, "transfers", unconfirmed.io)).toBe(1);
    expect(unconfirmed.err).toEqual([
      "feature.transfers isn't confirmed yet: name it with atticus feature name first",
    ]);
    await featureName(
      root,
      "transfers",
      "Money transfers",
      { by: "a.owner", description: "Moves money." },
      capture().io,
    );
    const c = capture();
    expect(await featureSpec(root, "transfers", c.io)).toBe(0);
    expect(c.out).toEqual([
      "Wrote openspec/specs/transfers/spec.md, a draft from feature.transfers: check its requirements, then commit it in a pull request.",
    ]);
    const text = await readFile(join(root, "openspec/specs/transfers/spec.md"), "utf8");
    expect(text.startsWith("# Money transfers Specification\n")).toBe(true);
    const again = capture();
    expect(await featureSpec(root, "transfers", again.io)).toBe(1);
    expect(again.err).toEqual([
      "openspec/specs/transfers/spec.md already exists; Atticus never overwrites a spec.",
    ]);
  });
});

describe("atticus feature suggest-names", () => {
  it("asks the naming agent and writes its proposals, which the next listing shows", async () => {
    const root = await forgeRoot();
    const runtime = new MockRuntime(
      () =>
        "features:\n  - id: feature.payments\n    name: Vendor payments\n    tags: [payments]\n    evidence: [if-e7344c9455608119]\n",
    );
    const c = capture();
    expect(await featureSuggestNames(root, { runtime }, c.io)).toBe(0);
    expect(c.out).toEqual([
      'Wrote catalog/proposals/capability/feature.payments.yaml: feature.payments could be called "Vendor payments".',
      "1 proposal from feature-namer; confirm one with: atticus feature name <feature> <name>",
    ]);
    const l = capture();
    await featureList(root, {}, l.io);
    expect(l.out[3]).toBe(
      "feature.payments              Vendor payments       ai        -      1             0",
    );
  });
});

describe("atticus catalog migrate", () => {
  it("rewrites version-1 catalog files as version 2 and says which", async () => {
    const root = await forgeRoot();
    await mkdir(join(root, "catalog/curated/curateddecision"), { recursive: true });
    await writeFile(
      join(root, "catalog/curated/curateddecision/alias.ledger-platform.yaml"),
      "schemaVersion: 1\nkind: CuratedDecision\nid: alias.ledger-platform\nstatus: current\nconfidence: asserted\ntarget: ledger-api\naction: alias\nvalue: Ledger Platform\nreason: diagram name\nby: a.owner\nat: 2026-10-18T10:00:00Z\n",
    );
    const c = capture();
    expect(await catalogMigrate(root, c.io)).toBe(0);
    expect(c.out).toEqual([
      "  catalog/curated/curateddecision/alias.ledger-platform.yaml",
      "Migrated 1 file to catalog schema version 2; 46 already current. Commit the change.",
    ]);
    expect(
      (
        await readFile(
          join(root, "catalog/curated/curateddecision/alias.ledger-platform.yaml"),
          "utf8",
        )
      ).split("\n")[0],
    ).toBe("schemaVersion: 2");
    const again = capture();
    expect(await catalogMigrate(root, again.io)).toBe(0);
    expect(again.out).toEqual(["Every catalog file is already at schema version 2."]);
    expect((await readdir(join(root, "catalog/generated"))).length).toBeGreaterThan(0);
  });
});

describe("feature commands through main", () => {
  it("routes usage errors", async () => {
    const { main } = await import("../src/main.js");
    const err: string[] = [];
    const io = { out: () => {}, err: (l: string) => err.push(l) };
    expect(await main(["feature", "show"], io)).toBe(2);
    expect(await main(["feature", "name", "feature.x"], io)).toBe(2);
    expect(await main(["feature", "suggest-names"], io)).toBe(2);
    expect(err.join("\n")).toMatch(/needs a feature id/);
  });
});
