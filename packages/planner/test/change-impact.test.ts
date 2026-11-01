import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parseRecord, recordPath, serializeRecord, type Team } from "@maycombhq/core";
import { loadChangeContext } from "@maycombhq/changes";
import { changeImpact, FlowDelta, GUESSED_LINK_RULE, loadEstate } from "../src/index.js";

/**
 * A change's impact, as designed (V1): from its target flows, who calls each entry it breaks, the
 * fields that stop crossing, the gateway routes to update, each with its owner team. A link the
 * join guessed (by path or a host's first label) may break; it is never counted as a sure break.
 * The hold-stock scenario (fixtures/stages/hold-stock) with impact/catalog.yaml added.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures");
const HOLD = join(FIX, "stages/hold-stock");
const yaml = (f: string) => parse(readFileSync(join(HOLD, f), "utf8")) as unknown;

async function root(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "atticus-impact-"));
  await mkdir(join(r, "org-pack"), { recursive: true });
  const rows = [
    ...(parse(readFileSync(join(FIX, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "stages/pin-table/catalog.yaml"), "utf8")) as unknown[]),
    ...(yaml("catalog.yaml") as unknown[]),
    ...(yaml("impact/catalog.yaml") as unknown[]),
  ];
  for (const row of rows) {
    const p = parseRecord(row);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(r, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "stages/specs"), join(r, "specs"), { recursive: true });
  return r;
}

const draft = () =>
  (yaml("drafts/clean.yaml") as { flows: object[] }).flows.map((f) =>
    FlowDelta.parse({ schemaVersion: 2, ...f }),
  );
const owned = yaml("impact/owners.yaml") as { owners: Record<string, string>; teams: Team[] };
const owners = { owners: new Map(Object.entries(owned.owners)), teams: owned.teams };

async function impactOf(deltas = draft()) {
  const r = await root();
  const e = await loadEstate(r, (await loadChangeContext(r)).records);
  return changeImpact("hold-stock", deltas, e, owners);
}

describe("a change's impact, as designed (V1)", () => {
  it("matches the golden impact: callers, fields that stop crossing, routes, each with its owner", async () => {
    const got = await impactOf();
    expect(JSON.parse(JSON.stringify(got))).toEqual(yaml("impact/expected.yaml"));
  });

  it("a link the join guessed may break and is never counted as a sure break", async () => {
    const got = await impactOf();
    const mobile = got.items[0]!.callers.find((c) => c.component === "forge-mobile")!;
    expect(mobile.verdict).toBe("may-break");
    expect(mobile.guessed).toBe("joined-by-path");
    expect(got.breaks).toBe(3);
    expect(got.mayBreak).toBe(1);
    expect(got.rule).toBe(GUESSED_LINK_RULE);
  });

  it("a caller with one link read from code and one guessed surely breaks", async () => {
    const r = await root();
    const e = await loadEstate(r, (await loadChangeContext(r)).records);
    const extra = parseRecord({
      kind: "Interface",
      schemaVersion: 2,
      id: "if-2ee10b746797b093",
      status: "current",
      confidence: "inferred",
      flags: ["joined-by-label"],
      evidence: [
        {
          source: "code",
          repo: "forge-orders",
          path: "src/orders/Other.java",
          line: 3,
          side: "caller",
        },
      ],
      from: "forge-orders",
      to: "forge-stock",
      endpoint: "forge-stock.post-stock-reservations",
      via: "direct",
      method: "POST",
      normalizedPath: "/v2/stock/reservations",
      sync: "sync",
    });
    if (!extra.ok) throw new Error("bad record");
    const { estateOf } = await import("../src/index.js");
    const got = changeImpact(
      "hold-stock",
      draft(),
      estateOf([...e.records, extra.record], e.flows),
      owners,
    );
    const orders = got.items[0]!.callers.find((c) => c.component === "forge-orders")!;
    expect(orders.verdict).toBe("breaks");
    expect(orders.guessed).toBeUndefined();
    expect(orders.interfaces).toEqual(["if-0e787b233e2b4272", "if-2ee10b746797b093"]);
    expect(got.breaks).toBe(3);
  });

  it("a flow removed: every field its entry takes and returns stops crossing", async () => {
    const got = await impactOf([
      FlowDelta.parse({
        schemaVersion: 2,
        flow: "forge-stock.reserve-stock",
        repo: "forge-stock",
        change: "remove",
        why: "Stock is no longer reserved.",
      }),
    ]);
    expect(got.items.map((i) => [i.name, i.why, i.fields])).toEqual([
      [
        "POST /stock/reservations",
        ["the flow is removed"],
        { gone: ["sku", "quantity", "reservationId"], required: [] },
      ],
    ]);
  });

  it("a change that breaks nothing has nothing to show", async () => {
    const got = await impactOf([
      FlowDelta.parse({
        schemaVersion: 2,
        flow: "forge-stock.reserve-stock",
        repo: "forge-stock",
        change: "modify",
        why: "Log the reservation.",
        steps: [{ op: "add", after: 1, kind: "log", what: "The reservation is logged" }],
      }),
    ]);
    expect(got).toMatchObject({ items: [], breaks: 0, mayBreak: 0, routes: 0, owners: [] });
  });
});
