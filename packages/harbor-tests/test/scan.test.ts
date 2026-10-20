import { beforeAll, describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import type { EstateScan } from "@maycombhq/scanner";
import { compare, harborRecords, scanHarbor } from "./harbor.js";
import { PENDING, pendingKeys } from "./pending.js";

/**
 * Stage: scan (scanEstate over fixtures/harbor/repos plus inputs/), compared with the
 * hand-written expected/scan.yaml record for record, field for field.
 *
 * Kinds compared are the ones expected/scan.yaml lists. Not compared: Unresolved loose ends
 * (hash ids), SourceDocument (intake's own test), Capability (features test), GlossaryTerm and
 * the glossary links on columns (an enrichment, ADR 0039). Systems and components carry the
 * first file that shows them as evidence (ADR 0017), so their evidence isn't compared.
 */

const key = (r: { kind: string; id: string }) => `${r.kind}/${r.id}`;
const expected = harborRecords();
const KINDS = new Set(expected.map((r) => r.kind));
const pending = pendingKeys();
const extraOnMain = new Set(Object.values(PENDING).flatMap((g) => g.extraOnMain ?? []));

let scan: EstateScan;
beforeAll(async () => {
  scan = await scanHarbor();
}, 300_000);

const scanned = (): CatalogRecord[] => scan.records.filter((r) => KINDS.has(r.kind));
const evidenceCompared = (d: string) => !d.startsWith("System/") && !d.startsWith("Component/");

function compareGroup(keys: Set<string>) {
  const want = expected.filter((r) => keys.has(key(r)));
  const got = scanned().filter((r) => keys.has(key(r)));
  return compare(got, want, { ignoreFields: { Column: ["glossaryTerm"] } });
}

describe("scan of the Harbor fixture", () => {
  it("runs with no problems: every extractor, the harbor-outbox dialect and intake", () => {
    expect(scan.problems).toEqual([]);
  });

  it("matches every record main can already produce, field for field", () => {
    const keys = new Set(expected.map(key).filter((k) => !pending.has(k)));
    // 131 expected records, 3 of them waiting for a producer (pending.ts).
    expect([expected.length, keys.size]).toEqual([131, 128]);
    const c = compareGroup(keys);
    expect(c.missing).toEqual([]);
    expect(c.fieldDiffs).toEqual([]);
    expect(c.evidenceDiffs.filter(evidenceCompared)).toEqual([]);
    // Nothing beyond the expected catalog, apart from what a pending producer will replace.
    const extra = scanned()
      .map(key)
      .filter((k) => !expected.some((e) => key(e) === k) && !extraOnMain.has(k));
    expect(extra).toEqual([]);
  });

  it("finds every interface main can produce, at its expected id, and no others", () => {
    const want = expected.filter((r) => r.kind === "Interface").map(key);
    const got = new Set(
      scanned()
        .filter((r) => r.kind === "Interface")
        .map(key),
    );
    for (const k of want.filter((x) => !pending.has(x))) expect(got.has(k), k).toBe(true);
    for (const k of got) expect(want.includes(k), k).toBe(true);
  });

  it("verifies an interface only when both ends are seen, and infers patterns", () => {
    const byId = new Map(scanned().map((r) => [r.id, r]));
    // The event published through the outbox library (dialect) to a kafkajs consumer.
    expect(byId.get("if-9799eee043a9c9bc")).toMatchObject({
      confidence: "verified",
      pattern: { code: "HB.ASYNC.EVENT", source: "inferred" },
    });
    // Known from the caller only: the fraud service has no repo.
    expect(byId.get("if-86fee9e6f849eb46")).toMatchObject({ confidence: "inferred" });
    expect(byId.get("fraud-score")).toMatchObject({ kind: "Component", confidence: "inferred" });
  });
});

// One group per missing producer. Remove a group's name from SKIPPED once its producer is on
// main; its records are then compared like the rest. HARBOR_PENDING=run runs every group, to
// see what each producer still misses.
const SKIPPED = new Set(process.env.HARBOR_PENDING === "run" ? [] : Object.keys(PENDING));

describe("records waiting for a producer (ADR 0040 and gaps found by Harbor)", () => {
  for (const [group, g] of Object.entries(PENDING)) {
    const run = SKIPPED.has(group) ? it.skip : it;
    // Missing producer: see PENDING[group].producer.
    run(`${group}: ${g.producer}`, () => {
      const c = compareGroup(new Set(g.records));
      expect(c.missing).toEqual([]);
      expect(c.fieldDiffs).toEqual([]);
      expect(c.evidenceDiffs.filter(evidenceCompared)).toEqual([]);
      for (const k of g.extraOnMain ?? [])
        expect(
          scanned().some((r) => key(r) === k),
          k,
        ).toBe(false);
    });
  }
});
