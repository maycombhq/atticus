import type {
  CatalogRecord,
  ChangeLifecycle,
  ChangeType,
  IntegrationPattern,
  RecordOf,
} from "@maycombhq/core";
import { PHASES } from "@maycombhq/core";
import {
  artifactPhase,
  type ChangeContext,
  type Footprint,
  type PhaseId,
} from "@maycombhq/changes";
import { readHops, type ChangeFiles, type Hop } from "./artifacts.js";

/** One gate from gates.yaml (C6). */
export type GateDef = ChangeContext["orgPack"]["gates"]["gates"][number];

/**
 * Everything a check may read: the change and its artifacts, the catalog and org pack (via
 * the lifecycle's context), what the change touches and the gate being reviewed. Checks are
 * pure functions of this: files only, no network, no AI, no clock beyond `now`.
 */
export interface CriticContext {
  root: string;
  change: ChangeLifecycle;
  type: ChangeType;
  lifecycle: ChangeContext;
  footprint: Footprint;
  files: ChangeFiles;
  hops: Hop[];
  gate: GateDef;
  phase: PhaseId;
  now: string;
  records: CatalogRecord[];
  byId: Map<string, CatalogRecord>;
  patterns: Map<string, IntegrationPattern>;
  /** Classification levels (pack.yaml) and the personal ones (change policy). */
  classifications: string[];
  personalClasses: string[];
  get<K extends CatalogRecord["kind"]>(kind: K, id: string): RecordOf<K> | undefined;
  /** The system a component, system, interface end or table belongs to. */
  systemOf(id: string): string | undefined;
  boundaryOf(system: string): string | undefined;
  ownerOf(system: string): string | undefined;
  /** A caller or callee the catalog (or the profile) knows. */
  isKnown(id: string): boolean;
  /** Names people use for a component or system in prose (id, id with spaces, system name). */
  namesOf(id: string): string[];
  /** Whether a review artifact is due by this gate's phase for this change type. */
  isDue(artifact: string): boolean;
  /** The org pack's owner, who takes questions nobody else owns. */
  packOwner?: string;
}

export function buildContext(o: {
  root: string;
  change: ChangeLifecycle;
  type: ChangeType;
  lifecycle: ChangeContext;
  footprint: Footprint;
  files: ChangeFiles;
  gate: GateDef;
  now: string;
}): CriticContext {
  const { lifecycle } = o;
  const records = lifecycle.records;
  const byId = new Map(records.map((r) => [r.id, r]));
  const get = <K extends CatalogRecord["kind"]>(kind: K, id: string) => {
    const r = byId.get(id);
    return r?.kind === kind ? (r as RecordOf<K>) : undefined;
  };
  const profileSystems = new Map(
    lifecycle.orgPack.profiles.flatMap((p) => p.profile?.systems ?? []).map((s) => [s.id, s]),
  );
  const endpointOwners = new Set(
    records.filter((r) => r.kind === "Endpoint").map((r) => (r as RecordOf<"Endpoint">).component),
  );
  const systemOf = (id: string): string | undefined => {
    const c = get("Component", id);
    if (c) return c.system;
    if (get("System", id) || profileSystems.has(id)) return id;
    const t = get("Table", id);
    if (t?.ownerComponent) return systemOf(t.ownerComponent);
    const s = get("DataStore", id);
    if (s?.ownerComponent) return systemOf(s.ownerComponent);
    return undefined;
  };
  const phase = o.gate.phase;
  const gateIndex = PHASES.indexOf(phase);
  const patterns = new Map(lifecycle.orgPack.patterns.map((p) => [p.code, p]));
  const levels = lifecycle.orgPack.pack?.classification ?? [
    "public",
    "internal",
    "confidential",
    "restricted",
  ];
  return {
    root: o.root,
    change: o.change,
    type: o.type,
    lifecycle,
    footprint: o.footprint,
    files: o.files,
    hops: readHops(o.files),
    gate: o.gate,
    phase,
    now: o.now,
    records,
    byId,
    patterns,
    classifications: levels,
    personalClasses: lifecycle.policy.privacy.classifications,
    get,
    systemOf,
    boundaryOf: (s) => get("System", s)?.boundary ?? profileSystems.get(s)?.boundary,
    ownerOf: (s) => profileSystems.get(s)?.owner ?? get("System", s)?.owner,
    isKnown: (id) =>
      get("Component", id) !== undefined ||
      get("System", id) !== undefined ||
      profileSystems.has(id) ||
      endpointOwners.has(id),
    namesOf: (id) => {
      const names = new Set([id, id.replace(/-/g, " ")]);
      const sys = get("System", id) ?? undefined;
      if (sys) names.add(sys.name);
      const ps = profileSystems.get(id);
      if (ps) {
        names.add(ps.name);
        for (const a of ps.aliases) names.add(a);
      }
      return [...names].map((n) => n.toLowerCase());
    },
    isDue: (artifact) => {
      if (artifact === "catalog") return true;
      if (artifact === "code" || artifact === "tests") return gateIndex >= PHASES.indexOf("build");
      if (artifact === "release") return gateIndex >= PHASES.indexOf("release");
      if (!(o.type.artifacts as string[]).includes(artifact)) return false;
      const p = artifactPhase(lifecycle, o.type, artifact as Parameters<typeof artifactPhase>[2]);
      return PHASES.indexOf(p) <= gateIndex;
    },
    ...(lifecycle.orgPack.pack?.owner ? { packOwner: lifecycle.orgPack.pack.owner } : {}),
  };
}
