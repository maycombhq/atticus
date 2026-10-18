import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord, type CatalogRecord } from "@maycombhq/core";
import { graph, impact, openIndex, QueryError } from "../src/index.js";

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");

/** The expected Forge catalog, as catalog files. */
function forgeRecords(): CatalogRecord[] {
  const rows = parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[];
  return rows.map((r) => {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(`${String(r.id)}: ${JSON.stringify(p.issues)}`);
    return p.record;
  });
}

async function forgeRoot(extra: CatalogRecord[] = []): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-index-"));
  for (const r of [...forgeRecords(), ...extra]) {
    const f = join(root, "catalog/generated", recordPath(r));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(r));
  }
  return root;
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("the local index", () => {
  it("builds from catalog files, reuses itself while they are unchanged, and rebuilds when one changes", async () => {
    const root = await forgeRoot();
    const a = await openIndex(root);
    expect(a.rebuilt).toBe(true);
    expect(a.problems).toEqual([]);
    expect(a.kinds().find((k) => k.kind === "Interface")).toEqual({
      kind: "Interface",
      count: 7,
      stale: 0,
    });
    a.close();

    const b = await openIndex(root);
    expect(b.rebuilt).toBe(false);
    b.close();

    const f = join(root, "catalog/generated/system/audit.yaml");
    await writeFile(f, readFileSync(f, "utf8").replace("name: Audit", "name: Audit Service"));
    const c = await openIndex(root);
    expect(c.rebuilt).toBe(true);
    expect(c.get("System", "audit")).toMatchObject({ name: "Audit Service" });
    c.close();
    expect((await stat(join(root, ".index/catalog.sqlite"))).size).toBeLessThan(2 * 1024 * 1024);
  });

  it("reports files that fail C1 and leaves them out", async () => {
    const root = await forgeRoot();
    await writeFile(
      join(root, "catalog/generated/system/broken.yaml"),
      "kind: System\nid: broken\n",
    );
    const ix = await openIndex(root);
    expect(ix.problems.map((p) => p.file)).toEqual(["catalog/generated/system/broken.yaml"]);
    expect(ix.get("System", "broken")).toBeUndefined();
    ix.close();
  });

  it("answers queries in the query language", async () => {
    const ix = await openIndex(await forgeRoot());
    expect(ids(ix.query("kind:interface via:gateway").rows)).toEqual([
      "if-75b5e8d8aa780837",
      "if-d99f508a2ac9b6e0",
    ]);
    expect(ix.query("kind:interface -confidence:verified").rows.map((r) => r.id)).toEqual([
      "if-5c55930b735276a9",
    ]);
    expect(ix.query("kind:interface missing:pattern").total).toBe(2);
    expect(ix.query("pattern.code:S.GW.*").total).toBe(2);
    expect(ids(ix.query("kind:table readers:reports-job").rows)).toEqual(["ledger-db.entry"]);
    expect(ids(ix.query("kind:component system:portal").rows)).toEqual(["portal-bff", "portal-ui"]);
    expect(ix.query("kind:column system:ledger").total).toBe(7);
    expect(ids(ix.query("kind:interface refs:audit-svc").rows)).toEqual(["if-5c55930b735276a9"]);
    expect(ids(ix.query("refby:if-5c55930b735276a9").rows)).toEqual(["audit-svc", "portal-bff"]);
    expect(ids(ix.query('"northwind pay"').rows)).toEqual(["northwind-pay"]);
    expect(ix.query("holder").rows.map((r) => `${r.kind}/${r.id}`)).toEqual([
      "Column/ledger-db.account.holder-name",
    ]);
    expect(ix.query("kind:interface", { limit: 3 }).rows.length).toBe(3);
    expect(ix.query("kind:interface", { limit: 3 }).total).toBe(7);
    expect(() => ix.query("kind:nope")).toThrow(QueryError);
    ix.close();
  });

  it("lists one kind page by page", async () => {
    const ix = await openIndex(await forgeRoot());
    const p1 = ix.list("Column", { limit: 4 });
    expect(p1.total).toBe(7);
    expect(p1.items.length).toBe(4);
    const p2 = ix.list("Column", { limit: 4, cursor: p1.next! });
    expect(p2.items.length).toBe(3);
    expect(p2.next).toBeUndefined();
    expect(new Set([...p1.items, ...p2.items].map((r) => r.id)).size).toBe(7);
    expect(ix.list("Component", { system: "portal" }).items.map((r) => r.id)).toEqual([
      "portal-bff",
      "portal-ui",
    ]);
    ix.close();
  });
});

