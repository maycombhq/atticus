import {
  normalizePath,
  parseRecord,
  projectFacts,
  questionId,
  slugify,
  type CatalogRecord,
  type CuratedProblem,
  type Fact,
  type FactOf,
  type FlowRecord,
  type OrgPack,
  type Question,
  type QuestionDraft,
  type RecordIssue,
  applyCurated,
} from "@maycombhq/core";
import { estateRepos, mergeEstate } from "./merge-input.js";

/**
 * A repo's verified facts written into the catalog (ADR 0124, A3b). The facts are projected into
 * C1 (`projectFacts`); the records a reader or an earlier write made from the repo are replaced
 * by them; every other repo's records stay; and the catalog is built with the same passes a scan
 * runs: the estate's merge (endpoint identity, hosts, systems, loose ends) and the person's
 * curated decisions replayed over the result. Flows come back apart from the catalog: they live
 * in `specs/<repo>/` (ADR 0079). Pure and deterministic: the same facts, catalog, org pack,
 * decisions and answers give the same records.
 */

/** The step that asks which repo or system answers a call with no target and no host. */
export const TARGETS_STEP = "facts-targets";

/** The last option of a targets question: nothing in the estate answers the call. */
export const TARGETS_NONE = "None of these";

export interface FactsCatalogInput {
  repo: string;
  /** The facts the verifier kept. */
  facts: readonly Fact[];
  /** catalog/generated as it is now. */
  existing: readonly CatalogRecord[];
  op: OrgPack;
  /** The curated decisions (catalog/curated). */
  decisions: readonly CatalogRecord[];
  /** A target a person named for a call fact that had none, by fact id (`targetsFromAnswers`). */
  targets?: Readonly<Record<string, string>>;
}

/** A call of the repo that is still a loose end after the merge. */
export interface LooseCall {
  factId: string;
  /** Its catalog id (an Unresolved record). */
  id: string;
  unresolvedKind: string;
  raw: string;
}

export interface FactsCatalogResult {
  /** The whole catalog to write to catalog/generated, sorted by kind and id. No Flow is in it. */
  records: CatalogRecord[];
  /** The repo's flows, with the catalog's final ids, for specs/<repo>/. */
  flows: FlowRecord[];
  /** The calls still loose: a host no repo lists (asked by the hosts question), or no target at all. */
  unresolved: LooseCall[];
  /** Curated decisions applied; the problems are those about this repo's records, old or new. */
  curated: { applied: string[]; suppressed: string[]; problems: CuratedProblem[] };
  /** What the projection said about the facts (dangling references, unresolved targets). */
  projectionIssues: { factId?: string; code: string; message: string }[];
  /** Records the merge made that fail C1 (a bug if ever non-empty). */
  invalid: { record: unknown; issues: RecordIssue[] }[];
  notes: string[];
}

type Rec = CatalogRecord & Record<string, unknown>;
type Ev = { repo?: string; path?: string; line?: number; side?: string; source: string };

const byKindId = (a: CatalogRecord, b: CatalogRecord) =>
  a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind);

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const joinUrl = (base: string, path: string) =>
  `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;

/** The URL a call fact goes to, when its host or its base (a config fact's URL) says so. */
function urlOf(f: FactOf<"call">, facts: readonly Fact[]): string | undefined {
  if (f.host) return joinUrl(URL_RE.test(f.host) ? f.host : `http://${f.host}`, f.path);
  if (f.base) {
    const cfg = facts.find(
      (x): x is FactOf<"config"> => x.kind === "config" && x.key === f.base && !!x.value,
    );
    if (cfg?.value && URL_RE.test(cfg.value)) return joinUrl(cfg.value, f.path);
  }
  return undefined;
}

const HTTP_CALLS = new Set(["rest", "soap"]);
const EVENT_CALLS = new Set(["event-topic", "mq-queue"]);

/** Whether a call with no target is one to ask a person about: no host, no URL, not an event. */
function needsTarget(f: Fact, facts: readonly Fact[]): f is FactOf<"call"> {
  return (
    f.kind === "call" &&
    !f.to &&
    !EVENT_CALLS.has(f.callType) &&
    !(HTTP_CALLS.has(f.callType) && urlOf(f, facts))
  );
}

