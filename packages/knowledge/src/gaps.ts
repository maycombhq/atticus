import {
  parseRecord,
  type CatalogRecord,
  type EvidenceT,
  type IntegrationPattern,
  type OrgPack,
  type RecordKind,
  type RecordOf,
} from "@maycombhq/core";
import { FEATURE_CHECKS } from "./feature-checks.js";
import { newestEvidence } from "./freshness.js";
import { daysBetween } from "./sources.js";

/**
 * Knowledge gaps: a check declares the facts it needs; when a needed fact is missing (or
 * older than the pack's freshness window) for a system, the gap becomes an OwnerQuestion to
 * the system's owner. Unanswered questions stay visible as unknowns: Atticus never fills a
 * gap with a guess, and an answer only counts once the fact is in the catalog.
 */

export type OwnerQuestionRecord = RecordOf<"OwnerQuestion">;

export interface Need {
  kind: RecordKind;
  /** A field of that kind, when the need is one field. */
  field?: string;
  what: string;
}

export interface KnowledgeGap {
  check: string;
  system: string;
  /** Catalog records the gap is about. */
  records: string[];
  owner: string;
  /** Set when nobody owns the system or the platform: the role that takes the question. */
  routeTo?: string;
  /** Ids of needed records that exist but are older than the freshness window. */
  stale?: string[];
  question: OwnerQuestionRecord;
}

export interface GapDraft {
  system: string;
  records: string[];
  question: string;
  neededFact: string;
  evidence: EvidenceT[];
  stale?: string[];
  /** Who takes the question when it isn't the system's owner (a feature's own owner). */
  owner?: string;
}

export interface CheckContext {
  records: CatalogRecord[];
  byId: Map<string, CatalogRecord>;
  patterns: IntegrationPattern[];
  systemOf(id: string): string | undefined;
  boundaryOf(system: string): string | undefined;
  ownerOf(system: string): string | undefined;
  /** Whether a record is older than the pack's freshness window for its kind. */
  isStale(r: CatalogRecord): boolean;
  lastSeen(r: CatalogRecord): string | undefined;
}

export interface KnowledgeCheck {
  id: string;
  description: string;
  needs: Need[];
  run(ctx: CheckContext): GapDraft[];
}

type Iface = RecordOf<"Interface">;
type Component = RecordOf<"Component">;
type Setting = RecordOf<"Setting">;

/** Patterns that govern an interface: its own code, else those whose detection fits it. */
function governingPatterns(i: Iface, ctx: CheckContext): IntegrationPattern[] {
  if (i.pattern) return ctx.patterns.filter((p) => p.code === i.pattern!.code);
  const target = ctx.systemOf(i.to);
  const boundary = target ? ctx.boundaryOf(target) : undefined;
  return ctx.patterns.filter(
    (p) =>
      p.detection.targetBoundary !== undefined &&
      p.detection.targetBoundary === boundary &&
      (p.detection.sync ?? p.interaction) === i.sync,
  );
}

const callResilience: KnowledgeCheck = {
  id: "call-resilience-known",
  description:
    "A synchronous call whose pattern lists timeout or retry controls needs the caller's timeout and retry settings for that callee.",
  needs: [
    {
      kind: "Setting",
      field: "settingKind",
      what: "timeout and retry settings on the caller, targeting the callee",
    },
  ],
  run(ctx) {
    const out: GapDraft[] = [];
    for (const i of ctx.records) {
      if (i.kind !== "Interface" || i.sync !== "sync" || i.status === "retired") continue;
      const patterns = governingPatterns(i, ctx);
      if (!patterns.length) continue;
      const text = patterns
        .flatMap((p) => p.controls)
        .join(", ")
        .toLowerCase();
      const kinds: ("timeout" | "retry")[] = [];
      if (/timeout/.test(text) || patterns.some((p) => p.resilience.timeoutMs !== undefined))
        kinds.push("timeout");
      if (/retr(y|ies)/.test(text) || patterns.some((p) => p.resilience.retries !== undefined))
        kinds.push("retry");
      if (!kinds.length) continue;
      const targets = new Set([i.to, ctx.systemOf(i.to)].filter(Boolean));
      const settings = ctx.records.filter(
        (r): r is Setting =>
          r.kind === "Setting" &&
          r.component === i.from &&
          r.target !== undefined &&
          targets.has(r.target),
      );
      const missing = kinds.filter((k) => !settings.some((s) => s.settingKind === k));
      const stale = settings.filter(
        (s) => kinds.includes(s.settingKind as "timeout") && ctx.isStale(s),
      );
      if (!missing.length && !stale.length) continue;
      const system = ctx.systemOf(i.from) ?? i.from;
      const codes = patterns.map((p) => p.code).join(", ");
      const controls = patterns.flatMap((p) => p.controls).join(", ");
      const parts: string[] = [];
      const facts: string[] = [];
      if (stale.length) {
        const seen = stale.map((s) => ctx.lastSeen(s)?.slice(0, 10)).filter(Boolean);
        parts.push(
          `Are these settings still right? ${stale.map((s) => s.id).join(", ")} ${stale.length === 1 ? "was" : "were"} last seen ${seen.join(", ")}.`,
        );
        facts.push(
          `Setting (${[...new Set(stale.map((s) => s.settingKind))].join(", ")}) on ${i.from} targeting ${i.to}, last seen ${seen.join(", ")}`,
        );
      }
      if (missing.length) {
        parts.push(
          `What ${missing.join(" and ")} settings does ${i.from} use when it calls ${i.to}? Pattern ${codes} needs them (${controls}).`,
        );
        facts.push(`Setting (${missing.join(", ")}) on ${i.from} targeting ${i.to}`);
      }
      out.push({
        system,
        records: [i.id],
        question: parts.join(" "),
        neededFact: facts.join("; "),
        evidence: i.evidence,
        ...(stale.length ? { stale: stale.map((s) => s.id) } : {}),
      });
    }
    return out;
  },
};

