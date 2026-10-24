import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { loadChangeContext } from "@maycombhq/changes";
import {
  architectureStage,
  checkDeltas,
  checkStageDraft,
  dataChanges,
  deployIssues,
  endpointConsumers,
  estateOf,
  EXPAND_AGENT,
  FlowDelta,
  loadEstate,
  readTargetFlows,
  renderData,
  stageRuleKind,
  tableConsumers,
  type DeployStep,
  type Estate,
} from "../src/index.js";

/**
 * The architecture stage's checks (ADR 0124 addendum B-arch), on the hold-stock scenario
 * (fixtures/stages/hold-stock): forge-stock's reservation response returns a hold's id in place
 * of the reservation id, and forge-orders widens quantity. Every breaking contract change lists
 * the consumers the map knows, and the deploy order puts a callee before its caller and a
 * migration before the code that needs it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures");
const HOLD = join(FIX, "stages/hold-stock");
const NOW = new Date("2026-10-24T09:00:00Z");
const CHANGE = "hold-stock";
const LEVELS = ["public", "internal", "confidential", "restricted"];
const text = (name: string) => readFileSync(join(HOLD, "drafts", `${name}.yaml`), "utf8");

async function holdRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-hold-stock-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  // Later rows replace earlier ones with the same id (this scenario's orders table has readers).
  const rows = [
    ...(parse(readFileSync(join(FIX, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "stages/pin-table/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(HOLD, "catalog.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(HOLD, CHANGE), join(root, "openspec/changes", CHANGE), { recursive: true });
  return root;
}

async function estate(root: string): Promise<Estate> {
  return loadEstate(root, (await loadChangeContext(root)).records);
}

const placement = (root: string) =>
  readFile(join(root, "openspec/changes", CHANGE, "feature.yaml"), "utf8").then(
    (t) => parse(t) as Parameters<typeof checkDeltas>[2],
  );

interface Draft {
  flows: FlowDelta[];
  deploy?: DeployStep[];
}

const draftOf = (name: string): Draft => {
  const a = parse(text(name)) as { flows: object[]; deploy?: DeployStep[] };
  return {
    flows: a.flows.map((f) => FlowDelta.parse({ schemaVersion: 2, ...f })),
    ...(a.deploy ? { deploy: a.deploy } : {}),
  };
};

/** The stage's checks on a draft: the deltas' checks, then the deploy order's. */
async function checks(d: Draft, root?: string) {
  const r = root ?? (await holdRoot());
  const e = await estate(r);
  return [
    ...checkDeltas(d.flows, e, await placement(r), [], { levels: LEVELS }),
    ...deployIssues(d.flows, d.deploy, e),
  ];
}

const expected = (name: string) =>
  parse(readFileSync(join(HOLD, "expected", name), "utf8")) as [string, string, boolean][];

/** A mock assistant: the expander finds nothing new, critics find nothing, drafts in turn. */
function assistant(drafts: string[], seen: string[] = []) {
  let n = 0;
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === EXPAND_AGENT) return "terms: []\nnames: []\n";
      seen.push(req.pack.prompt);
      return drafts[Math.min(n++, drafts.length - 1)]!;
    },
    { now: () => NOW },
  );
}

describe("the consumers of what a change touches, from the map", () => {
  it("an endpoint's callers: an Interface record's caller, and a spec flow's call-out", async () => {
    const e = await estate(await holdRoot());
    expect(endpointConsumers(e, "forge-orders.post-orders")).toEqual(["forge-web"]);
    expect(endpointConsumers(e, "forge-stock.post-stock-reservations")).toEqual(["forge-orders"]);
  });

  it("a table's readers and writers, and the spec flows that store into it, the change's own left out", async () => {
    const e = await estate(await holdRoot());
    expect(tableConsumers(e, "forge-orders-db.orders", "forge-orders")).toEqual(["forge-reports"]);
    expect(tableConsumers(e, "forge-orders-db.orders")).toEqual(["forge-orders", "forge-reports"]);
  });
});

