import type { CatalogRecord, OrgPack, RecordKind, RecordOf } from "@maycombhq/core";
import { knowledgeGaps, type KnowledgeGap } from "./gaps.js";

/**
 * Coverage: for each system and each area, whether what Atticus knows was read from code
 * (verified), only stated by a document (document-only, waiting for an owner), or not known
 * at all (unknown). "Verified" here means seen in code, config or a spec, even from one side
 * of a call; each record's own confidence says how sure that is.
 */

export type AreaState = "verified" | "documentOnly" | "unknown";

export interface AreaDefinition {
  area: string;
  kinds: RecordKind[];
  /** Vendors are only expected to show interfaces and obligations. */
  vendor: boolean;
}

/** Areas, like viewpoints, defined by record kinds. */
export const COVERAGE_AREAS: AreaDefinition[] = [
  { area: "interfaces", kinds: ["Interface", "Endpoint"], vendor: true },
  {
    area: "data",
    kinds: ["DataStore", "Table", "Column", "IndexConstraint", "Migration"],
    vendor: false,
  },
  { area: "runtime", kinds: ["Deployment", "Setting"], vendor: false },
  { area: "observability", kinds: ["ObservabilityAsset"], vendor: false },
  { area: "access", kinds: ["AccessGrant"], vendor: false },
  { area: "quality", kinds: ["QualityAsset"], vendor: false },
  { area: "obligations", kinds: ["Obligation"], vendor: true },
];

export interface SystemCoverage {
  system: string;
  verified: number;
  documentOnly: number;
  unknown: number;
  gaps: number;
  areas: { area: string; state: AreaState; records: string[] }[];
}

export interface AreaCoverage {
  area: string;
  verified: number;
  documentOnly: number;
  unknown: number;
  /** Systems expected to have this area. */
  expected: number;
}

/** Features (ADR 0031): named by a person, only detected (or AI-named), and code no feature covers. */
export interface FeatureCoverage {
  confirmed: string[];
  detectedOnly: string[];
  /** Components of our own that no feature spans: what they do for users is unknown. */
  unknown: string[];
}

export interface CoverageResult {
  systems: SystemCoverage[];
  areas: AreaCoverage[];
  gaps: KnowledgeGap[];
  features: FeatureCoverage;
}

/** The features view of coverage. */
export function featureCoverage(records: CatalogRecord[]): FeatureCoverage {
  const features = records.filter(
    (r): r is RecordOf<"Capability"> => r.kind === "Capability" && r.status !== "retired",
  );
  const spanned = new Set(features.flatMap((f) => f.records));
  const vendor = new Set(
    records.filter((r) => r.kind === "System" && r.boundary === "vendor").map((r) => r.id),
  );
  const ids = (l: { id: string }[]) => l.map((x) => x.id).sort();
  return {
    confirmed: ids(features.filter((f) => f.namedBy === "person")),
    detectedOnly: ids(features.filter((f) => f.namedBy !== "person")),
    unknown: ids(
      records.filter(
        (r) =>
          r.kind === "Component" &&
          r.status !== "retired" &&
          !vendor.has(r.system) &&
          !spanned.has(r.id),
      ),
    ),
  };
}

export interface CoverageInput {
  records: CatalogRecord[];
  /** Records proposed from documents and not yet confirmed (document-only facts). */
  documents?: CatalogRecord[];
  orgPack: OrgPack;
  /** The clock, passed on to the knowledge-gap checks. */
  now?: string;
}

const DOCUMENT_SOURCES = new Set(["document", "diagram"]);

