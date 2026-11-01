import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import {
  comparePrototype,
  parseFacts,
  parseRecord,
  prototypeArchitectureSection,
  recordPath,
  serializeRecord,
  type Fact,
} from "@maycombhq/core";
import { attachToChange } from "@maycombhq/intake";
import {
  architectureStage,
  EXPAND_AGENT,
  featureStage,
  PROTOTYPE_NEW_RULE,
  prototypeNewCallsSource,
} from "../src/index.js";

/**
 * V3 (ADR 0142): a call the prototype makes that nothing in the estate serves is listed for the
 * architecture stage, which is told to place each one. The comparison is ADR 0133's invented
 * checkout prototype against the Forge shop BFF and billing; its section goes into an attached
 * comparison, as `atticus change attach --prototype` writes it, on the stage fixtures' change.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures");
const STAGES = join(FIX, "stages");
const PROTO_FX = join(FIX, "prototype-compare");
const NOW = new Date("2026-10-24T09:00:00Z");
const CHANGE = "add-fraud-check";

const facts = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(PROTO_FX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
/** The attached comparison's text, its section as the CLI writes it. */
function comparisonDocument(): string {
  const proto = facts("forge-checkout-prototype");
  const c = comparePrototype({
    prototype: { repo: "forge-checkout-prototype", facts: proto },
    estate: [
      { repo: "forge-shop-bff", facts: facts("forge-shop-bff"), component: "shop-bff" },
      {
        repo: "forge-billing",
        facts: facts("forge-billing"),
        component: "billing-api",
        hosts: ["billing.forge.internal"],
      },
    ],
  });
  return [
    "# What the prototype forge-checkout-prototype asks of the estate",
    "",
    "New: nothing in the estate serves it.",
    "",
    ...prototypeArchitectureSection(c, proto),
  ].join("\n");
}

async function root(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "atticus-prototype-new-"));
  await mkdir(join(r, "org-pack"), { recursive: true });
  const rows = [
    ...(parse(readFileSync(join(FIX, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(STAGES, "catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const x of rows) {
    const p = parseRecord(x);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(r, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  for (const x of parse(readFileSync(join(STAGES, "knowledge.yaml"), "utf8")) as unknown[]) {
    const p = parseRecord(x);
    if (!p.ok) throw new Error("bad knowledge record");
    const f = join(r, "knowledge/items", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(STAGES, "specs"), join(r, "specs"), { recursive: true });
  await cp(join(STAGES, "changes"), join(r, "openspec/changes"), { recursive: true });
  // The stage lenses review each draft with the draft's own sources.
  await cp(join(STAGES, "lenses/checklists"), join(r, "org-pack/checklists"), { recursive: true });
  return r;
}

const PLACED = `summary: Every new order is screened by Northwind Pay before stock is reserved.
features:
  - { id: cap-ordering, why: Placing an order gains the screen. }
flows:
  - { id: forge-orders.place-order, how: changed, why: The screen runs before stock is reserved. }
`;

const DELTAS = `flows:
  - flow: forge-orders.place-order
    repo: forge-orders
    change: modify
    why: The order is screened before stock is reserved.
    steps:
      - op: change
        step: 4
        kind: write
        what: The order is inserted with the screen's verdict
        store: { table: forge-orders-db.orders, columns: [sku, quantity, fraud_verdict], types: { fraud_verdict: varchar(20) }, classification: { fraud_verdict: internal }, migration: V4__add_fraud_verdict.sql }
`;

function assistant(drafts: string[], prompts: string[] = [], critics: string[] = []) {
  let n = 0;
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) {
        critics.push(req.pack.prompt);
        return "findings: []";
      }
      if (req.agent.id === EXPAND_AGENT) return "terms: []\nnames: []\n";
      prompts.push(req.pack.prompt);
      return drafts[Math.min(n++, drafts.length - 1)]!;
    },
    { now: () => NOW },
  );
}

describe("the prototype's new calls, for the architecture stage (ADR 0142)", () => {
  it("gathers each attached comparison's new calls into one block, and nothing when none lists one", () => {
    const [src] = prototypeNewCallsSource([
      { id: "inputs/prototype-x.md", origin: "o", text: comparisonDocument() },
      { id: "inputs/notes.md", origin: "o", text: "# Notes\n- not a call\n" },
    ]);
    expect(src!.id).toBe("prototype-new-calls");
    expect(src!.text.split("\n").slice(1)).toEqual([
      "- GET /loyalty/summary, which checkout-ui calls on its BFF (forge-checkout-prototype ui/src/api.ts:13 → bff/src/server.ts:23)",
      "- GET /loyalty/{sub}/balance, which checkout-bff calls on its mock (forge-checkout-prototype bff/src/server.ts:24 → mocks/handlers.ts:10); response points (number, mocks/handlers.ts:11), tier (string, mocks/handlers.ts:11)",
      "- GET /v1/charges/{orderId}, which checkout-bff calls on its mock (forge-checkout-prototype bff/src/server.ts:18 → mocks/wiremock/mappings/northwind-get-charge.json:4); response amount (number, mocks/wiremock/mappings/northwind-get-charge.json:11), id (string, mocks/wiremock/mappings/northwind-get-charge.json:9), status (string, mocks/wiremock/mappings/northwind-get-charge.json:10)",
    ]);
    expect(prototypeNewCallsSource([{ id: "a", origin: "o", text: "# Notes\n" }])).toEqual([]);
  });

  it("the architecture draft gets the list, cited by the attached file's lines, and is told to place each call", async () => {
    const r = await root();
    expect((await featureStage(r, CHANGE, { runtime: assistant([PLACED]), now: NOW })).state).toBe(
      "done",
    );
    const dir = join(r, "openspec/changes", CHANGE);
    const added = await attachToChange(
      dir,
      [
        {
          name: "prototype-forge-checkout-prototype.md",
          bytes: new TextEncoder().encode(comparisonDocument()),
        },
      ],
      { by: "pat", at: "2026-10-24T09:00:00Z" },
    );
    expect(added.refused).toEqual([]);
    const arch: string[] = [];
    expect(
      (await architectureStage(r, CHANGE, { runtime: assistant([DELTAS], arch), now: NOW })).state,
    ).toBe("done");
    expect(arch[0]).toContain(PROTOTYPE_NEW_RULE);
    expect(arch[0]).toMatch(
      /\[inputs\/prototype-forge-checkout-prototype\.md:\d+\] - GET \/loyalty\/summary, which checkout-ui calls on its BFF/,
    );
  });

  it("tells the draft nothing about prototypes when none is attached", async () => {
    const r = await root();
    await featureStage(r, CHANGE, { runtime: assistant([PLACED]), now: NOW });
    const arch: string[] = [];
    await architectureStage(r, CHANGE, { runtime: assistant([DELTAS], arch), now: NOW });
    expect(arch[0]).not.toContain(PROTOTYPE_NEW_RULE);
  });
});