describe("every breaking contract change lists its consumers (check 2)", () => {
  it("a draft that lists none gets one finding a change, naming the consumers the map knows", async () => {
    const got = await checks(draftOf("no-consumers"));
    expect(got.map((i) => [i.rule, i.target, i.blocking])).toEqual(
      expected("no-consumers-findings.yaml"),
    );
    expect(got[0]!.message).toBe(
      "Flow forge-stock.reserve-stock changes POST /stock/reservations in a way that breaks who calls it today (it no longer returns reservationId), but doesn't list forge-orders, which the map shows calling it. List every caller under consumers: [forge-orders].",
    );
    expect(got[1]!.message).toBe(
      "Change 2 to forge-orders.place-order changes forge-orders-db.orders in a way that breaks who uses it today (it changes the type of quantity from INT to BIGINT), but doesn't list forge-reports, which the map shows reading or writing it. List them under store.consumers on that step: [forge-reports].",
    );
  });

  it("the draft that lists them, with a right deploy order, is clean", async () => {
    expect(await checks(draftOf("clean"))).toEqual([]);
  });

  it("a consumer the catalog doesn't have is handed back; one the map doesn't show calling is a note", async () => {
    const d = draftOf("clean");
    d.flows[0]!.consumers = ["forge-orders", "forge-mobile", "forge-web"];
    const got = (await checks(d)).map((i) => [i.rule, i.target, i.blocking]);
    expect(got).toEqual([
      ["delta.unknown-consumer", "forge-stock.reserve-stock:forge-mobile", true],
      ["delta.consumer-unseen", "forge-stock.reserve-stock:forge-web", false],
    ]);
    const all = await checks(d);
    expect(all[0]!.message).toBe(
      "Flow forge-stock.reserve-stock lists consumer forge-mobile, which isn't in the catalog. List components from the index.",
    );
    expect(all[1]!.message).toBe(
      "Flow forge-stock.reserve-stock lists forge-web as a consumer of POST /stock/reservations, but the map doesn't show forge-web calling it. Keep it if a document says so: the map may be missing the call.",
    );
  });

  it("an additive change (a field more in the response) needs no consumers", async () => {
    const d = FlowDelta.parse({
      schemaVersion: 2,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "modify",
      why: "The response says when the order was placed.",
      steps: [
        {
          op: "change",
          step: 5,
          kind: "respond",
          fields: { returns: ["id", "sku", "quantity", "created_at"] },
        },
      ],
    });
    const got = await checks({ flows: [d] });
    expect(got.filter((i) => i.rule.startsWith("delta.consumer"))).toEqual([]);
  });

  it("a step marked breaking, or a flow removed, breaks the entry's callers (an Interface's caller here)", async () => {
    const marked = FlowDelta.parse({
      schemaVersion: 2,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "modify",
      why: "Every order says which shop it is for.",
      steps: [
        {
          op: "change",
          step: 1,
          kind: "entry",
          fields: { reads: ["sku", "quantity", "shopId"] },
          breaking: true,
          why: "shopId is required.",
        },
      ],
    });
    const got = (await checks({ flows: [marked] })).filter((i) =>
      i.rule.startsWith("delta.consumer"),
    );
    expect(got.map((i) => [i.rule, i.target])).toEqual([
      ["delta.consumer-missing", "forge-orders.place-order"],
    ]);
    expect(got[0]!.message).toBe(
      "Flow forge-orders.place-order changes POST /orders in a way that breaks who calls it today (change 1 is marked breaking: shopId is required), but doesn't list forge-web, which the map shows calling it. List every caller under consumers: [forge-web].",
    );
    const removed = FlowDelta.parse({
      schemaVersion: 2,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "remove",
      why: "Orders are placed elsewhere now.",
    });
    const gone = (await checks({ flows: [removed] })).filter((i) =>
      i.rule.startsWith("delta.consumer"),
    );
    expect(gone.map((i) => i.message)).toEqual([
      "Flow forge-orders.place-order changes POST /orders in a way that breaks who calls it today (the flow is removed), but doesn't list forge-web, which the map shows calling it. List every caller under consumers: [forge-web].",
    ]);
  });

  it("a breaking change to a flow whose trigger cites no endpoint is a note: the map can't name its callers", async () => {
    const root = await holdRoot();
    const e0 = await estate(root);
    const flows = e0.flows.map((f) =>
      f.flow.id === "forge-stock.reserve-stock"
        ? { ...f, flow: { ...f.flow, trigger: { ...f.flow.trigger, ref: undefined } } }
        : f,
    );
    const e = estateOf(e0.records, flows as Estate["flows"]);
    const d = draftOf("no-consumers").flows[0]!;
    const got = checkDeltas([d], e, await placement(root), [], { levels: LEVELS }).filter(
      (i) => i.rule === "delta.contract-uncited",
    );
    expect(got.map((i) => [i.target, i.blocking])).toEqual([["forge-stock.reserve-stock", false]]);
    expect(got[0]!.message).toBe(
      "Flow forge-stock.reserve-stock changes its entry in a way that breaks who calls it (it no longer returns reservationId), but today's flow names no endpoint as its trigger, so the map can't say who calls it. A person checks its callers.",
    );
  });

  it("the rules that hand a fact back are drafting findings", () => {
    for (const r of [
      "delta.consumer-missing",
      "delta.unknown-consumer",
      "delta.deploy-order",
      "delta.deploy-missing",
      "delta.deploy-unknown-repo",
      "delta.deploy-unknown-migration",
    ])
      expect(stageRuleKind(r)).toBe("drafting");
  });
});

