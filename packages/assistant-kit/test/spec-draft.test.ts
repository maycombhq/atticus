import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { DEFAULT_SPEC_TEMPLATE, parseRecord, type CatalogRecord } from "@maycombhq/core";
import { fsRepo } from "@maycombhq/sdk";
import { checkSpecDraft, draftSpec } from "../src/spec-draft.js";

const SPECS = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/specs");
const NOW = new Date("2026-10-21T12:00:00Z");
const repo = () => fsRepo("forge-orders", join(SPECS, "repos", "forge-orders"), "0".repeat(40));
const records = (): CatalogRecord[] =>
  (parse(readFileSync(join(SPECS, "catalog.yaml"), "utf8")) as unknown[]).map((r) => {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    return p.record;
  });
const answer = readFileSync(join(SPECS, "answers", "forge-orders.yaml"), "utf8");
const expected = () => {
  const p = parseRecord(
    parse(readFileSync(join(SPECS, "expected", "forge-orders.place-order.yaml"), "utf8")),
  );
  if (!p.ok || p.record.kind !== "Flow") throw new Error(JSON.stringify(p));
  return p.record;
};
const o = () => ({
  repo: repo(),
  repoId: "forge-orders",
  records: records(),
  template: DEFAULT_SPEC_TEMPLATE,
});

describe("atticus spec draft (ADR 0079)", () => {
  it("keeps the flows that pass, hands back the rest, and stops when every trigger has a flow", async () => {
    // The first answer cites a line past the end of the file and a table the catalog hasn't got.
    const first = answer
      .replace(
        'OrderController.java:19"\n      - kind: respond',
        'OrderController.java:99"\n      - kind: respond',
      )
      .replace(
        "table: forge-orders-db.orders, columns: [id, sku, quantity]",
        "table: forge-orders-db.order, columns: [id]",
      );
    const prompts: string[] = [];
    const replies = [first, answer];
    const runtime = new MockRuntime(
      (req: AiRequest) => {
        prompts.push(req.pack.prompt);
        return replies[prompts.length - 1]!;
      },
      { now: () => NOW },
    );
    const r = await draftSpec(repo(), { ...o(), runtime, now: NOW });
    expect(r.status).toBe("drafted");
    expect(r.attempts.map((a) => a.kept)).toEqual([
      ["forge-orders.place-order"],
      ["forge-orders.place-order", "forge-orders.get-order"],
    ]);
    expect(r.attempts[0]!.problems).toEqual([
      "forge-orders.get-order: forge-orders.get-order step 2 (lookup) cites src/main/java/forge/orders/OrderController.java:99: src/main/java/forge/orders/OrderController.java has 26 lines",
      "forge-orders.get-order: forge-orders.get-order step 2 (lookup) names forge-orders-db.order, which isn't in the catalog",
    ]);
    expect(r.flows.map((f) => f.id)).toEqual([
      "forge-orders.get-order",
      "forge-orders.place-order",
    ]);
    expect(r.flows.find((f) => f.id === "forge-orders.place-order")).toEqual(expected());
    expect(r.uncovered).toEqual([]);
    expect(r.questions.map((q) => q.question)).toEqual([
      "Does cancelling an order also release the stock it reserved?",
    ]);
    // The first prompt has the template, the triggers, the catalog and the numbered code.
    expect(prompts[0]).toContain("The spec template (default@1)");
    expect(prompts[0]).toContain(
      "- endpoint forge-orders.delete-orders-orderid: DELETE /orders/{orderId} (src/main/java/forge/orders/OrderController.java:22)",
    );
    expect(prompts[0]).toContain("Table forge-orders-db.orders: orders");
    expect(prompts[0]).toContain("Endpoint forge-stock.post-stock-reservations on forge-stock");
    expect(prompts[0]).toContain("13:     Order saved = orders.save(order);");
    // The second is told what was kept and what failed.
    expect(prompts[1]).toContain("Kept: forge-orders.place-order. Don't write these again.");
    expect(prompts[1]).toContain("has 26 lines");
  });

  it("refuses what isn't a flow, a call-out to nowhere and a confirmation the drafter can't give", async () => {
    const wrong = answer
      .replace('entry: "POST /stock/reservations"', 'entry: "POST /stock/holds"')
      .replace("  - id: get-order\n", "  - id: get-order\n    colour: blue\n");
    const c = await checkSpecDraft(wrong, o());
    expect(c.passed).toEqual([]);
    expect(c.failed).toEqual([
      { flow: "get-order", problems: ['(top): Unrecognized key: "colour"'] },
      {
        flow: "forge-orders.place-order",
        problems: [
          "forge-orders.place-order step 2 (call-out) goes to POST /stock/holds on forge-stock, which the catalog has no entry point or interface for",
        ],
      },
    ]);
    const confirmed = answer.replace(
      "      - kind: transform\n",
      "      - kind: transform\n        confirmedBy: check\n",
    );
    const ok = await checkSpecDraft(confirmed, o());
    const t = ok.passed.find((f) => f.id === "forge-orders.place-order")!.steps[2]!;
    expect(t.kind).toBe("transform");
    expect(t.confirmedBy).toBeUndefined();
    expect((await checkSpecDraft("flows: [", o())).problems[0]).toMatch(/isn't YAML/);
  });

  it("asks only for the triggers that have no flow yet", async () => {
    const prompts: string[] = [];
    const runtime = new MockRuntime(
      (req: AiRequest) => {
        prompts.push(req.pack.prompt);
        return "flows: []\n";
      },
      { now: () => NOW },
    );
    const keep = [expected()];
    const r = await draftSpec(repo(), { ...o(), runtime, now: NOW, keep, maxAttempts: 1 });
    expect(r.status).toBe("failed");
    expect(r.uncovered.map((t) => t.id)).toEqual([
      "forge-orders.delete-orders-orderid",
      "forge-orders.get-orders-orderid",
    ]);
    expect(prompts[0]).not.toContain("- endpoint forge-orders.post-orders:");
    expect(prompts[0]).toContain("which you don't write again: forge-orders.place-order");
  });
});