/**
 * Only unattended workloads: batch jobs and event consumers run with nobody waiting for an
 * answer, so a failure goes unseen without an alert. A service people call shows its failures
 * to its callers; a wider observability check can be added as a plugin when a team wants it.
 */
const unattendedMonitored: KnowledgeCheck = {
  id: "unattended-workload-monitored",
  description: "A batch job or event consumer needs an alert or a dashboard.",
  needs: [
    {
      kind: "ObservabilityAsset",
      field: "assetKind",
      what: "an alert or dashboard for the component",
    },
  ],
  run(ctx) {
    const out: GapDraft[] = [];
    for (const c of ctx.records) {
      if (c.kind !== "Component" || !c.repo || c.status === "retired") continue;
      const why: string[] = [];
      if (/batch|job|cron|schedul|worker/i.test(c.type)) why.push("a batch job");
      if (
        ctx.records.some(
          (r) =>
            r.kind === "Interface" && r.to === c.id && r.sync === "async" && r.status !== "retired",
        )
      )
        why.push("an event consumer");
      if (!why.length) continue;
      const assets = ctx.records.filter(
        (r) =>
          r.kind === "ObservabilityAsset" &&
          r.component === c.id &&
          (r.assetKind === "alert" || r.assetKind === "dashboard"),
      );
      const fresh = assets.filter((a) => !ctx.isStale(a));
      if (fresh.length) continue;
      const stale = assets.map((a) => a.id);
      out.push({
        system: c.system,
        records: [c.id],
        question: stale.length
          ? `Are the alerts for ${c.id} still in place? ${stale.join(", ")} ${stale.length === 1 ? "is" : "are"} older than the freshness window.`
          : `Which alert or dashboard watches ${c.id}? It runs without a caller waiting (${why.join(" and ")}), so a failure goes unnoticed without one.`,
        neededFact: `ObservabilityAsset (alert or dashboard) for ${c.id}`,
        evidence: c.evidence,
        ...(stale.length ? { stale } : {}),
      });
    }
    return out;
  },
};

