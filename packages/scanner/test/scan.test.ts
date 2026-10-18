import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { endpointId, type CatalogRecord } from "@maycombhq/core";
import { diffCatalogs, diffIsEmpty, readCatalog, scanEstate, writeCatalog } from "../src/index.js";
import { compareCatalog } from "./compare.js";

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
const T = 120_000;
const expected = (
  parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<string, unknown>[]
).map(
  (r) =>
    ({ status: "current", ...r }) as unknown as Record<string, unknown> & {
      kind: string;
      id: string;
    },
);

async function scanForge(opts: { root?: string; cache?: null } = {}) {
  const root = opts.root ?? (await mkdtemp(join(tmpdir(), "atticus-scan-")));
  const scan = await scanEstate({
    root,
    orgPack: join(FORGE, "metarepo/org-pack"),
    repoDir: (id) => join(FORGE, "repos", id),
    repoState: async () => ({ commit: "a".repeat(40), dirty: false }),
    ...(opts.cache === null ? { cache: null } : {}),
    scannedAt: "2026-10-18T09:00:00Z",
  });
  return { root, scan };
}

/**
 * Facts that come from documents in inputs/ (the vendor's partner spec) arrive with intake
 * in M2. Until then the vendor endpoint is missing and the vendor call can only be inferred.
 */
const AWAITING_INTAKE = {
  skip: ["northwind-pay.post-payment"],
  ignoreFields: { System: ["confidence"], Interface: [] as string[] },
};

describe("scan of the Forge fixture (M1 exit)", () => {
  it(
    "finds every interface in the expected catalog and no others",
    async () => {
      const { scan } = await scanForge({ cache: null });
      expect(scan.problems).toEqual([]);
      const want = new Set(expected.filter((e) => e.kind === "Interface").map((e) => e.id));
      const got = new Set(scan.records.filter((r) => r.kind === "Interface").map((r) => r.id));
      const found = [...want].filter((id) => got.has(id));
      const falseEdges = [...got].filter((id) => !want.has(id));
      expect(found.length / want.size).toBeGreaterThanOrEqual(0.95);
      expect(found).toHaveLength(want.size);
      expect(falseEdges).toEqual([]);
    },
    T,
  );

  it(
    "matches the expected catalog record for record, field for field",
    async () => {
      const { scan } = await scanForge({ cache: null });
      const kinds = [...new Set(expected.map((e) => e.kind))];
      const c = compareCatalog(scan.records, expected, kinds, {
        skip: AWAITING_INTAKE.skip,
        ignoreFields: AWAITING_INTAKE.ignoreFields,
      });
      expect(c.missing).toEqual([]);
      expect(c.extra).toEqual([]);
      // The vendor interface lacks its callee end until the partner spec is taken in.
      expect(c.fieldDiffs).toEqual([
        'Interface/if-e7344c9455608119.confidence: expected "verified", got "inferred"',
        'Interface/if-e7344c9455608119.endpoint: expected "northwind-pay.post-payment", got undefined',
      ]);
      // Evidence must match exactly for everything except systems and components, whose
      // evidence is the first file that shows them (ADR 0017).
      expect(
        c.evidenceDiffs.filter((d) => !d.startsWith("System/") && !d.startsWith("Component/")),
      ).toEqual([
        "Interface/if-e7344c9455608119: missing [:inputs/partner-specs/northwind-pay-openapi.yaml:6:callee] extra []",
      ]);
    },
    T,
  );

  it(
    "verifies interfaces only when both ends are seen, and infers the pattern of each hop",
    async () => {
      const { scan } = await scanForge({ cache: null });
      const ifs = scan.records.filter((r) => r.kind === "Interface") as unknown as {
        id: string;
        confidence: string;
        pattern?: { code: string };
      }[];
      expect(ifs.find((i) => i.id === "if-5c55930b735276a9")!.confidence).toBe("inferred");
      expect(ifs.find((i) => i.id === "if-75b5e8d8aa780837")!.pattern?.code).toBe("S.GW.SOR");
      expect(ifs.find((i) => i.id === "if-e7344c9455608119")!.pattern).toBeUndefined();
      expect(ifs.find((i) => i.id === "if-5c55930b735276a9")!.pattern).toBeUndefined();
    },
    T,
  );

  it(
    "serves an unchanged rescan from the cache with identical results",
    async () => {
      const first = await scanForge();
      const second = await scanForge({ root: first.root });
      expect(second.scan.stats.ranRuns).toBe(0);
      expect(second.scan.stats.cachedRuns).toBe(first.scan.stats.ranRuns);
      expect(second.scan.records).toEqual(first.scan.records);
    },
    T,
  );
});

describe("catalog files and diff", () => {
  it(
    "writes canonical files, leaves unchanged ones alone, removes stale ones, and reads them back",
    async () => {
      const { root, scan } = await scanForge({ cache: null });
      const dir = join(root, "catalog/generated");
      const w1 = await writeCatalog(dir, scan.records);
      expect(w1).toEqual({ written: scan.records.length, unchanged: 0, removed: 0 });
      expect(await readFile(join(dir, "interface/if-75b5e8d8aa780837.yaml"), "utf8")).toMatch(
        /^schemaVersion: 1\nkind: Interface\nid: if-75b5e8d8aa780837\n/,
      );
      await writeFile(join(dir, "system/old.yaml"), "x");
      const w2 = await writeCatalog(dir, scan.records);
      expect(w2).toEqual({ written: 0, unchanged: scan.records.length, removed: 1 });
      const back = await readCatalog(dir);
      expect(back.problems).toEqual([]);
      expect(back.records).toEqual(scan.records);
    },
    T,
  );

  it("reports added, removed, changed and evidence-only differences", () => {
    const a = expected.slice(0, 3) as unknown as CatalogRecord[];
    const changed = { ...a[1], name: "Renamed" } as CatalogRecord;
    const moved = {
      ...a[2],
      evidence: [{ source: "code", path: "elsewhere.java", line: 1 }],
    } as CatalogRecord;
    const added = { ...a[0], id: "new-one" } as CatalogRecord;
    const d = diffCatalogs(a, [changed, moved, added]);
    expect(d.added).toEqual([{ kind: a[0]!.kind, id: "new-one" }]);
    expect(d.removed).toEqual([{ kind: a[0]!.kind, id: a[0]!.id }]);
    expect(d.changed).toEqual([{ kind: a[1]!.kind, id: a[1]!.id, fields: ["name"] }]);
    expect(d.evidenceOnly).toEqual([{ kind: a[2]!.kind, id: a[2]!.id }]);
    expect(diffIsEmpty(diffCatalogs(a, a))).toBe(true);
  });
});

describe("endpoint identity", () => {
  it("names endpoints by method and the last fixed path segment, singular", () => {
    expect(endpointId("ledger-api", "GET", "/accounts/{}/balance")).toBe("ledger-api.get-balance");
    expect(endpointId("ledger-api", "POST", "/transfers")).toBe("ledger-api.post-transfer");
    expect(endpointId("x", "GET", "/v2/policies/{}")).toBe("x.get-policy");
    expect(endpointId("x", "GET", "/")).toBe("x.get-root");
  });
});
