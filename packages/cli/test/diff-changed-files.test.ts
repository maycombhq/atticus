import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { recordPath, type CatalogRecord } from "@maycombhq/core";
import { diffCatalogFiles, diffCatalogs } from "@maycombhq/scanner";

/**
 * ADR 0205 step 1: comparing only the record files a write added, changed or removed gives what
 * comparing the whole catalog gives, for any catalog and any change, when each file left as it
 * was holds the record it held (the same bytes, the same parse).
 */
const rec = (kind: string, id: string, v: number, line: number) =>
  ({
    kind,
    id,
    schemaVersion: 2,
    status: "current",
    confidence: "declared",
    value: v,
    evidence: [{ source: "code", path: "a.java", line }],
  }) as unknown as CatalogRecord;

const kinds = ["Endpoint", "Interface", "Table", "Setting"];

describe("the comparison over the changed files is the comparison over the whole catalog", () => {
  it("holds for random catalogs and random changes (300 runs)", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(fc.constantFrom(...kinds), fc.integer({ min: 0, max: 60 })), {
          selector: ([k, n]) => `${k}${n}`,
          maxLength: 40,
        }),
        fc.array(fc.tuple(fc.nat(), fc.constantFrom("value", "evidence", "remove", "keep")), {
          maxLength: 40,
        }),
        fc.uniqueArray(fc.tuple(fc.constantFrom(...kinds), fc.integer({ min: 61, max: 90 })), {
          selector: ([k, n]) => `${k}${n}`,
          maxLength: 10,
        }),
        (ids, edits, added) => {
          const before = ids.map(([k, n]) => rec(k, `x-${n}`, n, 1));
          const after = new Map(before.map((r) => [recordPath(r), r]));
          const changed = new Set<string>();
          for (const [at, how] of edits) {
            const r = before[at % Math.max(1, before.length)];
            if (!r || how === "keep") continue;
            const p = recordPath(r);
            changed.add(p);
            if (how === "remove") after.delete(p);
            else {
              const was = r as unknown as { value: number };
              after.set(
                p,
                how === "value"
                  ? rec(r.kind, r.id, was.value + 1, 1)
                  : rec(r.kind, r.id, was.value, 2),
              );
            }
          }
          for (const [k, n] of added) {
            const r = rec(k, `x-${n}`, n, 1);
            after.set(recordPath(r), r);
            changed.add(recordPath(r));
          }
          const files = new Map(before.map((r) => [recordPath(r), { record: r }]));
          const now = [...after.values()];
          expect(diffCatalogFiles({ records: before, files }, now, [...changed])).toEqual(
            diffCatalogs(before, now),
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});