describe("every delta cites a fact (check 1)", () => {
  it("a call to a component the map knows no entry of is a note, not a pass", async () => {
    const d = FlowDelta.parse({
      schemaVersion: 2,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "modify",
      why: "The web app hears about each order.",
      steps: [
        {
          op: "add",
          after: 4,
          kind: "call-out",
          what: "The web app is told the order is placed",
          to: { component: "forge-web", entry: "POST /hooks/orders" },
          fields: { sends: ["id"] },
        },
      ],
    });
    const got = (await checks({ flows: [d] })).filter((i) => i.rule === "delta.entry-uncited");
    expect(got.map((i) => [i.target, i.blocking])).toEqual([["forge-orders.place-order#1", false]]);
    expect(got[0]!.message).toBe(
      "Change 1 to forge-orders.place-order calls POST /hooks/orders on forge-web, but the map has no entry of forge-web, so nothing confirms the call. Mark it new: true if this change adds it; otherwise a person confirms it.",
    );
  });

  it("a type given for a column the table has is checked against the catalog's: another type is a change that needs its migration", async () => {
    const d = draftOf("clean");
    const store = d.flows[1]!.steps[1]!.store!;
    store.columns = ["sku", "quantity"];
    store.types = { quantity: "BIGINT" };
    store.classification = {};
    delete store.migration;
    d.flows[1]!.steps[1]!.fields = { sends: ["sku", "quantity"] };
    d.flows[1]!.steps[0]!.fields = { sends: ["sku", "quantity"] };
    const got = (await checks(d)).filter((i) => i.rule === "delta.no-migration");
    expect(got.map((i) => i.message)).toEqual([
      "Change 2 to forge-orders.place-order changes the type of quantity in forge-orders-db.orders without naming the migration: give store.migration, named as forge-orders-db's migrations are: the next is V4__<what_it_does>.sql, in src/main/resources/db/migration.",
    ]);
  });

  it("the catalog's type written in another case is no change", async () => {
    const d = draftOf("clean");
    d.flows[1]!.steps[1]!.store!.types = { hold_id: "VARCHAR(36)", quantity: "int" };
    delete d.flows[1]!.steps[1]!.store!.consumers;
    const got = await checks(d);
    expect(got.filter((i) => i.rule.startsWith("delta.consumer"))).toEqual([]);
  });

  it("data.md says a column's type changes, with the migration", async () => {
    const e = await estate(await holdRoot());
    const d = draftOf("clean");
    expect(dataChanges(d.flows, e)).toEqual([
      expect.objectContaining({
        table: "forge-orders-db.orders",
        change: "new columns",
        columns: ["hold_id"],
        retyped: { quantity: { from: "INT", to: "BIGINT" } },
        migration: "V4__add_hold_id.sql",
      }),
    ]);
    expect(renderData(d.flows, e)).toContain(
      "| forge-orders-db | orders | add column hold_id VARCHAR(36); change column quantity from INT to BIGINT | V4__add_hold_id.sql |",
    );
  });
});

