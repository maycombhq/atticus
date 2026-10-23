import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_TOOLS,
  contextToolBox,
  openIndex,
  runContextTool,
  type CatalogIndex,
} from "../src/index.js";
import { contextRoot, FIX } from "./helpers.js";

// ADR 0107 addendum: the context tools a model may call beside its pack, run against the
// index and the workspace checkout, read-only, never outside a clone.

async function withRepo(): Promise<string> {
  const root = await contextRoot();
  await cp(join(FIX, "specs/repos/forge-orders"), join(root, "workspace/forge-orders"), {
    recursive: true,
  });
  return root;
}

const call = (ix: CatalogIndex, root: string, name: string, input: Record<string, unknown>) =>
  runContextTool(ix, root, name, input);

describe("the context tools", () => {
  it("are defined once, each with a JSON schema for its input", () => {
    expect(CONTEXT_TOOLS.map((t) => t.name)).toEqual(["search", "show", "walk", "show_code"]);
    for (const t of CONTEXT_TOOLS) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it("search finds by words, names first, and says where each hit was read from", async () => {
    const root = await contextRoot();
    const ix = await openIndex(root);
    const out = await call(ix, root, "search", { text: "Northwind Pay fraud screen", limit: 5 });
    expect(out).toMatch(/^\d+ hits? for "Northwind Pay fraud screen"/);
    expect(out).toContain("fraud-screen");
    expect(out).toMatch(/\[knowledge\/items\/[^\]]+\]/);
    expect(await call(ix, root, "search", { text: "zzzz qqqq" })).toMatch(/^Nothing in the index/);
    await expect(call(ix, root, "search", {})).rejects.toThrow(/needs text/);
    ix.close();
  });

  it("show gives a record in full with its file and whether it was verified", async () => {
    const root = await contextRoot();
    const ix = await openIndex(root);
    const out = await call(ix, root, "show", { id: "vendor-onboarding" });
    expect(out).toMatch(/vendor-onboarding \(a person verified it\), read from knowledge\/items\//);
    const flow = await call(ix, root, "show", { id: "forge-orders.place-order" });
    expect(flow).toMatch(/^Flow forge-orders.place-order/);
    expect(flow).toMatch(/walk shows them/);
    await expect(call(ix, root, "show", { id: "quillfeather-risk" })).rejects.toThrow(
      /nothing called quillfeather-risk/,
    );
    ix.close();
  });

  it("walk follows the links, bounded by hops and a limit, saying how each was made", async () => {
    const root = await contextRoot();
    const ix = await openIndex(root);
    const one = await call(ix, root, "walk", { id: "forge-orders.place-order" });
    expect(one).toMatch(/^Links from forge-orders.place-order, 1 hop:/);
    expect(one).toMatch(/hop 1: forge-orders.place-order calls forge-stock\.[^\s]+ \(step \d/);
    const two = await call(ix, root, "walk", { id: "forge-orders.place-order", hops: 9, limit: 3 });
    expect(two).toMatch(/2 hops/);
    expect(two.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(3);
    expect(two).toMatch(/and \d+ more/);
    ix.close();
  });

  it("show_code shows the lines a fact cites, from the workspace checkout", async () => {
    const root = await withRepo();
    const ix = await openIndex(root);
    const out = await call(ix, root, "show_code", { id: "forge-orders.place-order#1", context: 2 });
    expect(out).toMatch(
      /step forge-orders.place-order#1 cites forge-orders\/src\/main\/java\/forge\/orders\/OrderController.java:4:/,
    );
    expect(out).toMatch(/\n>\s*4 {2}/);
    expect(out.split("\n").filter((l) => /^[ >]\s*\d+ {2}/.test(l)).length).toBeLessThanOrEqual(10);
    // A record's cites, from the catalog's evidence.
    const rec = await call(ix, root, "show_code", { id: "forge-orders.post-orders" });
    expect(rec).toMatch(/OrderController.java:\d+:/);
    // By repo, path and line: only a line a fact cites.
    const at = await call(ix, root, "show_code", {
      repo: "forge-orders",
      path: "src/main/java/forge/orders/OrderController.java",
      line: 4,
    });
    expect(at).toMatch(/^A fact cites/);
    await expect(
      call(ix, root, "show_code", {
        repo: "forge-orders",
        path: "src/main/java/forge/orders/OrderController.java",
        line: 2,
      }),
    ).rejects.toThrow(/No fact cites/);
    ix.close();
  });

  it("show_code never reads outside a clone: no .., no absolute path, no link out", async () => {
    const root = await withRepo();
    // A catalog record that cites a file through .. and one through a link out of the clone.
    const outside = join(tmpdir(), `atticus-outside-${Date.now()}.txt`);
    await writeFile(outside, "SECRET\n".repeat(10));
    const clone = join(root, "workspace/forge-orders");
    let linked = true;
    try {
      await symlink(outside, join(clone, "leak.txt"));
    } catch {
      linked = false; // Windows without the right to make links: the .. case still runs.
    }
    await mkdir(join(root, "catalog/generated/endpoint"), { recursive: true });
    await writeFile(
      join(root, "catalog/generated/endpoint/forge-orders.sneaky.yaml"),
      [
        "schemaVersion: 2",
        "kind: Endpoint",
        "id: forge-orders.sneaky",
        "status: current",
        "confidence: inferred",
        "component: forge-orders",
        "endpointType: rest",
        "method: GET",
        "pathOrTopic: /sneaky",
        "normalizedPath: /sneaky",
        "evidence:",
        "  - { source: code, repo: forge-orders, path: ../../../etc/passwd, line: 1 }",
        "  - { source: code, repo: forge-orders, path: leak.txt, line: 1 }",
        "",
      ].join("\n"),
    );
    const ix = await openIndex(root);
    const out = await call(ix, root, "show_code", { id: "forge-orders.sneaky" });
    expect(out).not.toContain("SECRET");
    expect(out).toMatch(/leaves the repo's checkout/);
    if (linked) expect(out).toMatch(/leads outside the repo's checkout/);
    await expect(
      call(ix, root, "show_code", { repo: "forge-orders", path: "/etc/passwd", line: 1 }),
    ).rejects.toThrow();
    ix.close();
  });

  it("a tool box opens the index for each call and closes it", async () => {
    const root = await contextRoot();
    let opened = 0;
    const box = contextToolBox(root, async () => {
      opened++;
      return openIndex(root);
    });
    expect(box.definitions).toBe(CONTEXT_TOOLS);
    expect(await box.call("show", { id: "fraud-screen" })).toContain("fraud-screen");
    await expect(box.call("drop_tables", {})).rejects.toThrow(/There is no tool drop_tables/);
    expect(opened).toBe(2);
  });
});