/** The question for a call with no target and no host: its words and the line it cites. */
export function targetQuestionFor(f: Fact): { question: string; evidence: string[] } | undefined {
  if (f.kind !== "call") return undefined;
  const what = [f.method?.toUpperCase(), f.path].filter(Boolean).join(" ");
  const component = slugify(f.component ?? f.repo).replace(/\./g, "-");
  return {
    question: `Which repo or system answers ${what}, which ${component} calls${f.base ? ` through ${f.base}` : ""}?`,
    evidence: [`${f.cite.file}:${f.cite.line}`],
  };
}

/** Endpoint types a call of each type reaches. */
const SERVES: Record<string, string[]> = {
  rest: ["rest"],
  soap: ["soap"],
  graphql: ["graphql"],
  grpc: ["grpc"],
  webhook: ["webhook"],
  sftp: ["file-drop"],
};

/**
 * One question (ADR 0078) per call that has no target and no host: which repo or system answers
 * it. The options are the components of other repos that serve that kind of call, then the
 * vendor systems of the profiles, then "None of these".
 */
export function targetQuestionDrafts(
  facts: readonly Fact[],
  records: readonly CatalogRecord[],
  op: OrgPack,
): { factId: string; id: string; repo: string; draft: QuestionDraft }[] {
  const repoOf = new Map<string, string>();
  for (const r of records) if (r.kind === "Component" && r.repo) repoOf.set(r.id, r.repo);
  const vendors = op.profiles
    .flatMap((p) => p.profile?.systems ?? [])
    .filter((s) => s.boundary === "vendor")
    .sort((a, b) => a.id.localeCompare(b.id));
  const out: { factId: string; id: string; repo: string; draft: QuestionDraft }[] = [];
  for (const f of [...facts].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!needsTarget(f, facts)) continue;
    const q = targetQuestionFor(f)!;
    const own = slugify(f.component ?? f.repo).replace(/\./g, "-");
    const types = new Set(SERVES[f.callType] ?? []);
    const servers = [
      ...new Set(
        records
          .filter(
            (r): r is Extract<CatalogRecord, { kind: "Endpoint" }> =>
              r.kind === "Endpoint" && types.has(r.endpointType) && r.component !== own,
          )
          .filter((r) => repoOf.get(r.component) !== f.repo)
          .map((r) => r.component),
      ),
    ].sort();
    const what = [f.method?.toUpperCase(), f.path].filter(Boolean).join(" ");
    const draft: QuestionDraft = {
      question: q.question,
      options: [
        ...servers.map((c) => ({
          label: c,
          means: `${c}${repoOf.get(c) ? `, built in ${repoOf.get(c)},` : ""} answers ${what}`,
          changes: `The call joins ${c} when the facts are next written (atticus verify ${f.repo} --write)`,
        })),
        ...vendors.map((s) => ({
          label: s.id,
          means: `${s.name}, an outside system, answers ${what}`,
          changes: `The call goes to ${s.name} when the facts are next written`,
        })),
        {
          label: TARGETS_NONE,
          means: "Nothing in the estate or the org pack's systems answers it",
          changes: "The call stays a loose end, and this isn't asked again",
        },
      ],
      evidence: q.evidence,
      scope: "repo",
    };
    out.push({
      factId: f.id,
      id: questionId({
        step: TARGETS_STEP,
        repo: f.repo,
        question: q.question,
        evidence: q.evidence,
      }),
      repo: f.repo,
      draft,
    });
  }
  return out;
}

/**
 * The targets people named for calls (the answers to targets questions), by call fact id. An
 * option is its label; words of the person's own are read as the target's name; "None of these"
 * names nothing. Only answered questions count.
 */
export function targetsFromAnswers(
  repo: string,
  facts: readonly Fact[],
  questions: readonly Question[],
): Record<string, string> {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const out: Record<string, string> = {};
  for (const f of [...facts].sort((a, b) => a.id.localeCompare(b.id))) {
    if (f.kind !== "call" || f.to) continue;
    const q = targetQuestionFor(f);
    if (!q) continue;
    const asked = byId.get(questionId({ step: TARGETS_STEP, repo, ...q }));
    if (!asked || asked.state !== "answered" || !asked.answer) continue;
    const label =
      asked.answer.option !== undefined
        ? asked.options[asked.answer.option - 1]?.label
        : asked.answer.text;
    if (!label || label === TARGETS_NONE) continue;
    const to = slugify(label);
    if (to) out[f.id] = to;
  }
  return out;
}

