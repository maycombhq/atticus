import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import { readMermaid } from "@maycombhq/ingestors";
import {
  readDrawio,
  reconcile,
  type ReconcileItem,
  type ReconcileResult,
} from "@maycombhq/reconcile";
import {
  expectedFile,
  HARBOR,
  harborPack,
  harborRecords,
  harborSystems,
  scanHarbor,
  type Discrepancy,
} from "./harbor.js";

/**
 * Stage: reconcile. Both Harbor diagrams against the expected catalog: every seeded reconcile
 * discrepancy (h01-h08) is reported, and nothing else. The data-platform diagram is a partial
 * view: the request-path calls of the services it shows are drawn on the architecture diagram
 * instead, so it reports them as code-only, and only those.
 */

const MERMAID = "inputs/diagrams/harbor-architecture.mmd";
const DRAWIO = "inputs/diagrams/harbor-data-platform.drawio";
const seeded = expectedFile<Discrepancy[]>("discrepancies.yaml").filter(
  (d) => d.found_by === "reconcile",
);

async function run(
  file: string,
  records: CatalogRecord[] = harborRecords(),
): Promise<ReconcileResult> {
  const op = await harborPack();
  const profile = op.profiles[0]!.profile!;
  const text = readFileSync(join(HARBOR, file), "utf8");
  return reconcile({
    diagram: file.endsWith(".mmd")
      ? readMermaid(text, profile.legend)
      : readDrawio(text, profile.legend),
    file,
    records,
    systems: harborSystems(op),
    patterns: op.patterns,
  });
}

/** The reconcile items that stand for each seeded discrepancy, with the diagram they're on. */
const SEEDED: Record<
  string,
  { file: string; items: (i: ReconcileItem) => boolean; count: number }
> = {
  "h01-vendor-calls-direct": {
    file: MERMAID,
    count: 3,
    items: (i) =>
      i.type === "pattern-mismatch" &&
      ["e7", "e12"].includes(i.diagram?.cell ?? "") &&
      /HB\.VND\.EGRESS goes through the gateway, the code calls directly/.test(i.summary),
  },
  "h02-pipeline-reads-orders-db": {
    file: DRAWIO,
    count: 1,
    items: (i) =>
      i.type === "drawn-call-reads-database" &&
      i.diagram?.cell === "d1" &&
      i.records.join() === "orders-db.orders" &&
      /HB\.DATA\.ELT, not HB\.SYNC\.MESH/.test(i.summary),
  },
  "h03-undocumented-fraud-call": {
    file: MERMAID,
    count: 1,
    items: (i) =>
      i.type === "code-only" &&
      i.records[0] === "if-86fee9e6f849eb46" &&
      /seen at one end only/.test(i.summary),
  },
  "h04-undocumented-orders-placed": {
    file: MERMAID,
    count: 1,
    items: (i) => i.type === "code-only" && i.records[0] === "if-2a8d8dd6ededf292",
  },
  "h05-planned-loyalty": {
    file: MERMAID,
    count: 1,
    items: (i) => i.type === "planned" && i.diagram?.cell === "e14" && i.legend === "new",
  },
  "h06-product-catalog-alias": {
    file: MERMAID,
    count: 1,
    items: (i) =>
      i.type === "alias-needed" && i.records[0] === "catalog-svc" && i.name === "Product Catalog",
  },
  // Drawn the wrong way round, so the real call is also missing from the diagram.
  "h07-recs-arrow-reversed": {
    file: MERMAID,
    count: 2,
    items: (i) =>
      i.records.join() === "if-9c51c4944979e455" &&
      ((i.type === "direction-differs" && i.diagram?.cell === "e13") || i.type === "code-only"),
  },
  "h08-event-pattern-typo": {
    file: MERMAID,
    count: 1,
    items: (i) =>
      i.type === "unknown-pattern" &&
      i.diagram?.cell === "e10" &&
      i.suggestion?.text === "Did you mean HB.ASYNC.EVENT?",
  },
};

