import {
  changeFolder,
  changeFootprint,
  changeStore,
  changeTypeOf,
  loadChangeContext,
  scoreRisk,
  testsFor,
  type ChangeContext,
  type Footprint,
  type Risk,
  type TestPlan,
} from "@maycombhq/changes";
import type {
  BuildEngine,
  CatalogRecord,
  ChangeLifecycle,
  ChangeType,
  IntegrationPattern,
  RecordOf,
} from "@maycombhq/core";
import {
  docOf,
  filesOf,
  hopNotes,
  readChangeFiles,
  readDataChanges,
  readHops,
  sectionLines,
  type ChangeFiles,
  type DataChange,
  type Doc,
  type Hop,
} from "@maycombhq/naysayer";
import { PlannerError } from "./errors.js";

/**
 * Everything planning reads, loaded once: the change and its artifacts (via the critic's
 * readers, so the planner and the critic read interfaces.md, data.md and the specs the same
 * way), the catalog and org pack, the footprint, the risk and the test plan. Files only.
 */

export interface SpecScenario {
  name: string;
  line: number;
  when: string[];
  then: string[];
}

export interface SpecRequirement {
  /** Change-folder-relative path of the spec file. */
  file: string;
  name: string;
  line: number;
  /** The requirement's statement and its scenarios, as plain text. */
  text: string;
  scenarios: SpecScenario[];
}

export interface OpenQuestion {
  text: string;
  owner?: string;
  file: string;
  line: number;
}

export interface PlanContext {
  root: string;
  dir: string;
  lifecycle: ChangeContext;
  change: ChangeLifecycle;
  type: ChangeType;
  files: ChangeFiles;
  footprint: Footprint;
  risk: Risk;
  tests: TestPlan;
  hops: Hop[];
  data: DataChange[];
  requirements: SpecRequirement[];
  questions: OpenQuestion[];
  /** Bullets of the proposal's "What Changes" section, with their lines. */
  changes: { line: number; text: string }[];
  records: CatalogRecord[];
  patterns: Map<string, IntegrationPattern>;
  get<K extends CatalogRecord["kind"]>(kind: K, id: string): RecordOf<K> | undefined;
  /** The system a component, system or data store belongs to. */
  systemOf(id: string): string | undefined;
  boundaryOf(system: string): string | undefined;
  systemName(system: string): string;
  /** A caller or callee the catalog (or the profile) knows. */
  isKnown(id: string): boolean;
  /** The repo a component is built in (catalog, else the repos manifest). */
  repoOf(component: string): string | undefined;
  componentOfRepo(repo: string): string | undefined;
  knownRepos: Set<string>;
  engineOf(repo: string): BuildEngine;
  notes(hop: Hop): { n: number; text: string }[];
  /** Text of the mappings.md section for a hop ("" when there is none). */
  mapping(hop: Hop): string;
}