describe("the deploy order puts a callee before its caller and a migration before its code (check 4)", () => {
  it("an order that puts the caller first gets one finding a dependency it breaks", async () => {
    const got = await checks(draftOf("wrong-order"));
    expect(got.map((i) => [i.rule, i.target, i.blocking])).toEqual(
      expected("wrong-order-findings.yaml"),
    );
    expect(got.map((i) => i.message)).toEqual([
      "The deploy order puts forge-orders (step 1) before migration V4__add_hold_id.sql (step 2), but forge-orders reads or writes forge-orders-db.orders, which that migration changes: run the migration first.",
      "The deploy order puts forge-orders (step 1) before forge-stock (step 3), but forge-orders calls forge-stock's changed POST /stock/reservations: deploy forge-stock first.",
    ]);
  });

  it("an order that leaves out a repo or a migration says which", async () => {
    const d = draftOf("clean");
    d.deploy = [{ repo: "forge-orders" }];
    const got = await checks(d);
    expect(got.map((i) => [i.rule, i.target])).toEqual([
      ["delta.deploy-missing", "deploy:forge-stock"],
      ["delta.deploy-missing", "deploy:V4__add_hold_id.sql"],
    ]);
    expect(got.map((i) => i.message)).toEqual([
      "The deploy order leaves out forge-stock, whose target flows change: add a step for it.",
      "The deploy order doesn't run migration V4__add_hold_id.sql, which changes forge-orders-db.orders: add a step with migration: V4__add_hold_id.sql, before the code that needs it.",
    ]);
  });

  it("a step naming a repo or a migration the change doesn't have is handed back", async () => {
    const d = draftOf("clean");
    d.deploy = [
      { repo: "forge-orders", migration: "V4__add_hold_id.sql" },
      { repo: "forge-billing" },
      { repo: "forge-orders", migration: "V9__drop_orders.sql" },
      { repo: "forge-stock" },
      { repo: "forge-orders" },
    ];
    const got = await checks(d);
    expect(got.map((i) => [i.rule, i.target])).toEqual([
      ["delta.deploy-unknown-repo", "deploy#2"],
      ["delta.deploy-unknown-migration", "deploy#3"],
    ]);
    expect(got.map((i) => i.message)).toEqual([
      "Step 2 of the deploy order deploys forge-billing, which isn't a repo the estate has: name a repo from the index.",
      "Step 3 of the deploy order runs migration V9__drop_orders.sql, which no target flow names: name the migration a step gives under store.migration (V4__add_hold_id.sql).",
    ]);
  });

  it("no deploy order is a risk with the order the dependencies give, and nothing when the order can't matter", async () => {
    const got = await checks(draftOf("no-consumers"));
    expect(got.find((i) => i.rule === "delta.no-deploy-order")!.message).toBe(
      "The target flows give no deploy order, and here the order matters: a migration runs before the code that needs it, and a callee deploys before its caller. Give it under deploy, one step a repo or migration, such as: 1. migration V4__add_hold_id.sql, in forge-orders; 2. forge-stock; 3. forge-orders.",
    );
    const one = FlowDelta.parse({
      schemaVersion: 2,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "modify",
      why: "The order is logged.",
      steps: [{ op: "add", after: 4, kind: "log", what: "The order is logged" }],
    });
    expect(
      (await checks({ flows: [one] })).filter((i) => i.rule.startsWith("delta.deploy")),
    ).toEqual([]);
    expect(
      (await checks({ flows: [one] })).filter((i) => i.rule === "delta.no-deploy-order"),
    ).toEqual([]);
  });
});

describe("the architecture stage runs the checks before the critic sees the draft", () => {
  it("hands the missing consumers back to the drafter, then writes the deploy order and the breaking changes", async () => {
    const root = await holdRoot();
    const prompts: string[] = [];
    const r = await architectureStage(root, CHANGE, {
      runtime: assistant([text("no-consumers"), text("clean")], prompts),
      now: NOW,
    });
    expect(r.state).toBe("done");
    expect(r.drafts).toBe(2);
    expect(prompts[0]).toContain("consumers:");
    expect(prompts[0]).toContain("deploy:");
    // Who uses what the touched flows serve and store into, from the first draft on.
    expect(prompts[0]).toContain(
      "- POST /stock/reservations (flow forge-stock.reserve-stock): called by forge-orders\n- POST /orders (flow forge-orders.place-order): called by forge-web\n- forge-orders-db.orders: read or written by forge-reports",
    );
    expect(prompts[1]).toContain("but doesn't list forge-orders, which the map shows calling it");
    const dir = join(root, "openspec/changes", CHANGE);
    const design = await readFile(join(dir, "design.md"), "utf8");
    expect(design).toContain(readFileSync(join(HOLD, "expected/design-sections.md"), "utf8"));
    const back = await readTargetFlows(dir);
    expect(back?.deploy).toEqual(draftOf("clean").deploy);
    // Read back in file order: forge-orders.place-order, then forge-stock.reserve-stock.
    const flow = (id: string) => back?.flows.find((f) => f.flow === id);
    expect(flow("forge-stock.reserve-stock")!.consumers).toEqual(["forge-orders"]);
    expect(flow("forge-orders.place-order")!.steps[1]!.store!.consumers).toEqual(["forge-reports"]);
    expect(await readFile(join(dir, "data.md"), "utf8")).toContain(
      "- forge-orders-db.orders: new columns hold_id; changed types of quantity, for flow forge-orders.place-order.",
    );
  });

  it("the drafter's own check (check_draft) sees a wrong deploy order", async () => {
    const root = await holdRoot();
    const got = await checkStageDraft(root, CHANGE, "architecture", text("wrong-order"));
    expect(got.map((i) => [i.rule, i.target])).toEqual(
      expected("wrong-order-findings.yaml").map(([r, t]) => [r, t]),
    );
  });
});
