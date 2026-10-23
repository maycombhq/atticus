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
    // A write names its columns, mapping fields to them as the code shows (ADR 0088).
    expect(prompts[0]).toContain(
      "A write names its table and every column it writes, in store.columns, as the database names them.",
    );
    expect(prompts[0]).toContain("@Column(name = ...)");
    // A family holds triggers that do the same work (ADR 0088).
    expect(prompts[0]).toContain("reads with reads, writes with writes");
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

  it("reports a write's field no column takes, and keeps the flow (ADR 0088)", async () => {
    const unmapped = answer.replace(
      "store: { table: forge-orders-db.orders, columns: [sku, quantity] }",
      "store: { table: forge-orders-db.orders, columns: [sku, quantity] }\n        data: { sends: [sku, quantity, price] }",
    );
    const c = await checkSpecDraft(unmapped, o());
    expect(c.passed.map((f) => f.id)).toContain("forge-orders.place-order");
    expect(c.advisory.filter((a) => a.rule === "write-unmapped").map((a) => a.message)).toEqual([
      "forge-orders.place-order step 4 (write) sends price, which none of its columns (sku, quantity) takes; map it to a column with data.from and data.to, or leave it out",
    ]);
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
    // place-order stands for the DELETE in its family.
    expect(r.uncovered.map((t) => t.id)).toEqual(["forge-orders.get-orders-orderid"]);
    expect(prompts[0]).not.toContain("- endpoint forge-orders.post-orders:");
    expect(prompts[0]).not.toContain("- endpoint forge-orders.delete-orders-orderid:");
    expect(prompts[0]).toContain("which you don't write again: forge-orders.place-order");
  });

  it("fits the model's limit: cited code as excerpts first, another repo's long list cut first (ADR 0112)", async () => {
    // forge-stock with 600 more entry points: a list a 12,078-token model can't take whole.
    const many = Array.from({ length: 600 }, (_, i) => {
      const p = parseRecord({
        kind: "Endpoint",
        schemaVersion: 2,
        id: `forge-stock.get-stock-item-${i}`,
        status: "current",
        confidence: "verified",
        evidence: [
          { source: "code", repo: "forge-stock", path: "src/StockController.java", line: 9 },
        ],
        component: "forge-stock",
        endpointType: "rest",
        method: "GET",
        pathOrTopic: `/stock/items/${i}`,
        normalizedPath: `/stock/items/${i}`,
      });
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      return p.record;
    });
    const packs: AiRequest["pack"][] = [];
    const runtime = new MockRuntime(
      (req: AiRequest) => {
        packs.push(req.pack);
        return answer;
      },
      { now: () => NOW },
    );
    const r = await draftSpec(repo(), {
      ...o(),
      records: [...records(), ...many],
      runtime,
      now: NOW,
      onFile: [expected()],
      maxTokens: 12_078,
    });
    expect(r.status).toBe("drafted");
    const m = packs[0]!.manifest;
    expect(m.budget).toBe(8658);
    expect(m.totalTokens).toBeLessThanOrEqual(8658);
    // The controller, cited by the endpoints and by place-order's steps, goes in as a numbered excerpt.
    expect(m.sources.some((s) => s.id === "6-code-000")).toBe(true);
    expect(packs[0]!.prompt).toMatch(
      /src\/main\/java\/forge\/orders\/OrderController\.java lines 1-26 \(cited at [\d, ]+; numbered as in the file\):/,
    );
    expect(packs[0]!.prompt).toContain("13:     Order saved = orders.save(order);");
    // forge-stock's list goes in a hundred at a time while it fits; the rest is cut, not the code.
    expect(m.dropped.map((d) => d.id)).toEqual([
      "5-targets-forge-stock-2",
      "5-targets-forge-stock-3",
    ]);
    expect(packs[0]!.prompt).toContain(
      "Endpoint forge-stock.post-stock-reservations on forge-stock",
    );
  });

  it("says before handing off when the catalog alone can't fit the model (ADR 0112)", async () => {
    const runtime = new MockRuntime(() => answer, { now: () => NOW });
    await expect(draftSpec(repo(), { ...o(), runtime, now: NOW, maxTokens: 3000 })).rejects.toThrow(
      /^atticus spec draft forge-orders can't fit its smallest useful prompt in the model: it needs about \d+ tokens \(its instructions and 4-catalog\), and a model of 3000 tokens leaves 1850 for the prompt\. Use a model with a bigger limit/,
    );
  });
});