describe("reconcile the Harbor diagrams with the catalog", () => {
  it("reports every seeded reconcile discrepancy (h01-h08)", async () => {
    expect(seeded.map((d) => d.id).sort()).toEqual(Object.keys(SEEDED).sort());
    const results: Record<string, ReconcileResult> = {
      [MERMAID]: await run(MERMAID),
      [DRAWIO]: await run(DRAWIO),
    };
    for (const d of seeded) {
      const s = SEEDED[d.id]!;
      const hits = results[s.file]!.items.filter(s.items);
      expect(
        hits,
        `${d.id}: ${JSON.stringify(
          results[s.file]!.items.map((i) => [i.type, i.summary]),
          null,
          1,
        )}`,
      ).toHaveLength(s.count);
      for (const ref of d.refs)
        expect(
          hits.some((h) => h.records.includes(ref)),
          `${d.id} ${ref}`,
        ).toBe(true);
    }
  });

  // Pending: reconcile reading gRPC edge labels. It matches a drawn "METHOD /path" to an
  // Interface's method and normalizedPath, and a gRPC Interface carries the RPC method and
  // "package.Service/Method" (C1), so the drawn wire form (POST /harbor.inventory.v1.Inventory/
  // CheckStock, edge e5) matches none: it reads as drawn-only, and the call as code-only.
  const GRPC_CALL = "if-8e69b1c4ccb0aed9";
  const grpcEdgeGap = (i: ReconcileItem) =>
    (i.type === "diagram-only" && i.diagram?.cell === "e5") ||
    (i.type === "code-only" && i.records.join() === GRPC_CALL);

  it("reports nothing else on the architecture diagram (but the gRPC edge reconcile can't read yet)", async () => {
    const r = await run(MERMAID);
    const others = r.items.filter(
      (i) =>
        !Object.values(SEEDED).some((s) => s.file === MERMAID && s.items(i)) && !grpcEdgeGap(i),
    );
    expect(others.map((i) => [i.type, i.diagram?.cell, i.records])).toEqual([]);
  });

  it("matches the architecture diagram's edges to the interfaces they show", async () => {
    const r = await run(MERMAID);
    expect(r.matches).toEqual([
      {
        cell: "e1",
        interfaces: [
          "if-48178a435150f443",
          "if-95c398a68099a3e5",
          "if-9e795e3899379f37",
          "if-d9b83070fa73af6e",
        ],
      },
      {
        cell: "e2",
        interfaces: ["if-18efeccc7ba574be", "if-924d2e2fb35e1629", "if-d35e619ee1aa530d"],
      },
      { cell: "e3", interfaces: ["if-46861c9fa2695f99", "if-6394ddc280a46330"] },
      { cell: "e4", interfaces: ["if-2fade641225c4539", "if-f571ccbd0ee1281d"] },
      { cell: "e6", interfaces: ["if-a24c46bb442ec4b3"] },
      { cell: "e7", interfaces: ["if-018d1416ec04a61a", "if-a4ccfcea11eeebf0"] },
      { cell: "e8", interfaces: ["if-471a26719fe84220"] },
      { cell: "e9", interfaces: ["if-9c9b1e808fbaac38"] },
      { cell: "e10", interfaces: ["if-9799eee043a9c9bc"] },
      { cell: "e11", interfaces: ["if-0fe11f6ee6c3429f"] },
      { cell: "e12", interfaces: ["if-10465a7b9c85231e"] },
    ]);
  });

  it.skip("matches the drawn gRPC call (e5) to the gRPC interface (pending: reconcile reading gRPC edge labels)", async () => {
    const r = await run(MERMAID);
    expect(r.matches).toContainEqual({ cell: "e5", interfaces: [GRPC_CALL] });
  });

  it("matches the data-platform diagram's drawn data access to the tables read", async () => {
    const r = await run(DRAWIO);
    expect(r.matches).toEqual([
      { cell: "d2", interfaces: [], tables: ["catalog-db.products"] },
      { cell: "d3", interfaces: [], tables: ["harbor-warehouse.customer-features"] },
    ]);
  });

  it("on the partial data-platform view, reports as code-only only calls the architecture diagram shows", async () => {
    const arch = await run(MERMAID);
    const data = await run(DRAWIO);
    const shownElsewhere = new Set([
      ...arch.matches.flatMap((m) => m.interfaces),
      ...arch.items.filter((i) => i.type === "code-only").flatMap((i) => i.records),
    ]);
    const others = data.items.filter((i) => !SEEDED["h02-pipeline-reads-orders-db"]!.items(i));
    expect(others.every((i) => i.type === "code-only")).toBe(true);
    const ids = others.flatMap((i) => i.records);
    expect(
      ids.every((id) => shownElsewhere.has(id)),
      ids.join(),
    ).toBe(true);
    // Every call to or from Orders, Catalog and the model: twelve.
    expect(ids).toHaveLength(12);
  });
});

/**
 * End to end: the same diagrams against what this main's scan produces. The discrepancies
 * whose records a pending producer makes (pending.ts) can't be found yet.
 */
describe("reconcile the Harbor diagrams with the scanned catalog (end to end)", () => {
  const scannedRun = async (file: string) => run(file, (await scanHarbor()).records);

  const onMain = [
    "h03-undocumented-fraud-call",
    "h04-undocumented-orders-placed",
    "h05-planned-loyalty",
    "h06-product-catalog-alias",
    "h07-recs-arrow-reversed",
    "h08-event-pattern-typo",
  ];
  it("reports the seeded discrepancies the scanned records allow (h03-h08)", async () => {
    for (const id of onMain) {
      const s = SEEDED[id]!;
      expect((await scannedRun(s.file)).items.filter(s.items), id).toHaveLength(s.count);
    }
  });

  // Missing producer: merge resolving vendor hosts (pending.ts "vendor-hosts"); today the
  // vendor calls stay unresolved, so e7 and e12 read as diagram-only.
  it.skip("reports h01 (vendor calls direct) from the scanned catalog", async () => {
    const s = SEEDED["h01-vendor-calls-direct"]!;
    expect((await scannedRun(s.file)).items.filter(s.items)).toHaveLength(s.count);
  });

  it("reports h02 (pipeline reads the orders database) from the scanned catalog", async () => {
    const s = SEEDED["h02-pipeline-reads-orders-db"]!;
    expect((await scannedRun(s.file)).items.filter(s.items)).toHaveLength(s.count);
  });

  // Missing producers: webhook interfaces and vendor hosts (pending.ts), and reconcile reading
  // the gRPC edge label; until then e5, e7, e8 and e12 read as diagram-only.
  it.skip("reports nothing beyond the seeded discrepancies from the scanned catalog", async () => {
    const r = await scannedRun(MERMAID);
    const others = r.items.filter(
      (i) => !Object.values(SEEDED).some((s) => s.file === MERMAID && s.items(i)),
    );
    expect(others.map((i) => [i.type, i.diagram?.cell, i.records])).toEqual([]);
  });
});
