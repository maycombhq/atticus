import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import {
  DEFAULT_CHANGE_POLICY,
  changeFootprint,
  changeReport,
  changeStore,
  detectConflicts,
  loadChangeContext,
  scoreRisk,
  stageCompletion,
  testPlanFor,
} from "../src/index.js";

/**
 * A change taken through the feature, architecture and stories stages (ADR 0087), whose files are
 * all Atticus 2 writes: feature.yaml, target-flows/, stories and tasks, no proposal.md,
 * interfaces.md or data.md. Its footprint, risk, test kinds, conflicts and state come from them
 * (ADR 0124 addendum B-change).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const STAGES = join(HERE, "../../../fixtures/stages");
const FIX = join(STAGES, "footprint");
const CHANGE = "screen-order-consent";
const FLOW = "target-flows/forge-orders.place-order.yaml";

async function estate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-stage-footprint-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const rows = [
    ...(parse(readFileSync(join(STAGES, "../specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(STAGES, "catalog-extra.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "catalog.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(STAGES, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, CHANGE), join(root, "openspec/changes", CHANGE), { recursive: true });
  await cp(join(STAGES, "changes/bulk-orders"), join(root, "openspec/changes/bulk-orders"), {
    recursive: true,
  });
  return root;
}

describe("a change's footprint from the stages' files (B-change)", () => {
  it("reads feature.yaml and the target flows, though change.yaml declares nothing", async () => {
    const root = await estate();
    const ctx = await loadChangeContext(root);
    const change = await changeStore(root).read(CHANGE);
    expect(change.touches.repos).toEqual([]);
    const fp = await changeFootprint(ctx, change);
    expect(fp).toMatchObject({
      systems: ["forge", "northwind-pay"],
      components: ["forge-orders"],
      repos: ["forge-orders"],
      dataStores: ["forge-orders-db"],
      tables: ["forge-orders-db.customer_consent"],
      columns: [
        "forge-orders-db.customer_consent.customer_id",
        "forge-orders-db.customer_consent.purpose",
        "forge-orders-db.customer_consent.revoked_at",
      ],
      entries: ["forge-orders.post-orders"],
      newEntries: [],
      fields: ["cardToken", "customerId", "quantity", "scope", "sku", "verdict"],
      flows: [
        { id: "forge-orders.place-order", repo: "forge-orders", change: "modify" },
        { id: "forge-stock.reserve-stock", repo: "forge-stock", change: "read" },
      ],
      outside: [{ id: "northwind-pay", entries: ["POST /v1/screenings"], cite: `${FLOW}:32` }],
      from: ["feature.yaml", FLOW, "tasks.md"],
    });
  });

  it("raises a risk factor for each thing the deltas do that matters, each citing its step", async () => {
    const root = await estate();
    const ctx = await loadChangeContext(root);
    const fp = await changeFootprint(ctx, await changeStore(root).read(CHANGE));
    const risk = scoreRisk({ type: "feature", footprint: fp }, ctx.policy);
    expect(["medium", "high"]).toContain(risk.level);
    const cited = risk.factors.filter((f) => f.cites?.length);
    expect(cited.map((f) => [f.factor, f.cites])).toEqual([
      ["outside-call", [`${FLOW}:32`]],
      ["auth", [`${FLOW}:8`]],
      ["personal-data", [`${FLOW}:18`]],
    ]);
    expect(cited[0]!.detail).toBe(
      "calls an outside system: northwind-pay (POST /v1/screenings, new)",
    );
    expect(cited[1]!.detail).toContain("403");
    expect(cited[2]!.detail).toContain("consent");
    // The vendor boundary is said once, by the call that crosses it.
    expect(risk.factors.map((f) => f.factor)).not.toContain("vendor");
  });

  it("asks the test kinds the factors call for, on top of the strategy's row, and says why", async () => {
    const root = await estate();
    const ctx = await loadChangeContext(root);
    const fp = await changeFootprint(ctx, await changeStore(root).read(CHANGE));
    const risk = scoreRisk({ type: "feature", footprint: fp }, ctx.policy);
    const plan = testPlanFor(ctx, "feature", risk);
    expect(plan.required).toEqual(expect.arrayContaining(["contract", "integration", "security"]));
    expect(plan.added?.map((a) => [a.factor, a.kinds])).toEqual([
      ["outside-call", ["contract", "integration"]],
      ["auth", ["security"]],
      ["personal-data", ["security"]],
    ]);
    expect(plan.added?.[0]?.why).toContain("a stub of northwind-pay");
    expect(plan.added?.[0]?.cites).toEqual([`${FLOW}:32`]);
  });

  it("an org's change policy can weigh the factors and say what they ask", async () => {
    const root = await estate();
    await mkdir(join(root, "org-pack/process"), { recursive: true });
    await writeFile(
      join(root, "org-pack/process/change-policy.yaml"),
      "schemaVersion: 1\nrisk:\n  weights: { outsideCall: 0, personalData: 0, dataStore: 0, extraSystem: 0 }\n  tests: { auth: [security, e2e] }\n",
    );
    const ctx = await loadChangeContext(root);
    expect(ctx.problems).toEqual([]);
    const fp = await changeFootprint(ctx, await changeStore(root).read(CHANGE));
    const risk = scoreRisk({ type: "feature", footprint: fp }, ctx.policy);
    // A factor weighed at 0 isn't one: the type (2) and the authorisation rule (3) are left.
    expect(risk.factors.map((f) => f.factor)).toEqual(["type", "auth"]);
    expect(risk.level).toBe("medium");
    expect(testPlanFor(ctx, "feature", risk).added?.map((a) => [a.factor, a.kinds])).toEqual([
      ["auth", ["security", "e2e"]],
    ]);
  });

  it("doesn't read a status code shown by a page, or a class named in passing, as an authorisation change; weighs a second repo", async () => {
    const root = await estate();
    await writeFile(
      join(root, "openspec/changes", CHANGE, "target-flows/forge-stock.reserve-stock.yaml"),
      [
        "schemaVersion: 2",
        "flow: forge-stock.reserve-stock",
        "repo: forge-stock",
        "change: modify",
        "why: The reservation says when the screen held it.",
        "steps:",
        "  - op: add",
        "    after: 1",
        "    kind: branch",
        "    what: When a reservation is refused (a 403 from the screen), say so in the reply.",
        "  - op: add",
        "    after: 1",
        "    kind: transform",
        "    uses: src/main/java/forge/stock/ReserveScope.java:3",
        "    what: Work out the hold with ReserveScope.of(order).",
        "",
      ].join("\n"),
    );
    const ctx = await loadChangeContext(root);
    const fp = await changeFootprint(ctx, await changeStore(root).read(CHANGE));
    expect(fp.signals.filter((s) => s.factor === "auth").map((s) => s.cite)).toEqual([`${FLOW}:8`]);
    const risk = scoreRisk({ type: "feature", footprint: fp }, ctx.policy);
    expect(risk.factors.find((f) => f.factor === "spread")).toEqual({
      factor: "spread",
      detail: "spans several repos: 2 repos (forge-orders, forge-stock)",
      points: 1,
      cites: [FLOW],
    });
  });

  it("doesn't score a new flow's entry as breaking who uses it today: a new entry has no users (beta.30)", async () => {
    // From a trial run: a new flow's entry step, with the fields it requires, added
    // "breaks who uses it today … +3" to the risk score.
    const NEW = "target-flows/forge-orders.pin-note.yaml";
    const PIN_AT = { flow: "forge-orders.pin-note", entry: "PUT /orders/{orderId}/pin" };
    const pin = (change: string, entry: string[], at = PIN_AT) =>
      [
        "schemaVersion: 2",
        `flow: ${at.flow}`,
        "repo: forge-orders",
        `change: ${change}`,
        "name: Pin a note",
        `trigger: { kind: endpoint, what: A shopper pins a note of an order, entry: "${at.entry}" }`,
        "why: A shopper pins one note to the top of the order's notes.",
        "steps:",
        "  - op: add",
        "    after: 0",
        "    kind: entry",
        "    what: OrderController receives the note to pin",
        ...entry,
        "",
      ].join("\n");
    const breakingOf = async (change: string, entry: string[], at = PIN_AT) => {
      const root = await estate();
      await writeFile(join(root, "openspec/changes", CHANGE, NEW), pin(change, entry, at));
      const ctx = await loadChangeContext(root);
      const fp = await changeFootprint(ctx, await changeStore(root).read(CHANGE));
      const risk = scoreRisk({ type: "feature", footprint: fp }, ctx.policy);
      return {
        signals: fp.signals.filter((x) => x.factor === "breaking"),
        factor: risk.factors.find((f) => f.factor === "breaking"),
        score: risk.score,
        newEntries: fp.newEntries,
      };
    };
    const REQUIRED = ["    fields: { reads: [orderId, noteId], required: [orderId, noteId] }"];
    const plain = await breakingOf("new", ["    fields: { reads: [orderId, noteId] }"]);
    const required = await breakingOf("new", REQUIRED);
    expect(required.newEntries).toEqual(["forge-orders PUT /orders/{orderId}/pin"]);
    expect(required.signals).toEqual([]);
    expect(required.factor).toBeUndefined();
    expect(required.score).toBe(plain.score);
    // What the draft says outright always counts: marked breaking, or the callers it breaks.
    const marked = await breakingOf("new", [...REQUIRED, "    breaking: true"]);
    expect(marked.factor).toMatchObject({ points: 3 });
    expect(marked.factor!.detail).toContain("is marked breaking");
    const listed = await breakingOf("new", [...REQUIRED, "consumers: [forge-shop-bff]"]);
    expect(listed.factor).toMatchObject({
      detail: "breaks who uses it today: flow forge-orders.pin-note breaks forge-shop-bff",
      points: 3,
    });

    // Review of beta.30: a flow called new whose entry is one people call today (a second
    // version of place-order on POST /orders) breaks them as a changed flow does.
    const V2 = { flow: "forge-orders.place-order-v2", entry: "POST /orders" };
    const CHANNEL = ["    fields: { reads: [sku, channel], required: [channel] }"];
    const v2 = await breakingOf("new", CHANNEL, V2);
    expect(v2.newEntries).toEqual([]);
    expect(v2.factor).toMatchObject({
      detail: "breaks who uses it today: entry step now requires channel",
      points: 3,
    });
    const v2Plain = await breakingOf("new", ["    fields: { reads: [sku, channel] }"], V2);
    expect(v2.score).toBe(v2Plain.score + 3);

    // A flow people use today is another matter: a field it now requires breaks them.
    const root = await estate();
    const dir = join(root, "openspec/changes", CHANGE);
    const today = readFileSync(join(dir, FLOW), "utf8");
    await writeFile(
      join(dir, FLOW),
      `${today.trimEnd()}\n  - op: add\n    after: 1\n    kind: validate\n    what: The order names its channel\n    fields: { required: [channel] }\n`,
    );
    const ctx = await loadChangeContext(root);
    const fp = await changeFootprint(ctx, await changeStore(root).read(CHANGE));
    const risk = scoreRisk({ type: "feature", footprint: fp }, ctx.policy);
    expect(risk.factors.find((f) => f.factor === "breaking")).toMatchObject({
      detail: "breaks who uses it today: validate step now requires channel",
      points: 3,
    });
  });

  it("knows an entry people call today however the draft writes its path (review of beta.30)", async () => {
    // A trailing slash, a query string, a fragment or a whole URL is still POST /orders: a new
    // flow on it that requires a field breaks who calls it. Case is kept: /Orders may be another route.
    const entryOf = async (entry: string) => {
      const root = await estate();
      await writeFile(
        join(root, "openspec/changes", CHANGE, "target-flows/forge-orders.place-order-v2.yaml"),
        [
          "schemaVersion: 2",
          "flow: forge-orders.place-order-v2",
          "repo: forge-orders",
          "change: new",
          "name: Place an order, second version",
          `trigger: { kind: endpoint, what: A shopper places an order, entry: "${entry}" }`,
          "why: The order names its channel.",
          "steps:",
          "  - op: add",
          "    after: 0",
          "    kind: entry",
          "    what: OrderController receives the order",
          "    fields: { reads: [sku, channel], required: [channel] }",
          "",
        ].join("\n"),
      );
      const ctx = await loadChangeContext(root);
      const fp = await changeFootprint(ctx, await changeStore(root).read(CHANGE));
      return {
        entries: fp.entries,
        newEntries: fp.newEntries,
        breaking: fp.signals.filter((x) => x.factor === "breaking").map((x) => x.detail),
      };
    };
    for (const entry of [
      "POST /orders",
      "POST /orders/",
      "POST /orders?channel=web",
      "POST /orders#new",
      "POST https://shop.forge.example/orders",
      "POST https://shop.forge.example:8443/orders/?channel=web",
      "post //orders",
    ]) {
      const r = await entryOf(entry);
      expect(r.newEntries, entry).toEqual([]);
      expect(r.entries, entry).toEqual(["forge-orders.post-orders"]);
      expect(r.breaking, entry).toEqual(["entry step now requires channel"]);
    }
    for (const entry of ["POST /Orders", "POST /orders/bulk-import", "DELETE /orders"]) {
      const r = await entryOf(entry);
      expect(r.newEntries, entry).toEqual([`forge-orders ${entry}`]);
      expect(r.breaking, entry).toEqual([]);
    }
  });

  it("finds the conflict with another open change on the same flow", async () => {
    const root = await estate();
    const pairs = await detectConflicts(root);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.changes).toEqual(["bulk-orders", CHANGE]);
    expect(pairs[0]!.overlap.flows).toEqual(["forge-orders.place-order"]);
  });

  it("says where the work is: stories done, the define hand-off not raised", async () => {
    const root = await estate();
    const ctx = await loadChangeContext(root);
    const change = await changeStore(root).read(CHANGE);
    expect((await stageCompletion(ctx, change)).map((s) => [s.stage, s.phase, s.state])).toEqual([
      ["feature", "define", "done"],
      ["architecture", "design", "done"],
      ["stories", "plan", "done"],
    ]);
    const r = await changeReport(root, CHANGE);
    expect(r.state).toBe("define");
    expect(r.progress).toEqual({
      done: ["feature", "architecture", "stories"],
      ahead: ["design", "plan"],
      summary:
        'Stories done; the change is still in define: raise "Send to architecture" (the define hand-off), then the design and plan hand-offs.',
    });
    expect(r.nextStep).toBe('Ready to raise "Send to architecture".');
    expect(r.risk.level).not.toBe("low");
    expect(r.tests.required).toEqual(expect.arrayContaining(["security"]));
  });

  it("a change on the change-draft path keeps its old reading", () => {
    const fp = {
      systems: ["forge"],
      components: [],
      interfaces: [],
      dataStores: [],
      tables: [],
      records: [],
      repos: [],
      vendors: [],
      personal: [],
      flows: [],
      entries: [],
      newEntries: [],
      calls: [],
      columns: [],
      fields: [],
      outside: [],
      signals: [],
      from: ["proposal.md"],
    };
    expect(scoreRisk({ type: "feature", footprint: fp }, DEFAULT_CHANGE_POLICY).factors).toEqual([
      { factor: "type", detail: "change type feature", points: 2 },
    ]);
  });
});

describe("O2: a call to another team's system is a call outside the estate", () => {
  /** The same change, its screen sent to Risk Team: a profile system no estate repo belongs to. */
  async function teamEstate(): Promise<string> {
    const root = await estate();
    await mkdir(join(root, "org-pack/profiles/forge"), { recursive: true });
    await writeFile(
      join(root, "org-pack/profiles/forge/profile.yaml"),
      [
        "schemaVersion: 1",
        "platform: forge",
        "name: Forge",
        "systems:",
        "  - { id: forge, name: Forge, boundary: product, aliases: [] }",
        "  - { id: risk-team, name: Risk Team, boundary: internal, aliases: [] }",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "org-pack/profiles/forge/repos.manifest.yaml"),
      [
        "schemaVersion: 3",
        "platform: forge",
        "repos:",
        "  - { id: forge-orders, url: https://git.forge.example/forge/forge-orders.git, type: spring-boot, owner: team-orders, component: forge-orders, system: forge }",
        "",
      ].join("\n"),
    );
    const flow = join(root, "openspec/changes", CHANGE, FLOW);
    await writeFile(
      flow,
      readFileSync(flow, "utf8").replace("component: northwind-pay", "component: risk-team"),
    );
    return root;
  }

  it("lists it outside and among the other teams' systems, not the vendors", async () => {
    const root = await teamEstate();
    const ctx = await loadChangeContext(root);
    const fp = await changeFootprint(ctx, await changeStore(root).read(CHANGE));
    expect(fp.outside).toEqual([
      { id: "risk-team", entries: ["POST /v1/screenings"], cite: `${FLOW}:32` },
    ]);
    expect(fp.vendors).toEqual([]);
    expect(fp.otherTeams).toEqual(["risk-team"]);
  });

  it("weighs a touched team's system as a crossing, in its own words", () => {
    const fp = {
      systems: ["forge", "northwind-pay", "risk-team"],
      components: [],
      interfaces: [],
      dataStores: [],
      tables: [],
      records: [],
      repos: [],
      vendors: ["northwind-pay"],
      otherTeams: ["risk-team"],
      personal: [],
      flows: [],
      entries: [],
      newEntries: [],
      calls: [],
      columns: [],
      fields: [],
      outside: [],
      signals: [],
      from: ["proposal.md"],
    };
    expect(
      scoreRisk({ type: "feature", footprint: fp }, DEFAULT_CHANGE_POLICY).factors.filter(
        (f) => f.factor === "vendor",
      ),
    ).toEqual([
      {
        factor: "vendor",
        detail:
          "crosses the vendor boundary (northwind-pay); calls another team's system (risk-team)",
        points: DEFAULT_CHANGE_POLICY.risk.weights.vendor,
      },
    ]);
    const team = { ...fp, vendors: [], systems: ["forge", "risk-team"] };
    expect(
      scoreRisk({ type: "feature", footprint: team }, DEFAULT_CHANGE_POLICY).factors.find(
        (f) => f.factor === "vendor",
      )?.detail,
    ).toBe("calls another team's system (risk-team)");
  });
});
