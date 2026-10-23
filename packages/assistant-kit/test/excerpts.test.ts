import { describe, expect, it } from "vitest";
import { citationsOf, codeExcerpts, EXCERPT_WINDOW, excerptSources } from "../src/excerpts.js";

/**
 * Code excerpts, not whole files (ADR 0112): a step that puts code in a prompt sends line
 * windows around each cited line, merged where they overlap, ranked by how many facts cite
 * them, each with its path and the file's own line numbers so the model can cite exactly.
 */

/** forge-orders' OrderService, 120 lines: a save at 30, a stock call at 34, a refund at 100. */
const service = Array.from({ length: 120 }, (_, i) =>
  i === 29
    ? "    Order saved = orders.save(order);"
    : i === 33
      ? "    stock.reserve(saved.sku(), saved.quantity());"
      : i === 99
        ? "    payments.refund(order.id());"
        : `    // OrderService line ${i + 1}`,
).join("\n");
const controller = Array.from({ length: 12 }, (_, i) => `  // OrderController line ${i + 1}`).join(
  "\n",
);
const repo = {
  async readText(path: string) {
    if (path === "src/main/java/forge/orders/OrderService.java") return service;
    if (path === "src/main/java/forge/orders/OrderController.java") return controller;
    throw new Error(`no ${path}`);
  },
};

describe("code excerpts (ADR 0112)", () => {
  it("windows each cited line, merges overlaps, and ranks by how many facts cite them", async () => {
    expect(EXCERPT_WINDOW).toBe(20);
    const x = await codeExcerpts(repo, [
      { path: "src/main/java/forge/orders/OrderService.java", line: 100 },
      { path: "src/main/java/forge/orders/OrderService.java", line: 30 },
      { path: "src/main/java/forge/orders/OrderService.java", line: 34 },
      { path: "src/main/java/forge/orders/OrderController.java", line: 5 },
      { path: "src/main/java/forge/orders/OrderController.java" },
      { path: "src/main/java/forge/orders/Gone.java", line: 3 },
      { path: "src/main/java/forge/orders/OrderService.java", line: 400 },
    ]);
    expect(x.map((e) => [e.path, e.from, e.to, e.cites])).toEqual([
      // A file shorter than the window is whole; a citation with no line counts at line 1.
      ["src/main/java/forge/orders/OrderController.java", 1, 12, 2],
      // 30 and 34 merge into one window, cited twice; a tie goes by path.
      ["src/main/java/forge/orders/OrderService.java", 10, 54, 2],
      ["src/main/java/forge/orders/OrderService.java", 80, 120, 1],
    ]);
    const first = x[1]!.text.split("\n");
    expect(first[0]).toBe(
      "src/main/java/forge/orders/OrderService.java lines 10-54 (cited at 30, 34; numbered as in the file):",
    );
    expect(first).toContain("30:     Order saved = orders.save(order);");
    expect(first).toContain("34:     stock.reserve(saved.sku(), saved.quantity());");
    expect(first.at(-1)).toBe("54:     // OrderService line 54");
  });

  it("takes a narrower window when asked", async () => {
    const x = await codeExcerpts(
      repo,
      [
        { path: "src/main/java/forge/orders/OrderService.java", line: 30 },
        { path: "src/main/java/forge/orders/OrderService.java", line: 34 },
      ],
      { window: 1 },
    );
    expect(x.map((e) => [e.from, e.to])).toEqual([
      [29, 31],
      [33, 35],
    ]);
  });

  it("becomes sources in rank order, so the budget cuts the least-cited first", async () => {
    const x = await codeExcerpts(repo, [
      { path: "src/main/java/forge/orders/OrderService.java", line: 100 },
      { path: "src/main/java/forge/orders/OrderService.java", line: 30 },
      { path: "src/main/java/forge/orders/OrderService.java", line: 31 },
    ]);
    const s = excerptSources(x, { id: "6-code", origin: "forge-orders", priority: 30 });
    expect(s.map((v) => [v.id, v.origin, v.priority, v.kind])).toEqual([
      ["6-code-000", "forge-orders:src/main/java/forge/orders/OrderService.java:10-51", 30, "code"],
      [
        "6-code-001",
        "forge-orders:src/main/java/forge/orders/OrderService.java:80-120",
        30,
        "code",
      ],
    ]);
  });

  it("reads the citations from records and flows, in this repo only", () => {
    const cites = citationsOf(
      [
        {
          evidence: [
            { repo: "forge-orders", path: "a.java", line: 3 },
            { repo: "forge-stock", path: "b.java", line: 4 },
            { path: "c.java" },
          ],
        },
        {
          trigger: { evidence: [{ repo: "forge-orders", path: "a.java", line: 9 }] },
          steps: [{ evidence: [{ path: "d.java", line: 12 }] }],
          errors: [{ evidence: [{ path: "d.java", line: 40 }] }],
        },
      ],
      "forge-orders",
    );
    expect(cites).toEqual([
      { path: "a.java", line: 3 },
      { path: "c.java" },
      { path: "a.java", line: 9 },
      { path: "d.java", line: 12 },
      { path: "d.java", line: 40 },
    ]);
  });
});
