import {
  callTargetQuestion,
  factIdPart,
  joinFacts,
  joinRecords,
  normalizePath,
  parseRecord,
  projectFacts,
  questionId,
  slugify,
  type CatalogRecord,
  type CuratedProblem,
  type Fact,
  type FactOf,
  type FactJoin,
  type FactJoinAsk,
  type FactsJoinResult,
  type FlowRecord,
  type JoinRepo,
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
  /**
   * The other repos' verified facts (their facts/<repo>.jsonl), for the estate join (ADR 0124
   * addendum C-join): this repo's calls join the entries of the repo that serves them, and the
   * other repos' calls into this repo are joined again. Left out, calls join only as the merge
   * joins loose ends (by host).
   */
  estate?: readonly { repo: string; facts: readonly Fact[] }[];
  /** The targets people named for the other repos' calls, by repo and call fact id. */
  estateTargets?: Readonly<Record<string, Readonly<Record<string, string>>>>;
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
  /**
   * With the estate: the joins of this repo's calls and of other repos' calls into it, with
   * their field lineage, and what is asked about this repo's calls (ADR 0124 addendum C-join).
   */
  join?: FactsJoinResult;
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
  return {
    question: callTargetQuestion(f, factIdPart(f.component ?? f.repo)),
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
  /** The estate join's questions: a call two or more entries could answer offers only those. */
  asks?: readonly FactJoinAsk[],
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
    const ask = asks?.find(
      (a) => a.reason === "ambiguous" && a.call.repo === f.repo && a.call.fact === f.id,
    );
    const servers = ask
      ? [...new Set(ask.candidates.map((c) => c.component))].sort()
      : [
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

/**
 * A repo's facts as the records a scan merges (ADR 0124): projected, with a person's named targets
 * applied, the manifest's component and system, and the loose ends a scan's merge can join (a
 * call to a URL, a publish, a listener). Flows apart, for specs/<repo>/. Used by `verify --write`
 * and by a scan, which takes a repo's facts over its readers' records.
 */
export function factsRecords(input: {
  repo: string;
  facts: readonly Fact[];
  op: OrgPack;
  targets?: Readonly<Record<string, string>>;
}) {
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
  return { facts, projected, factById, newRecords, newFlows, loose, looseFact };
}

/** The estate's repos as the join reads them (ADR 0124, C-join): the manifest's component, hosts and modules. */
export function joinReposOf(
  op: OrgPack,
  list: readonly { repo: string; facts: readonly Fact[] }[],
): JoinRepo[] {
  const manifests = estateRepos(op);
  return list.map(({ repo, facts }) => {
    const m = manifests.find((r) => r.id === repo);
    const modules = (m?.modules ?? []).filter((x) => x.hosts.length > 0);
    return {
      repo,
      facts,
      ...(m?.component ? { component: m.component } : {}),
      ...(m?.hosts.length ? { hosts: m.hosts } : {}),
      ...(modules.length
        ? { modules: modules.map((x) => ({ component: x.component, hosts: x.hosts })) }
        : {}),
    };
  });
}

/**
 * Records with the joins put in (ADR 0124, C-join): what a joined call made before (an
 * Unresolved loose end, or an Interface to the name the call gave) and the old field mappings
 * of the joined Interfaces go, and the joins' Interfaces and FieldMappings take their place,
 * a publish's to each listener of its topic among them.
 */
export function applyFactJoins(
  records: readonly CatalogRecord[],
  join: FactsJoinResult,
  repos: readonly JoinRepo[],
): CatalogRecord[] {
  /** A joined call, by its repo, cited line and component: the first Interface it joined. */
  const calls = new Map<string, string>();
  for (const j of join.joins) {
    const k = `${j.call.repo}|${j.call.at}|${j.call.component}`;
    if (!calls.has(k)) calls.set(k, j.interface);
  }
  const ifaces = new Set(join.joins.map((j) => j.interface));
  /** The Interface a record a joined call made stands for now, if it is one. */
  const madeByCall = (r: CatalogRecord): string | undefined => {
    if (r.kind === "Interface" && ifaces.has(r.id)) return r.id;
    if (r.kind !== "Interface" && r.kind !== "Unresolved") return undefined;
    const owner = r.kind === "Interface" ? r.from : r.owner;
    for (const e of r.evidence as Ev[]) {
      if (e.side === "callee") continue;
      const to = calls.get(`${e.repo}|${e.path}:${e.line}|${owner}`);
      if (to) return to;
    }
    return undefined;
  };
  const was = new Map<string, string>();
  const kept: CatalogRecord[] = [];
  for (const r of records) {
    const to = madeByCall(r);
    if (to) {
      if (to !== r.id) was.set(r.id, to);
    } else if (!(r.kind === "FieldMapping" && ifaces.has(r.interface))) kept.push(r);
  }
  // The call's request and response schemas (`<call>.<side>`) and mappings follow its Interface.
  const re = (id: string) => {
    for (const [from, to] of was)
      if (id === from || id.startsWith(`${from}.`)) return to + id.slice(from.length);
    return id;
  };
  return [
    ...kept.map((r): CatalogRecord => {
      if (r.kind === "Schema" && re(r.ref) !== r.ref) return { ...r, id: re(r.id), ref: re(r.ref) };
      if (r.kind === "FieldMapping" && re(r.interface) !== r.interface)
        return { ...r, id: re(r.id), interface: re(r.interface) };
      return r;
    }),
    ...joinRecords(join, repos),
  ];
}

/** "METHOD /path" of the entry a join reaches, or its gRPC or SOAP name or topic. */
const entryText = (j: FactJoin) => (j.method ? `${j.method} ${j.path}` : j.path);

/** The part of an estate join about one repo: its calls, and the other repos' calls into it. */
function joinAbout(all: FactsJoinResult, repo: string): FactsJoinResult {
  const joins = all.joins.filter((j) => j.call.repo === repo || j.entry.repo === repo);
  const ifaces = new Set(joins.map((j) => j.interface));
  return {
    joins,
    asks: all.asks.filter((a) => a.call.repo === repo),
    misses: all.misses.filter((m) => m.call.repo === repo),
    lineage: all.lineage.filter((l) => ifaces.has(l.interface)),
    gaps: all.gaps.filter((g) => ifaces.has(g.interface)),
  };
}

export function catalogWithFacts(input: FactsCatalogInput): FactsCatalogResult {
  const { repo, op } = input;
  const { facts, projected, newRecords, newFlows, looseFact } = factsRecords(input);

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

  // A component the merge made up for a call into this repo before the repo was read (inferred,
  // no repo, cited only by its callers) gives way to the component the facts now project.
  const projectedComponents = new Set(
    newRecords.filter((r) => r.kind === "Component").map((r) => r.id),
  );
  // The profile's systems are rebuilt by the merge from their components on every write, so
  // their evidence doesn't keep what an earlier write's components said.
  const profileSystems = new Set(
    op.profiles.flatMap((p) => p.profile?.systems ?? []).map((x) => x.id),
  );
  for (let i = kept.length - 1; i >= 0; i--) {
    const r = kept[i]!;
    if (
      (r.kind === "Component" &&
        projectedComponents.has(r.id) &&
        r.confidence === "inferred" &&
        !r.repo) ||
      (input.estate && r.kind === "System" && profileSystems.has(r.id))
    )
      kept.splice(i, 1);
  }

  // ---- the estate join (ADR 0124, C-join): this repo's calls to the entries that serve them,
  //      and the other repos' calls into this repo, joined again
  const remap = new Map<string, string>();
  /** A joined call's projected record id → the callee and the entry a call-out step reaches. */
  const stepTo = new Map<string, { component: string; entry: string }>();
  let join: FactsJoinResult | undefined;
  let records0 = [...kept, ...newRecords];
  if (input.estate) {
    const repos = joinReposOf(op, [
      { repo, facts },
      ...input.estate.filter((x) => x.repo !== repo),
    ]);
    join = joinAbout(
      joinFacts({ repos, targets: { ...input.estateTargets, [repo]: input.targets ?? {} } }),
      repo,
    );
    records0 = applyFactJoins(records0, join, repos);
    // A publish names its first listener's Interface (sorted), whether or not the listener's
    // repo is written yet, so its schema's id doesn't depend on which repo was written first.
    for (const j of join.joins) {
      const id = j.call.repo === repo ? projected.ids[j.call.fact] : undefined;
      if (!id || remap.has(id)) continue;
      remap.set(id, j.interface);
      stepTo.set(id, { component: j.entry.component, entry: entryText(j) });
    }
  }

  // ---- the scan's passes: merge (identity, hosts, systems, loose ends), then curated decisions
  const merged0 = mergeEstate(op, estateRepos(op), records0.sort(byKindId));
  // A listener the joins pair with a publish needs no loose end of its own.
  const heard = new Set(
    (join?.joins ?? [])
      .filter((j) => j.how === "topic")
      .map((j) => `${j.entry.repo}|${j.entry.at}|${j.entry.component}`),
  );
  const merged = {
    ...merged0,
    records: merged0.records.filter(
      (r) =>
        !(
          r.kind === "Unresolved" &&
          r.unresolvedKind === "event-subscribe" &&
          (r.evidence as Ev[]).some((e) => heard.has(`${e.repo}|${e.path}:${e.line}|${r.owner}`))
        ),
    ),
  };

  // Endpoint ids the merge gave (canonical: <component>.<method>-<resource>), and the
  // interfaces loose calls became, so schemas and flows name the catalog's ids.
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
    if (r.kind === "FieldMapping") return { ...r, interface: re(r.interface) };
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
        const direct = s.refs.map((r) => stepTo.get(r)).find((x) => !!x);
        const to =
          s.to && direct
            ? { ...s.to, ...direct }
            : s.to && was && joinedTo.has(was)
              ? { ...s.to, component: joinedTo.get(was)! }
              : s.to;
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
    ...(join ? { join } : {}),
  };
}

/**
 * Every repo's facts written into one catalog, as `atticus verify <repo> --write` writes them
 * one by one with the others' facts as the estate (ADR 0124, C-join): the catalog, each repo's
 * flows (in the order given) and the estate's whole join. The bench measures the estate with it.
 */
export function estateFromFacts(input: {
  op: OrgPack;
  repos: readonly { repo: string; facts: readonly Fact[] }[];
  existing?: readonly CatalogRecord[];
  decisions?: readonly CatalogRecord[];
}): {
  records: CatalogRecord[];
  specs: { repo: string; flows: FlowRecord[] }[];
  join: FactsJoinResult;
  invalid: FactsCatalogResult["invalid"];
} {
  let records = [...(input.existing ?? [])];
  const specs: { repo: string; flows: FlowRecord[] }[] = [];
  const invalid: FactsCatalogResult["invalid"] = [];
  for (const { repo, facts } of input.repos) {
    const out = catalogWithFacts({
      repo,
      facts,
      existing: records,
      op: input.op,
      decisions: input.decisions ?? [],
      estate: input.repos.filter((x) => x.repo !== repo),
    });
    records = out.records;
    specs.push({ repo, flows: out.flows });
    invalid.push(...out.invalid);
  }
  const join = joinFacts({
    repos: joinReposOf(
      input.op,
      input.repos.map(({ repo, facts }) => ({
        repo,
        facts: factsRecords({ repo, facts, op: input.op }).facts,
      })),
    ),
  });
  return { records, specs, join, invalid };
}