export function catalogWithFacts(input: FactsCatalogInput): FactsCatalogResult {
  const { repo, op } = input;
  const manifest = estateRepos(op).find((r) => r.id === repo);
  // A fact with no component belongs to the component the manifest names for the repo.
  const facts = input.facts.map((f): Fact => {
    let g: Fact = f;
    if (!g.component && manifest?.component) g = { ...g, component: manifest.component };
    const to = input.targets?.[g.id];
    if (g.kind === "call" && !g.to && to) g = { ...g, to };
    return g;
  });
  const projected = projectFacts(facts, manifest?.system ? { system: manifest.system } : {});
  const factById = new Map(facts.map((f) => [f.id, f]));

  // ---- loose ends a scan's merge can join: a call to a URL, a publish, a listener
  const loose = new Map<string, Rec>(); // unresolved id -> replacement
  const looseFact = new Map<string, string>(); // unresolved id -> fact id
  const extra: Rec[] = [];
  for (const [factId, id] of Object.entries(projected.ids)) {
    const f = factById.get(factId)!;
    const rec = projected.records.find((r) => r.id === id && r.kind === "Unresolved") as
      Rec | undefined;
    if (f.kind === "call" && rec) {
      looseFact.set(id, factId);
      const url = HTTP_CALLS.has(f.callType) ? urlOf(f, facts) : undefined;
      if (url)
        loose.set(id, {
          ...rec,
          unresolvedKind: "http-call",
          raw: `${f.method?.toUpperCase() ?? "ANY"} ${url}`,
        });
      else if (EVENT_CALLS.has(f.callType))
        loose.set(id, { ...rec, unresolvedKind: "event-publish", raw: f.path });
    }
    if (f.kind === "entry" && EVENT_CALLS.has(f.entryType)) {
      const ep = projected.records.find((r) => r.id === id && r.kind === "Endpoint") as Rec;
      extra.push({
        kind: "Unresolved",
        schemaVersion: 2,
        id: `unresolved.${id}`,
        status: "current",
        confidence: ep.confidence,
        unresolvedKind: "event-subscribe",
        raw: f.path,
        owner: (ep as { component: string }).component,
        evidence: ep.evidence.map((e) => ({ ...e, side: "callee" })),
      } as unknown as Rec);
    }
  }
  const newRecords = [
    ...projected.records
      .filter((r) => r.kind !== "Flow")
      .map((r) => (loose.get(r.id) ?? r) as CatalogRecord),
    ...(extra as CatalogRecord[]),
  ];
  const newFlows = projected.records.filter((r): r is FlowRecord => r.kind === "Flow");

  // ---- the existing catalog without what came from this repo
  const mine = (e: unknown) => (e as Ev).repo === repo;
  const oldComponents = new Set(
    input.existing
      .filter((r) => r.kind === "Component" && (r as { repo?: string }).repo === repo)
      .map((r) => r.id),
  );
  const dropped = new Set<string>(); // kind|id
  const kept: CatalogRecord[] = [];
  const mixed: CatalogRecord[] = [];
  for (const r of input.existing) {
    if (r.kind === "Flow" || r.kind === "CuratedDecision") continue;
    const ev = r.evidence as unknown[];
    const m = ev.filter(mine).length;
    if (m === 0) kept.push(r);
    else if (m === ev.length) dropped.add(`${r.kind}|${r.id}`);
    else mixed.push(r);
  }
  const droppedEndpoint = (id: unknown) => typeof id === "string" && dropped.has(`Endpoint|${id}`);
  for (const r of mixed) {
    const ev = r.evidence as unknown[];
    const out: Rec = { ...(r as Rec), evidence: ev.filter((e) => !mine(e)) } as Rec;
    if (r.kind === "Interface") {
      if (droppedEndpoint(out.endpoint)) delete out.endpoint;
      if (out.confidence === "verified" && ev.some((e) => mine(e) && (e as Ev).side === "callee"))
        out.confidence = "inferred";
    }
    if (r.kind === "Table") {
      out.readers = (out.readers as string[]).filter((c) => !oldComponents.has(c));
      out.writers = (out.writers as string[]).filter((c) => !oldComponents.has(c));
    }
    kept.push(out);
  }

  // ---- the scan's passes: merge (identity, hosts, systems, loose ends), then curated decisions
  const merged = mergeEstate(op, estateRepos(op), [...kept, ...newRecords].sort(byKindId));

  // Endpoint ids the merge gave (canonical: <component>.<method>-<resource>), and the
  // interfaces loose calls became, so schemas and flows name the catalog's ids.
  const remap = new Map<string, string>();
  const endpoints = merged.records.filter(
    (r): r is Extract<CatalogRecord, { kind: "Endpoint" }> => r.kind === "Endpoint",
  );
  for (const r of projected.records) {
    if (r.kind !== "Endpoint") continue;
    const hit =
      r.endpointType === "rest"
        ? endpoints.find(
            (e) =>
              e.endpointType === "rest" &&
              e.component === r.component &&
              (e.method ?? "") === (r.method ?? "") &&
              e.normalizedPath === normalizePath(r.normalizedPath ?? r.pathOrTopic),
          )
        : (endpoints.find((e) => e.id === r.id) ??
          endpoints.find(
            (e) => e.endpointType === r.endpointType && e.pathOrTopic === r.pathOrTopic,
          ));
    if (hit && hit.id !== r.id) remap.set(r.id, hit.id);
  }
  const stillLoose = new Set(
    merged.records.filter((r) => r.kind === "Unresolved").map((r) => r.id),
  );
  const joinedTo = new Map<string, string>(); // unresolved id -> the component it joined
  for (const [id] of looseFact) {
    if (stillLoose.has(id)) continue;
    const rec = newRecords.find((r) => r.id === id)!;
    const at = (rec.evidence as Ev[])[0];
    const iface = merged.records.find(
      (r) =>
        r.kind === "Interface" &&
        r.from === (rec as { owner?: string }).owner &&
        (r.evidence as Ev[]).some(
          (e) => e.repo === repo && e.path === at?.path && e.line === at?.line,
        ),
    ) as Extract<CatalogRecord, { kind: "Interface" }> | undefined;
    if (iface) {
      remap.set(id, iface.id);
      joinedTo.set(id, iface.to);
    }
  }
  const re = (id: string): string => {
    const exact = remap.get(id);
    if (exact) return exact;
    for (const [from, to] of remap)
      if (id.startsWith(`${from}.`)) return to + id.slice(from.length);
    return id;
  };
  const records = merged.records.map((r): CatalogRecord => {
    if (r.kind === "Schema") return { ...r, id: re(r.id), ref: re(r.ref) };
    if (r.kind === "Endpoint" && r.schemaRefs.length)
      return { ...r, schemaRefs: r.schemaRefs.map(re).sort() };
    return r;
  });
  const applied = applyCurated([...records].sort(byKindId), input.decisions);

  const newIds = new Set(
    applied.records.filter((r) => (r.evidence as unknown[]).some(mine)).map((r) => r.id),
  );
  const oldIds = new Set([...dropped].map((k) => k.slice(k.indexOf("|") + 1)));
  const flows = newFlows.map((f): FlowRecord => {
    const next = {
      ...f,
      trigger: { ...f.trigger, ...(f.trigger.ref ? { ref: re(f.trigger.ref) } : {}) },
      steps: f.steps.map((s) => {
        const was = s.to?.component;
        const to =
          s.to && was && joinedTo.has(was) ? { ...s.to, component: joinedTo.get(was)! } : s.to;
        return { ...s, refs: s.refs.map(re), ...(to ? { to } : {}) };
      }),
    };
    const p = parseRecord(next);
    return (p.ok ? p.record : next) as FlowRecord;
  });

  const unresolved: LooseCall[] = [];
  for (const r of applied.records) {
    if (r.kind !== "Unresolved" || !looseFact.has(r.id)) continue;
    unresolved.push({
      factId: looseFact.get(r.id)!,
      id: r.id,
      unresolvedKind: r.unresolvedKind,
      raw: r.raw,
    });
  }
  unresolved.sort((a, b) => a.factId.localeCompare(b.factId));

  return {
    records: applied.records.sort(byKindId),
    flows: flows.sort((a, b) => a.id.localeCompare(b.id)),
    unresolved,
    curated: {
      applied: applied.applied,
      suppressed: applied.suppressed,
      problems: applied.problems.filter((p) => newIds.has(p.target) || oldIds.has(p.target)),
    },
    projectionIssues: projected.issues.filter((i) => i.code !== "unresolved-target"),
    invalid: merged.invalid,
    notes: merged.notes,
  };
}
