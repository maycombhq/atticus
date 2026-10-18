import { describe, expect, it } from "vitest";
import {
  endpointId,
  interfaceId,
  mergeCatalog,
  type CatalogRecord,
  type MergePattern,
} from "../src/index.js";

const ev = [
  {
    source: "code" as const,
    repo: "r",
    path: "a.java",
    line: 1,
    commit: "a1b2c3d",
    scannedAt: "2026-10-18T09:00:00Z",
    extractor: "x@1",
    side: "caller" as const,
  },
];
const base = {
  schemaVersion: 1 as const,
  status: "current" as const,
  confidence: "verified" as const,
  evidence: ev,
};
const component = (id: string, system: string) =>
  ({
    ...base,
    kind: "Component",
    id,
    system,
    repo: `forge-${id}`,
    type: "service",
  }) as unknown as CatalogRecord;
const hop = (from: string, to: string, via: string, path = "/x") =>
  ({
    ...base,
    confidence: "inferred",
    kind: "Interface",
    id: interfaceId(from, to, "GET", path),
    from,
    to,
    via,
    method: "GET",
    normalizedPath: path,
    sync: "sync",
  }) as unknown as CatalogRecord;

const systems = [
  { id: "portal", name: "Portal", boundary: "product" as const, aliases: [] },
  { id: "ledger", name: "Ledger", boundary: "product" as const, aliases: [] },
  { id: "pay", name: "Pay", boundary: "vendor" as const, aliases: [] },
];
const patterns: MergePattern[] = [
  {
    code: "S.DIR.BFF",
    status: "approved",
    detection: { via: ["direct"], sync: "sync", sameSystem: true },
  },
  {
    code: "S.DIR.VND",
    status: "approved",
    detection: { via: ["direct"], targetBoundary: "vendor" },
  },
  { code: "S.OLD", status: "deprecated", detection: { via: ["gateway"] } },
];

function merged(records: CatalogRecord[]) {
  return mergeCatalog({ records, repos: [], systems, patterns });
}

describe("mergeCatalog: inferred integration patterns", () => {
  it("tags a hop with the one approved pattern it fits, and leaves ambiguous or unmatched hops alone", () => {
    const r = merged([
      component("ui", "portal"),
      component("bff", "portal"),
      component("api", "ledger"),
      hop("ui", "bff", "direct"),
      hop("bff", "api", "direct"),
      hop("bff", "api", "gateway", "/y"),
    ]);
    expect(r.invalid.map((i) => JSON.stringify(i.issues))).toEqual([]);
    const ifs = r.records.filter((x) => x.kind === "Interface") as unknown as {
      from: string;
      to: string;
      via: string;
      pattern?: { code: string; source: string };
    }[];
    expect(ifs.find((i) => i.from === "ui")!.pattern).toEqual({
      code: "S.DIR.BFF",
      source: "inferred",
    });
    // Across systems: S.DIR.BFF needs the same system; deprecated patterns never match.
    expect(ifs.find((i) => i.to === "api" && i.via === "direct")!.pattern).toBeUndefined();
    expect(ifs.find((i) => i.to === "api" && i.via === "gateway")!.pattern).toBeUndefined();
  });
});

describe("endpointId", () => {
  it("names an endpoint by component, method and the singular last fixed segment", () => {
    expect(endpointId("ledger-api", "GET", "/accounts/{}/balance")).toBe("ledger-api.get-balance");
    expect(endpointId("ledger-api", "POST", "/transfers")).toBe("ledger-api.post-transfer");
  });
});
