import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { loadChangeContext } from "@maycombhq/changes";
import {
  allowedValuesSource,
  architectureStage,
  estateLine,
  EXPAND_AGENT,
  featureStage,
  loadEstate,
  storiesStage,
} from "../src/index.js";

/**
 * S2: a live run's stories draft said "the kind value that marks a plain post is not yet
 * known", and the critic raised it as a gap twice, though the table's migration lists the
 * values in a CHECK constraint. The catalog's Column record carries them now (allowedValues,
 * cited); here, on the stage fixtures' add-fraud-check change, the orders table's channel column
 * allows web, phone and shop, and every step that stores into the table is told so.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures");
const STAGES = join(FIX, "stages");
const NOW = new Date("2026-10-24T09:00:00Z");
const CHANGE = "add-fraud-check";
const CITE = "forge-orders:db/migration/V3__order_channel.sql:2";
const LINE = `- forge-orders-db.orders.channel: web, phone, shop (${CITE})`;

const CHANNEL = {
  kind: "Column",
  schemaVersion: 2,
  id: "forge-orders-db.orders.channel",
  status: "current",
  confidence: "verified",
  evidence: [
    {
      source: "migration",
      repo: "forge-orders",
      path: "db/migration/V3__order_channel.sql",
      line: 2,
    },
  ],
  table: "forge-orders-db.orders",
  name: "channel",
  type: "varchar(8)",
  nullable: false,
  allowedValues: {
    values: ["web", "phone", "shop"],
    evidence: {
      source: "migration",
      repo: "forge-orders",
      path: "db/migration/V3__order_channel.sql",
      line: 2,
    },
  },
};

async function root(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "atticus-allowed-values-"));
  await mkdir(join(r, "org-pack"), { recursive: true });
  const rows = [
    ...(parse(readFileSync(join(FIX, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(STAGES, "catalog-extra.yaml"), "utf8")) as unknown[]),
    CHANNEL,
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

const STORIES = `stories:
  - id: s1-place-order
    title: Keep the screen's verdict
    asA: shop owner
    iWant: each order's verdict kept
    soThat: a refused order can be traced
    tasks:
      - id: "1.1"
        criteria:
          - text: "Given an accepted order, when it is saved, then the orders row holds sku, quantity and fraud_verdict"
            checks: [sku, quantity, fraud_verdict]
requests: []
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

describe("values the code allows are known to the steps that store them (S2)", () => {
  it("the estate's table line and the allowed-values block name each value with its line", async () => {
    const r = await root();
    const e = await loadEstate(r, (await loadChangeContext(r)).records);
    expect(estateLine(e, "Table", "forge-orders-db.orders")).toContain(
      "; allowed values: channel (web, phone, shop)",
    );
    const [src] = allowedValuesSource(e, ["forge-orders-db.orders"]);
    expect(src!.id).toBe("allowed-values");
    expect(src!.text).toContain(LINE);
    expect(src!.text).toContain("never call one of these unknown");
    expect(allowedValuesSource(e, ["forge-stock-db.stock"])).toEqual([]);
  });

  it("the architecture and stories drafts, and their lenses, get the values of the table the step stores into", async () => {
    const r = await root();
    expect((await featureStage(r, CHANGE, { runtime: assistant([PLACED]), now: NOW })).state).toBe(
      "done",
    );
    const arch: string[] = [];
    expect(
      (await architectureStage(r, CHANGE, { runtime: assistant([DELTAS], arch), now: NOW })).state,
    ).toBe("done");
    expect(arch[0]).toContain(LINE);
    const stories: string[] = [];
    const lenses: string[] = [];
    const s = await storiesStage(r, CHANGE, {
      runtime: assistant([STORIES], stories, lenses),
      now: NOW,
    });
    expect(s.state).toBe("done");
    expect(stories[0]).toContain(LINE);
    expect(lenses.length).toBeGreaterThan(0);
    expect(lenses[0]).toContain(LINE);
  });
});