export function coverage(input: CoverageInput): CoverageResult {
  const { records, orgPack } = input;
  const docs = input.documents ?? [];
  const profileSystems = orgPack.profiles.flatMap((p) => p.profile?.systems ?? []);
  const boundary = new Map<string, string>();
  for (const s of profileSystems) boundary.set(s.id, s.boundary);
  for (const r of records) if (r.kind === "System") boundary.set(r.id, r.boundary);

  const componentSystem = new Map<string, string>();
  const storeOwner = new Map<string, string>();
  const tableSystems = new Map<string, string[]>();
  for (const r of [...records, ...docs]) {
    if (r.kind === "Component") componentSystem.set(r.id, r.system);
    if (r.kind === "DataStore" && r.ownerComponent) storeOwner.set(r.id, r.ownerComponent);
  }
  const sysOf = (id: string | undefined) =>
    id === undefined ? undefined : (componentSystem.get(id) ?? (boundary.has(id) ? id : undefined));
  for (const r of [...records, ...docs])
    if (r.kind === "Table") {
      const owner = r.ownerComponent ?? storeOwner.get(r.dataStore);
      tableSystems.set(
        r.id,
        [owner, ...r.readers, ...r.writers].map(sysOf).filter((s): s is string => !!s),
      );
    }

  /** The systems a record tells us something about. */
  const systemsOf = (r: CatalogRecord): string[] => {
    switch (r.kind) {
      case "Interface":
        return [sysOf(r.from), sysOf(r.to)].filter((s): s is string => !!s);
      case "Endpoint":
      case "Deployment":
      case "Setting":
      case "ObservabilityAsset":
      case "QualityAsset":
        return [sysOf(r.component)].filter((s): s is string => !!s);
      case "DataStore":
        return [sysOf(r.ownerComponent)].filter((s): s is string => !!s);
      case "Table":
        return tableSystems.get(r.id) ?? [];
      case "Column":
      case "IndexConstraint": {
        const t = records.find((x) => x.id === r.table);
        return t?.kind === "Table"
          ? [sysOf(t.ownerComponent ?? storeOwner.get(t.dataStore))].filter((s): s is string => !!s)
          : [];
      }
      case "Migration":
        return [sysOf(storeOwner.get(r.dataStore))].filter((s): s is string => !!s);
      case "AccessGrant":
        return [sysOf(r.subject)].filter((s): s is string => !!s);
      case "Obligation":
        return [r.system];
      default:
        return [];
    }
  };

  const fromCode = (r: CatalogRecord) => r.evidence.some((e) => !DOCUMENT_SOURCES.has(e.source));
  const kindArea = new Map<string, string>();
  for (const a of COVERAGE_AREAS) for (const k of a.kinds) kindArea.set(k, a.area);
  // system → area → { verified ids, document ids }
  const seen = new Map<string, Map<string, { code: string[]; doc: string[] }>>();
  const note = (r: CatalogRecord, proposed: boolean) => {
    const area = kindArea.get(r.kind);
    if (!area || r.status === "retired") return;
    for (const s of new Set(systemsOf(r))) {
      const bySys = seen.get(s) ?? new Map<string, { code: string[]; doc: string[] }>();
      seen.set(s, bySys);
      const slot = bySys.get(area) ?? { code: [], doc: [] };
      bySys.set(area, slot);
      if (!proposed && fromCode(r)) slot.code.push(r.id);
      else slot.doc.push(r.id);
    }
  };
  for (const r of records) note(r, false);
  for (const r of docs) note(r, true);

  const gaps = knowledgeGaps({
    records,
    orgPack,
    documents: docs,
    ...(input.now ? { now: input.now } : {}),
  });
  const systems: SystemCoverage[] = [...boundary.keys()].sort().map((system) => {
    const vendor = boundary.get(system) === "vendor";
    const areas = COVERAGE_AREAS.filter((a) => !vendor || a.vendor).map((a) => {
      const slot = seen.get(system)?.get(a.area);
      const state: AreaState = slot?.code.length
        ? "verified"
        : slot?.doc.length
          ? "documentOnly"
          : "unknown";
      return {
        area: a.area,
        state,
        records: [...new Set([...(slot?.code ?? []), ...(slot?.doc ?? [])])].sort(),
      };
    });
    const count = (s: AreaState) => areas.filter((a) => a.state === s).length;
    return {
      system,
      verified: count("verified"),
      documentOnly: count("documentOnly"),
      unknown: count("unknown"),
      gaps: gaps.filter((g) => g.system === system).length,
      areas,
    };
  });
  const areas: AreaCoverage[] = COVERAGE_AREAS.map((a) => {
    const states = systems.flatMap((s) => s.areas.filter((x) => x.area === a.area));
    return {
      area: a.area,
      verified: states.filter((x) => x.state === "verified").length,
      documentOnly: states.filter((x) => x.state === "documentOnly").length,
      unknown: states.filter((x) => x.state === "unknown").length,
      expected: states.length,
    };
  });
  return { systems, areas, gaps, features: featureCoverage(records) };
}

/** The C4 local API's Coverage shape: known counts only what is verified, never document-only. */
export function toApiCoverage(c: CoverageResult): {
  areas: { area: string; known: number; expected: number }[];
  systems: { system: string; known: number; expected: number; gaps: number }[];
} {
  return {
    areas: c.areas.map((a) => ({ area: a.area, known: a.verified, expected: a.expected })),
    systems: c.systems.map((s) => ({
      system: s.system,
      known: s.verified,
      expected: s.areas.length,
      gaps: s.gaps,
    })),
  };
}