const BULLET = /^\s*[-*]\s+(.*)$/;
const strip = (s: string) => s.replace(/\*\*/g, "").replace(/`/g, "").trim();

function readRequirements(files: ChangeFiles): SpecRequirement[] {
  const out: SpecRequirement[] = [];
  for (const doc of filesOf(files, "specs")) {
    for (const req of doc.sections.filter((s) => /^requirement:/i.test(s.heading))) {
      const scenarios: SpecScenario[] = [];
      for (const sc of doc.sections.filter(
        (s) => /^scenario:/i.test(s.heading) && s.line > req.line && s.line <= req.end,
      )) {
        const when: string[] = [];
        const then: string[] = [];
        let into: string[] | undefined;
        for (const l of sectionLines(doc, sc)) {
          const b = BULLET.exec(l.text);
          const t = strip(b ? b[1]! : l.text);
          const m = /^(WHEN|GIVEN|THEN|AND)\b\s*(.*)$/i.exec(t);
          if (m) {
            const k = m[1]!.toUpperCase();
            if (k === "WHEN" || k === "GIVEN") into = when;
            else if (k === "THEN") into = then;
            into?.push(m[2]!.trim());
          } else into?.push(t);
        }
        scenarios.push({
          name: sc.heading.replace(/^scenario:\s*/i, "").trim(),
          line: sc.line,
          when,
          then,
        });
      }
      const text = doc.lines
        .slice(req.line - 1, req.end)
        .map((l) => strip(l.replace(/^#+\s*/, "")))
        .filter(Boolean)
        .join("\n");
      out.push({
        file: doc.path,
        name: req.heading.replace(/^requirement:\s*/i, "").trim(),
        line: req.line,
        text,
        scenarios,
      });
    }
  }
  return out;
}

/** "What is X? (product owner)" or "X — product owner" → text and owner. */
function question(raw: string): { text: string; owner?: string } {
  const t = strip(raw);
  const paren = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(t);
  if (paren) return { text: paren[1]!.trim(), owner: paren[2]!.trim() };
  const dash = /^(.*?)\s+[—–-]\s+([^—–-]+)$/.exec(t);
  if (dash) return { text: dash[1]!.trim(), owner: dash[2]!.trim() };
  return { text: t };
}

function bulletsUnder(doc: Doc | undefined, heading: RegExp): { line: number; text: string }[] {
  const s = doc?.sections.find((x) => heading.test(x.heading));
  if (!doc || !s) return [];
  return sectionLines(doc, s)
    .map((l) => ({ line: l.n, m: BULLET.exec(l.text) }))
    .filter((x): x is { line: number; m: RegExpExecArray } => !!x.m)
    .map((x) => ({ line: x.line, text: strip(x.m[1]!) }));
}

const STATES_WITH_APPROVED_DESIGN = new Set(["plan", "build", "qa", "release-ready"]);

export async function loadPlanContext(
  root: string,
  changeId: string,
  o: { requireApprovedDesign?: boolean } = {},
): Promise<PlanContext> {
  const lifecycle = await loadChangeContext(root);
  const change = await changeStore(root)
    .read(changeId)
    .catch((e: Error) => {
      throw new PlannerError("not-found", e.message);
    });
  if (o.requireApprovedDesign !== false && !STATES_WITH_APPROVED_DESIGN.has(change.state))
    throw new PlannerError(
      "refused",
      `${change.id} is ${change.state}; plan from an approved design (the change must be in plan).`,
    );
  const type = changeTypeOf(lifecycle, change.type);
  const dir = changeFolder(root, change.id);
  const files = await readChangeFiles(dir);
  const footprint = await changeFootprint(lifecycle, change);
  const risk = scoreRisk({ type: change.type, footprint }, lifecycle.policy);
  const tests = testsFor(lifecycle.orgPack.testStrategy, change.type, risk.level);
  const records = lifecycle.records;
  const byId = new Map(records.map((r) => [r.id, r]));
  const get = <K extends CatalogRecord["kind"]>(kind: K, id: string) => {
    const r = byId.get(id);
    return r?.kind === kind ? (r as RecordOf<K>) : undefined;
  };
  const profileSystems = new Map(
    lifecycle.orgPack.profiles.flatMap((p) => p.profile?.systems ?? []).map((s) => [s.id, s]),
  );
  const manifestRepos = lifecycle.orgPack.profiles.flatMap((p) => p.repos?.repos ?? []);
  const endpointOwners = new Set(
    records.filter((r) => r.kind === "Endpoint").map((r) => (r as RecordOf<"Endpoint">).component),
  );
  const systemOf = (id: string): string | undefined => {
    const c = get("Component", id);
    if (c) return c.system;
    if (get("System", id) || profileSystems.has(id)) return id;
    const s = get("DataStore", id);
    if (s?.ownerComponent) return systemOf(s.ownerComponent);
    const t = get("Table", id);
    if (t?.dataStore) return systemOf(t.dataStore);
    return undefined;
  };
  const repoOf = (component: string) =>
    get("Component", component)?.repo ?? manifestRepos.find((r) => r.component === component)?.id;
  const runtime = lifecycle.orgPack.runtime;
  const intro = docOf(files, "proposal.md");
  const questions: OpenQuestion[] = [];
  for (const [file, doc] of [
    ["brief.md", docOf(files, "brief.md")],
    ["proposal.md", intro],
  ] as const)
    for (const b of bulletsUnder(doc, /^open questions$/i))
      questions.push({ ...question(b.text), file, line: b.line });
  const mappings = docOf(files, "mappings.md");
  return {
    root,
    dir,
    lifecycle,
    change,
    type,
    files,
    footprint,
    risk,
    tests,
    hops: readHops(files),
    data: readDataChanges(files),
    requirements: readRequirements(files),
    questions,
    changes: bulletsUnder(intro, /^what changes$/i),
    records,
    patterns: new Map(lifecycle.orgPack.patterns.map((p) => [p.code, p])),
    get,
    systemOf,
    boundaryOf: (s) => get("System", s)?.boundary ?? profileSystems.get(s)?.boundary,
    systemName: (s) => get("System", s)?.name ?? profileSystems.get(s)?.name ?? s,
    isKnown: (id) =>
      get("Component", id) !== undefined ||
      get("System", id) !== undefined ||
      profileSystems.has(id) ||
      endpointOwners.has(id),
    repoOf,
    componentOfRepo: (repo) =>
      records.find((r) => r.kind === "Component" && (r as RecordOf<"Component">).repo === repo)
        ?.id ?? manifestRepos.find((r) => r.id === repo)?.component,
    knownRepos: new Set([
      ...manifestRepos.map((r) => r.id),
      ...records
        .filter((r) => r.kind === "Component")
        .map((r) => (r as RecordOf<"Component">).repo)
        .filter((x): x is string => !!x),
    ]),
    engineOf: (repo) =>
      runtime.buildEngine?.perRepo[repo] ?? runtime.buildEngine?.default ?? "speckit",
    notes: (hop) => hopNotes(files, hop),
    mapping: (hop) => {
      if (!mappings) return "";
      const needles = [hop.operation.toLowerCase(), hop.path?.toLowerCase()].filter(
        (x): x is string => !!x,
      );
      const s = mappings.sections.find(
        (x) => x.level >= 2 && needles.some((n) => x.heading.toLowerCase().includes(n)),
      );
      return s ? mappings.lines.slice(s.line, s.end).join("\n") : "";
    },
  };
}
