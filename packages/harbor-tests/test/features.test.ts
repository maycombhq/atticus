import { describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import { detectFeatures } from "@maycombhq/features";
import { expectedFile, harborRecords, scanHarbor } from "./harbor.js";

/**
 * Stage: features found in code (ADR 0031). The detector's grouping of entry points into
 * features must match expected/features.yaml: which entry points form one feature. Names are
 * proposals (people or AI confirm them), so they aren't compared.
 */

interface ExpectedFeature {
  name: string;
  entryPoints: string[];
  adr0040?: string[];
}
const expected = expectedFile<ExpectedFeature[]>("features.yaml");

const groups = (fs: { entryPoints: string[] }[]) =>
  fs.map((f) => [...f.entryPoints].sort()).sort((a, b) => (a[0]! < b[0]! ? -1 : 1));

/** The expected groups, limited to the entry points a detection found. */
function expectedWithin(found: Set<string>, withAdr0040: boolean): string[][] {
  return groups(
    expected
      .map((f) => ({
        entryPoints: [...f.entryPoints, ...(withAdr0040 ? (f.adr0040 ?? []) : [])].filter((e) =>
          found.has(e),
        ),
      }))
      .filter((f) => f.entryPoints.length > 0),
  );
}

const capabilities = (records: CatalogRecord[]) =>
  records.filter(
    (r): r is Extract<CatalogRecord, { kind: "Capability" }> => r.kind === "Capability",
  );

describe("features detected in the expected Harbor catalog", () => {
  it("groups every entry point, the apps' GraphQL operations and the webhook included", () => {
    const got = detectFeatures(harborRecords());
    const found = new Set(got.flatMap((f) => f.entryPoints));
    const want = expected.flatMap((f) => [...f.entryPoints, ...(f.adr0040 ?? [])]);
    expect([...found].sort()).toEqual([...want].sort());
    expect(groups(got)).toEqual(expectedWithin(found, true));
    for (const f of got) {
      expect(f).toMatchObject({ namedBy: "detected", confidence: "inferred" });
      expect(f.entryPoints.every((e) => f.records.includes(e))).toBe(true);
    }
    // The apps' calls are part of the features they start.
    const all = new Set(got.flatMap((f) => f.records));
    for (const app of ["web-app", "mobile-app"]) expect(all.has(app), app).toBe(true);
  });

  it("in the scanned catalog, groups whatever entry points this main's scan has the same way", async () => {
    const got = capabilities((await scanHarbor()).records);
    const found = new Set(got.flatMap((f) => f.entryPoints));
    const all = expected.flatMap((f) => [...f.entryPoints, ...(f.adr0040 ?? [])]);
    for (const e of found) expect(all.includes(e), e).toBe(true);
    expect(groups(got)).toEqual(expectedWithin(found, true));
  });
});