const sourceKnown: KnowledgeCheck = {
  id: "component-source-known",
  description:
    "A component needs its repo, an owner and, when its code can't be read, an interface spec.",
  needs: [
    { kind: "Component", field: "repo", what: "the repo that holds the component's code" },
    { kind: "System", field: "owner", what: "the team that owns the system" },
    { kind: "Endpoint", what: "an interface spec, or endpoints read from code" },
  ],
  run(ctx) {
    const out: GapDraft[] = [];
    for (const c of ctx.records) {
      if (c.kind !== "Component" || c.status === "retired") continue;
      if (ctx.boundaryOf(c.system) === "vendor") continue;
      const owned = ctx.ownerOf(c.system) !== undefined;
      const hasEndpoints = ctx.records.some((r) => r.kind === "Endpoint" && r.component === c.id);
      const missing: string[] = [];
      if (!c.repo) missing.push("Component repo");
      if (!owned) missing.push("System owner");
      if (!c.repo && !hasEndpoints) missing.push("an interface spec");
      if (!missing.length) continue;
      const callers = [
        ...new Set(
          ctx.records
            .filter((r): r is Iface => r.kind === "Interface" && r.to === c.id)
            .map((r) => r.from),
        ),
      ].sort();
      const asks: string[] = [];
      if (!owned) asks.push(`Who owns ${c.id}`);
      if (!c.repo) asks.push(`which repo holds its code`);
      if (!c.repo && !hasEndpoints) asks.push("is there an interface spec");
      let q =
        asks.length > 1 ? `${asks.slice(0, -1).join(", ")}, and ${asks.at(-1)}?` : `${asks[0]}?`;
      if (asks[0]!.startsWith("which")) q = q[0]!.toUpperCase() + q.slice(1);
      if (!c.repo && callers.length) q += ` It is known only from calls by ${callers.join(", ")}.`;
      out.push({
        system: c.system,
        records: [c.id],
        question: q,
        neededFact: `${missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}` : missing[0]} for ${c.id}`,
        evidence: c.evidence,
      });
    }
    return out;
  },
};

/** The built-in checks, in the order their gaps are listed; feature checks (ADR 0031) last. */
export const KNOWLEDGE_CHECKS: KnowledgeCheck[] = [
  callResilience,
  unattendedMonitored,
  sourceKnown,
  ...FEATURE_CHECKS,
];

export interface KnowledgeGapsInput {
  records: CatalogRecord[];
  orgPack: OrgPack;
  /**
   * Records proposed from documents (document-only facts). They never close a gap: an owner
   * must confirm them first. Accepted so callers pass one shape to coverage and gaps.
   */
  documents?: CatalogRecord[];
  /** The clock (ISO date-time); without it nothing counts as stale. */
  now?: string;
  /** Extra checks (plugins) run after the built-in ones. */
  checks?: KnowledgeCheck[];
  /** Where questions go. Default: ado when the work tracker is Azure DevOps or a mock, else teams or email by the notifier. */
  channel?: OwnerQuestionRecord["channel"];
  /** Days a record stays fresh when the pack names no window for its kind. Default: none (never stale). */
  defaultDays?: number;
}

function defaultChannel(op: OrgPack): OwnerQuestionRecord["channel"] {
  const wt = op.runtime.adapters.workTracker?.type;
  const notify = op.runtime.adapters.notify?.type;
  if (wt === "azure-devops" || wt === "mock" || wt === undefined) {
    if (wt === undefined && notify === "teams") return "teams";
    if (wt === undefined && notify === "email") return "email";
    return "ado";
  }
  return notify === "email" ? "email" : "teams";
}

export function knowledgeGaps(input: KnowledgeGapsInput): KnowledgeGap[] {
  const { records, orgPack } = input;
  const byId = new Map(records.map((r) => [r.id, r]));
  const profileSystems = orgPack.profiles.flatMap((p) => p.profile?.systems ?? []);
  const systemRecords = new Map<string, RecordOf<"System">>();
  for (const r of records) if (r.kind === "System") systemRecords.set(r.id, r);
  const componentSystem = new Map<string, string>();
  for (const r of records)
    if (r.kind === "Component") componentSystem.set(r.id, (r as Component).system);
  const systemOf = (id: string) =>
    componentSystem.get(id) ??
    (systemRecords.has(id) || profileSystems.some((s) => s.id === id) ? id : undefined);
  const profileOwner = (s: string) => profileSystems.find((p) => p.id === s)?.owner;
  const ownerOf = (s: string) => profileOwner(s) ?? systemRecords.get(s)?.owner;
  const boundaryOf = (s: string) =>
    systemRecords.get(s)?.boundary ?? profileSystems.find((p) => p.id === s)?.boundary;
  const windows = orgPack.pack?.freshness ?? {};
  const lastSeen = (r: CatalogRecord) => newestEvidence(r);
  const isStale = (r: CatalogRecord) => {
    if (!input.now) return false;
    const days = windows[r.kind] ?? input.defaultDays;
    const seen = lastSeen(r);
    return days !== undefined && seen !== undefined && daysBetween(seen, input.now) > days;
  };
  const ctx: CheckContext = {
    records,
    byId,
    patterns: orgPack.patterns,
    systemOf,
    boundaryOf,
    ownerOf,
    isStale,
    lastSeen,
  };
  const existing = new Map<string, OwnerQuestionRecord>();
  for (const r of records) if (r.kind === "OwnerQuestion") existing.set(r.id, r);
  const channel = input.channel ?? defaultChannel(orgPack);

  const out: KnowledgeGap[] = [];
  for (const check of [...KNOWLEDGE_CHECKS, ...(input.checks ?? [])]) {
    for (const g of check.run(ctx)) {
      const owner = g.owner ?? ownerOf(g.system) ?? orgPack.pack?.owner ?? "unassigned";
      const routeTo = owner === "unassigned" ? "architect" : undefined;
      const id = `q.${check.id}.${g.records[0]}`.slice(0, 120);
      const prior = existing.get(id);
      const p = parseRecord({
        schemaVersion: 1,
        kind: "OwnerQuestion",
        id,
        status: "current",
        confidence: "inferred",
        system: g.system,
        owner,
        question: g.question,
        neededFact: g.neededFact,
        channel: prior?.channel ?? channel,
        questionState: prior?.questionState ?? "sent",
        ...(prior?.answer ? { answer: prior.answer } : {}),
        evidence: g.evidence,
        ...(routeTo ? { flags: [`route:${routeTo}`] } : {}),
      });
      if (!p.ok) throw new Error(`question ${id}: ${JSON.stringify(p.issues)}`);
      out.push({
        check: check.id,
        system: g.system,
        records: g.records,
        owner,
        ...(routeTo ? { routeTo } : {}),
        ...(g.stale ? { stale: g.stale } : {}),
        question: p.record as OwnerQuestionRecord,
      });
    }
  }
  return out;
}
