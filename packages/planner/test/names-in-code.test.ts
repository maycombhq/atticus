import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { namesInCode } from "@maycombhq/index";
import { architectureStage, EXPAND_AGENT, featureStage, gapSources } from "../src/index.js";

/**
 * A4 (fixtures/names-in-code): a name the change uses that a repo in the workspace declares or
 * uses in its code is not a knowledge gap. Whether a name is in the code is a fact Atticus
 * checks (ADR 0118's code search, a whole-word match in the clone); only a name found in neither
 * the catalog nor the code is listed as a gap, and the gap says the code was searched.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures");
const OWN = join(HERE, "fixtures/names-in-code");
const NOW = new Date("2026-10-24T09:00:00Z");
const CHANGE = "add-fraud-check";

async function root(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "atticus-names-in-code-"));
  await mkdir(join(r, "org-pack"), { recursive: true });
  const rows = [
    ...(parse(readFileSync(join(FIX, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const x of rows) {
    const p = parseRecord(x);
    if (!p.ok) throw new Error("bad fixture record");
    const f = join(r, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  // The estate doesn't know the vendor, and nothing in the code names it.
  await rm(join(r, "catalog/generated/system/northwind-pay.yaml"));
  await cp(join(FIX, "stages/specs"), join(r, "specs"), { recursive: true });
  await cp(join(FIX, "stages/changes"), join(r, "openspec/changes"), { recursive: true });
  await cp(join(FIX, "specs/repos/forge-orders"), join(r, "workspace/forge-orders"), {
    recursive: true,
  });
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
        store: { table: forge-orders-db.orders, columns: [sku, quantity, fraud_verdict], types: { fraud_verdict: VARCHAR(20) }, classification: { fraud_verdict: internal }, migration: V4__add_fraud_verdict.sql }
`;

function assistant(drafts: string[], prompts: string[] = []) {
  const expansion = readFileSync(join(OWN, "expansion.yaml"), "utf8");
  let n = 0;
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === EXPAND_AGENT) return expansion;
      prompts.push(req.pack.prompt);
      return drafts[Math.min(n++, drafts.length - 1)]!;
    },
    { now: () => NOW },
  );
}

describe("names the code has are not gaps (A4)", () => {
  it("the architecture step lists only the name neither the catalog nor the code has, and says where the code names the others", async () => {
    const r0 = await root();
    expect((await featureStage(r0, CHANGE, { runtime: assistant([PLACED]), now: NOW })).state).toBe(
      "done",
    );
    const prompts: string[] = [];
    const r = await architectureStage(r0, CHANGE, {
      runtime: assistant([DELTAS], prompts),
      now: NOW,
    });
    const expected = parse(readFileSync(join(OWN, "expected.yaml"), "utf8")) as {
      gaps: unknown[];
      inCode: unknown[];
      searched: string[];
    };
    expect(r.context?.gaps).toEqual(expected.gaps);
    expect(r.context?.inCode).toEqual(expected.inCode);
    expect(r.context?.searched).toEqual(expected.searched);
    // The model is told the code was searched, and where the code names the others.
    expect(prompts[0]).toContain(
      "Names the change uses that neither the catalog, the knowledge, the specs nor the code of the workspace's repos (forge-orders) has:",
    );
    expect(prompts[0]).toContain(
      "- OrderController: forge-orders:src/main/java/forge/orders/OrderController.java:5",
    );
  });

  it("namesInCode matches whole words only, skips what .gitignore ignores, and says which repos it searched", async () => {
    const r0 = await root();
    await writeFile(join(r0, "workspace/forge-orders/.gitignore"), "build/\n");
    await mkdir(join(r0, "workspace/forge-orders/build"), { recursive: true });
    await writeFile(join(r0, "workspace/forge-orders/build/Gen.java"), "class PinBoard {}\n");
    const got = await namesInCode(r0, ["Order", "OrderCon", "PinBoard", "StockClient"]);
    expect(got.repos).toEqual(["forge-orders"]);
    expect([...got.found.keys()].sort()).toEqual(["Order", "StockClient"]);
    expect(got.found.get("StockClient")).toMatch(/^forge-orders:src\/main\/java\/forge\/orders\//);
  });

  it("with no repo cloned, the gaps say the code wasn't searched", () => {
    const [, data] = gapSources([{ name: "Northwind Pay", state: "listed" }], []);
    expect(data!.text).toContain(
      "Names the change uses that neither the catalog, the knowledge nor the specs has (no repo is cloned in the workspace, so no code was searched):",
    );
  });
});