describe("graph", () => {
  it("draws systems, components and interfaces, or the neighbourhood of a focus", async () => {
    const ix = await openIndex(await forgeRoot());
    const all = graph(ix);
    expect(all.edges.length).toBe(7);
    expect(all.nodes.filter((n) => n.kind === "System").map((n) => n.id)).toEqual([
      "audit",
      "ledger",
      "northwind-pay",
      "portal",
      "reports",
    ]);
    expect(all.edges.find((e) => e.id === "if-75b5e8d8aa780837")).toEqual({
      id: "if-75b5e8d8aa780837",
      from: "portal-bff",
      to: "ledger-api",
      via: "gateway",
      pattern: "S.GW.SOR",
      confidence: "verified",
      status: "current",
    });
    const near = graph(ix, { focus: "reports-job", depth: 1 });
    expect(near.nodes.map((n) => n.id).sort()).toEqual([
      "ledger",
      "ledger-api",
      "reports",
      "reports-job",
    ]);
    expect(near.edges.map((e) => e.id)).toEqual(["if-f1cd1f189eaa4b7b"]);
    expect(graph(ix, { focus: "nope" })).toEqual({ nodes: [], edges: [] });
    ix.close();
  });
});

describe("impact", () => {
  it("follows a column to its table, the components that use it, and their callers", async () => {
    const ix = await openIndex(await forgeRoot());
    const r = impact(ix, "ledger-db.entry.amount", 4)!;
    const by = new Map(r.affected.map((a) => [a.id, a]));
    expect(by.get("ledger-db.entry")).toMatchObject({
      kind: "Table",
      path: ["ledger-db.entry.amount", "ledger-db.entry"],
    });
    expect(by.get("reports-job")).toMatchObject({
      kind: "Component",
      reason: "reads ledger-db.entry",
      owner: "team-reports",
    });
    expect(by.get("ledger-api")).toMatchObject({ kind: "Component", owner: "team-ledger" });
    expect(by.get("portal-bff")).toMatchObject({
      kind: "Component",
      reason: expect.stringMatching(/^calls ledger-api \((GET|POST) /),
      path: [
        "ledger-db.entry.amount",
        "ledger-db.entry",
        "ledger-api",
        expect.stringMatching(/^if-/),
        "portal-bff",
      ],
    });
    expect(by.get("portal-bff.ledger-read-timeout")).toMatchObject({
      kind: "Setting",
      reason: "is a setting for calls to ledger-api",
    });
    // ledger-api publishes transfers-completed, so reports-job (its subscriber) is reached that way too;
    // northwind-pay is called by ledger-api, so a change in ledger-api doesn't reach it.
    expect(r.affected.map((a) => a.id)).toContain("if-f1cd1f189eaa4b7b");
    expect(by.has("northwind-pay")).toBe(false);
    // The event from portal-bff to ledger-api doesn't make portal-bff depend on ledger-api.
    expect(by.has("if-32d38aecd11b86b1")).toBe(false);
    ix.close();
  });

  it("follows a topic to its subscribers", async () => {
    const ix = await openIndex(await forgeRoot());
    const r = impact(ix, "topic.transfers-completed")!;
    expect(r.affected.map((a) => [a.id, a.reason])).toEqual([
      ["if-f1cd1f189eaa4b7b", "carries topic.transfers-completed"],
      ["reports-job", expect.stringMatching(/^receives .* from ledger-api$/)],
    ]);
    ix.close();
  });

  it("for an endpoint, reaches only the calls to that endpoint, and lists the gaps", async () => {
    const extra = parseRecord({
      schemaVersion: 1,
      kind: "Unresolved",
      id: "portal-bff.unresolved-1",
      status: "current",
      confidence: "inferred",
      unresolvedKind: "http-call",
      raw: "GET https://fx.example.com/rates",
      owner: "portal-bff",
      evidence: [{ source: "code", repo: "forge-portal-bff", path: "src/Rates.java", line: 3 }],
    });
    if (!extra.ok) throw new Error(JSON.stringify(extra.issues));
    const ix = await openIndex(await forgeRoot([extra.record]));
    const r = impact(ix, "ledger-api.post-transfer")!;
    // portal-bff calls it; portal-ui calls portal-bff; ledger-api subscribes to what portal-bff publishes.
    expect(r.affected.map((a) => a.id)).toEqual([
      "if-d99f508a2ac9b6e0",
      "portal-bff",
      "if-32d38aecd11b86b1",
      "if-f5c8b4b06d75284f",
      "ledger-api",
      "portal-ui",
    ]);
    expect(r.affected[0]).toMatchObject({
      kind: "Interface",
      reason: "calls ledger-api.post-transfer",
    });
    expect(r.affected[1]).toMatchObject({
      id: "portal-bff",
      reason: "calls ledger-api (POST /transfers)",
    });
    expect(r.gaps).toContainEqual({
      record: "portal-bff.unresolved-1",
      field: "raw",
      question: expect.stringContaining("GET https://fx.example.com/rates"),
    });

    const audit = impact(ix, "audit-svc")!;
    expect(audit.gaps).toContainEqual({
      record: "if-5c55930b735276a9",
      field: "confidence",
      question: "Only one end of this call was seen. Does portal-bff really call audit-svc?",
    });
    expect(impact(ix, "nope")).toBeUndefined();
    ix.close();
  });
});
