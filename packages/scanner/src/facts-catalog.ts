import { createHash } from "node:crypto";
import {
  joinConventions,
  helperOn,
  callerRecords,
  DECLARED_CALLER,
  callTargetQuestion,
  declaredCallsOf,
  factIdPart,
  joinCallers,
  joinFacts,
  joinTerms,
  termGrantRecords,
  type TermsResult,
  joinRecords,
  normalizePath,
  parseRecord,
  projectFacts,
  questionId,
  isGuessedJoin,
  isPathMatch,
  hostMatches,
  NO_TARGET,
  slugify,
  TARGETS_SPLIT_LABEL,
  TARGETS_STEP_ID,
  urlHostPort,
  type CallersResult,
  type CatalogRecord,
  type CuratedProblem,
  type Fact,
  type FactOf,
  type FactJoin,
  type FactJoinAsk,
  type FactJoinMiss,
  type FactsJoinResult,
  type FlowRecord,
  type JoinRepo,
  type OrgPack,
  type Question,
  type QuestionDraft,
  type QuestionOption,
  type RecordIssue,
  applyCurated,
  applyLinkEvidence,
  linkEvidenceOf,
  stripLinkEvidence,
  stripSharedMaps,
  applySharedMaps,
  joinSharedMaps,
  sharedJoinAbout,
  type SharedMap,
  type SharedJoinResult,
  type ContractsFileT,
  type LinkEvidenceResult,
  type TrafficOnFile,
} from "@maycombhq/core";
import { estateRepos, isPrototypeRepo, mergeEstate } from "./merge-input.js";
import {
  offeredSuggestions,
  targetSuggestions,
  TARGETS_ANOTHER,
  type SuggestContext,
  TARGETS_NO_EVIDENCE,
  type TargetSuggestion,
} from "./target-suggest.js";

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
export const TARGETS_STEP = TARGETS_STEP_ID;

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
  /**
   * ADR 0151: the consumers' contract files (each repo's `<repo>.contracts.yaml`) and the traffic
   * aggregates people imported (`evidence/traffic/`), read against the estate's join.
   */
  linkEvidence?: { contracts?: readonly ContractsFileT[]; traffic?: readonly TrafficOnFile[] };
  /**
   * ADR 0160 (O3): other teams' shared maps (`shared/<team>/`): a call the estate join leaves to
   * a team's system joins the entry of their map that serves it, cited on their line; nothing of
   * theirs is written as ours.
   */
  shared?: readonly SharedMap[];
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
  /** With the estate: the links contract files and traffic bear out, and where they disagree (ADR 0151). */
  linkEvidence?: LinkEvidenceResult;
  /** With the estate and shared maps: this repo's calls joined to another team's map (ADR 0160). */
  shared?: SharedJoinResult;
  /**
   * With the estate: the organisation's terms across it (ADR 0163), whole: owners, consumers,
   * possible links and what the consumer lists say against the calls (`termsAbout` cuts it to
   * one repo).
   */
  terms?: TermsResult;
  /**
   * ADR 0162 (F8): with the estate, the calls a person's answer sends to a repo that is read, where
   * no route of it serves the call: this repo's calls, and the other repos' calls answered to this
   * repo. Their questions open again with the reason.
   */
  answerMisses?: FactJoinMiss[];
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

const MAX_ID = 120;

/**
 * Renames ids after a record whose id changed: the record itself, and every id under it
 * (`<call>.request` follows the call's Interface). An id the rename makes longer than a record id
 * may be is shortened to its first part and a hash of the whole, so it stays valid and is the
 * same wherever it is renamed.
 */
export function remapIds(remap: ReadonlyMap<string, string>): (id: string) => string {
  return (id) => {
    const exact = remap.get(id);
    if (exact) return exact;
    for (const [from, to] of remap)
      if (id.startsWith(`${from}.`)) {
        const out = to + id.slice(from.length);
        if (out.length <= MAX_ID) return out;
        const hash = createHash("sha256").update(out, "utf8").digest("hex").slice(0, 16);
        return `${out.slice(0, MAX_ID - hash.length - 1).replace(/[-._]+$/, "")}.${hash}`;
      }
    return id;
  };
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

/** A call a target question asks about, with what its options are made of. */
interface TargetAsk {
  f: FactOf<"call">;
  q: { question: string; evidence: string[] };
  /** The components that could answer it, sorted. */
  servers: string[];
}

/** The calls with no target (or an ambiguous one) and what could answer each. */
function targetAsks(
  facts: readonly Fact[],
  records: readonly CatalogRecord[],
  asks?: readonly FactJoinAsk[],
): { list: TargetAsk[]; repoOf: Map<string, string> } {
  const repoOf = new Map<string, string>();
  for (const r of records) if (r.kind === "Component" && r.repo) repoOf.set(r.id, r.repo);
  const list: TargetAsk[] = [];
  for (const f of [...facts].sort((a, b) => a.id.localeCompare(b.id))) {
    const ask = asks?.find(
      (a) => a.reason === "ambiguous" && a.call.repo === f.repo && a.call.fact === f.id,
    );
    // A call with no target, or one whose target names nothing in the estate that two or more
    // entries could answer (the join fallback, ADR 0124 addendum C-join).
    if (f.kind !== "call" || (!needsTarget(f, facts) && !ask)) continue;
    const own = slugify(f.component ?? f.repo).replace(/\./g, "-");
    const types = new Set(SERVES[f.callType] ?? []);
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
    list.push({ f, q: targetQuestionFor(f)!, servers });
  }
  return { list, repoOf };
}

/** What an outside system is, in a target question's words (O2). */
const outsideAs = (s: { boundary: string }) =>
  s.boundary === "vendor" ? "an outside system" : "another team's system";

const callWhat = (f: FactOf<"call">) => [f.method?.toUpperCase(), f.path].filter(Boolean).join(" ");

/** A target question's draft as it is written, with the calls it asks about. */
export interface TargetQuestionDraft {
  /** The first call it asks about. */
  factId: string;
  /** Every call it asks about (Q1): one for a call's own question, two or more for a group's. */
  factIds: string[];
  id: string;
  repo: string;
  draft: QuestionDraft;
}

/** What the suggestions are read from beside the catalog (ADR 0162, F8). */
export interface TargetDraftContext {
  /** The other repos' verified facts: which repos are read, their entries, Routes and proxies. */
  estate?: SuggestContext["estate"];
  /** Every targets question on file: the caller repo's earlier answers. */
  questions?: SuggestContext["questions"];
}

/**
 * Why a suggestion is offered, in a few words (beta.12): what the evidence says, never that it
 * answers the call unless an entry of it serves it. A group's question says how many of the
 * entries it serves under the group's prefix, not one line per call.
 */
export function suggestionWhy(s: TargetSuggestion, prefix?: string): string {
  const served = s.serves ?? [];
  let why = s.why;
  if (prefix !== undefined && served.length > 1) {
    const under = prefix === "/" ? "" : ` under ${prefix}`;
    why = [
      `serves ${served[0]} and ${served.length - 1} more${under}`,
      ...why.filter((w) => !w.startsWith("serves ")),
    ];
  }
  return (why.length ? why : [TARGETS_NO_EVIDENCE]).slice(0, 3).join("; ");
}

/** A suggestion as an option of a targets question: what it is, why, and what picking it does. */
function suggestionOption(
  s: TargetSuggestion,
  callerRepo: string,
  n?: number,
  prefix?: string,
): QuestionOption {
  const why = suggestionWhy(s, prefix);
  if (s.kind === "outside")
    return {
      label: s.label,
      means: `${s.name}, ${outsideAs({ boundary: s.boundary ?? "vendor" })}: ${why}`,
      changes: n
        ? `The ${n} calls go to ${s.name} when the facts are next written`
        : `The call goes to ${s.name} when the facts are next written`,
    };
  const who =
    s.label === s.repo
      ? `${s.repo}${s.read ? "" : " (not read yet)"}`
      : `${s.label}, built in ${s.repo}${s.read ? "" : " (not read yet)"}`;
  const them = n ? `The ${n} calls` : "The call";
  return {
    label: s.label,
    means: `${who}: ${why}`,
    changes: s.read
      ? `${them} ${n ? "join" : "joins"} ${s.label} when the facts are next written (atticus verify ${callerRepo} --write)`
      : `${them} ${n ? "go" : "goes"} to ${s.repo} when the facts are next written (atticus verify ${callerRepo} --write), and ${n ? "join" : "joins"} its route once ${s.repo} is read and verified (/atticus-map ${s.repo}); if no route of it serves ${n ? "them" : "it"}, the question opens again`,
  };
}

/** The "Another repo…" option: the picker of the whole estate (ADR 0162, F8). */
const anotherOption = (op: OrgPack): QuestionOption => {
  const repos = estateRepos(op).length;
  const systems = new Set(op.profiles.flatMap((p) => (p.profile?.systems ?? []).map((s) => s.id)))
    .size;
  const teams = op.roles?.teams?.length ?? 0;
  return {
    label: TARGETS_ANOTHER,
    means: `A repo, system or team not listed here: the manifest's ${repos} repos (read or not), the profiles' ${systems} systems and the ${teams} teams in roles.yaml`,
    changes:
      "Nothing until you name one: atticus questions answer <id> --target <repo, system or team id> lists them and takes the one you name (the app's Questions page lists them too); naming a vendor or a team with no system adds that system to the profile for review",
  };
};

/** The suggestions offered for calls (one, or a group's), merged by label and bounded. */
function offered(
  members: readonly TargetAsk[],
  facts: readonly Fact[],
  records: readonly CatalogRecord[],
  op: OrgPack,
  asks: readonly FactJoinAsk[] | undefined,
  ctx: TargetDraftContext,
): TargetSuggestion[] {
  const merged = new Map<string, TargetSuggestion>();
  for (const m of members) {
    const ambiguous = asks?.some(
      (a) => a.reason === "ambiguous" && a.call.repo === m.f.repo && a.call.fact === m.f.id,
    );
    for (const s of targetSuggestions(m.f, {
      op,
      records,
      facts,
      ...(ctx.estate ? { estate: ctx.estate } : {}),
      ...(ctx.questions ? { questions: ctx.questions } : {}),
      ...(ambiguous ? { only: m.servers } : {}),
    })) {
      const x = merged.get(s.label);
      if (!x) merged.set(s.label, { ...s, why: [...s.why], serves: [...(s.serves ?? [])] });
      else {
        x.score += s.score;
        for (const w of s.why) if (!x.why.includes(w)) x.why.push(w);
        for (const w of s.serves ?? []) if (!x.serves!.includes(w)) x.serves!.push(w);
        // Evidence for one call outweighs "no evidence" for another.
        if (x.why.length > 1) x.why = x.why.filter((w) => w !== TARGETS_NO_EVIDENCE);
      }
    }
  }
  const ranked = [...merged.values()].sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.read) - Number(a.read) ||
      (a.kind === b.kind ? 0 : a.kind === "repo" ? -1 : 1) ||
      a.label.localeCompare(b.label),
  );
  const serving = new Set(members.flatMap((m) => m.servers));
  const types = new Set(members.flatMap((m) => SERVES[m.f.callType] ?? []));
  // A read repo that serves the call's type was always offered: it fills the list, unranked.
  return offeredSuggestions(ranked, { types, serving });
}

/**
 * One question (ADR 0078) per call that has no target and no host: which repo or system answers
 * it. ADR 0162 (F8): the options are the repos of the manifest, read or not, and the outside
 * systems, ranked by the evidence and bounded, each saying why and whether the repo is read; then
 * "Another repo…" (the whole estate's picker) and "None of these".
 */
export function targetQuestionDrafts(
  facts: readonly Fact[],
  records: readonly CatalogRecord[],
  op: OrgPack,
  /** The estate join's questions: a call two or more entries could answer offers only those. */
  asks?: readonly FactJoinAsk[],
  ctx: TargetDraftContext = {},
): { factId: string; id: string; repo: string; draft: QuestionDraft }[] {
  const { list } = targetAsks(facts, records, asks);
  return list.map((m) => {
    const { f, q } = m;
    const draft: QuestionDraft = {
      question: q.question,
      options: [
        ...offered([m], facts, records, op, asks, ctx).map((s) => suggestionOption(s, f.repo)),
        anotherOption(op),
        {
          label: TARGETS_NONE,
          means: "Nothing in the estate or the org pack's systems answers it",
          changes: "The call stays a loose end, and this isn't asked again",
        },
      ],
      evidence: q.evidence,
      scope: "repo",
    };
    return {
      factId: f.id,
      id: questionId({
        step: TARGETS_STEP,
        repo: f.repo,
        question: q.question,
        evidence: q.evidence,
      }),
      repo: f.repo,
      draft,
    };
  });
}

/**
 * The option of a group's question (Q1) that says its calls don't all go to one place: nothing
 * is read from it, and each call is asked on its own on the next write.
 */
export const TARGETS_SPLIT = TARGETS_SPLIT_LABEL;

/** Segments a group's prefix keeps going past: an api root or a version. */
const PREFIX_ROOT = /^(api|rest|services?|v\d+(\.\d+)*)$/i;

/**
 * The part of a call's path a group of target questions shares (Q1): its first segment, with an
 * api root or version segment in front of it kept (/api/v2/accounts). A placeholder ends it.
 */
export function targetPathPrefix(path: string): string {
  const lead = path.startsWith("/") ? "/" : "";
  const out: string[] = [];
  for (const s of path.split(/[?#]/)[0]!.split("/").filter(Boolean)) {
    if (/^[{:<]/.test(s)) break;
    out.push(s);
    if (!PREFIX_ROOT.test(s)) break;
  }
  return out.length ? `${lead}${out.join("/")}` : "/";
}

/** What a group's calls go through: the target they name, else their host, else their base. */
function groupVia(f: FactOf<"call">): string {
  if (f.to) return ` naming ${f.to}`;
  if (f.host) return ` on ${f.host}`;
  if (f.base) return ` through ${f.base}`;
  return "";
}

/**
 * The question asked once for the calls of a repo that go the same way (Q1): the same target
 * named, or host, or base, and the same path prefix. Its words name only what the group shares,
 * so they stay the same as calls join or leave it.
 */
export function targetGroupQuestion(
  repo: string,
  f: FactOf<"call">,
  facts?: readonly Fact[],
): string {
  const proxy = facts ? proxyOf(f, facts) : undefined;
  const through = f.base ?? f.host ?? f.to;
  if (proxy && through) {
    const p = targetPathPrefix(f.path);
    return `Which repo serves the routes under ${p === "/" ? "" : p}/** that ${proxy} forwards to ${through}?`;
  }
  return `Which repo or system answers the calls ${repo} makes under ${targetPathPrefix(f.path)}${groupVia(f)}?`;
}

/**
 * Beta.12: a gateway proxy's forwarding call (a call made from one of its routes, in a repo
 * with an Apigee proxy's deploy fact): the proxy's name, for the group's words.
 */
function proxyOf(f: FactOf<"call">, facts: readonly Fact[]): string | undefined {
  if (!f.from) return undefined;
  const from = facts.find((x) => x.id === f.from);
  if (!from || from.kind !== "entry") return undefined;
  const proxy = facts.find(
    (x): x is FactOf<"deploy"> =>
      x.kind === "deploy" && x.repo === f.repo && x.platform === "apigee" && !!x.basePath,
  );
  return proxy ? (proxy.resourceName ?? f.repo) : undefined;
}

/**
 * The words a call's group question has had (Q1): today's first, then the words asked before
 * beta.12 when they differ, so an answer to a group asked in the older words still reads.
 */
export function targetGroupWordings(
  repo: string,
  f: FactOf<"call">,
  facts: readonly Fact[],
): string[] {
  return [...new Set([targetGroupQuestion(repo, f, facts), targetGroupQuestion(repo, f)])];
}

const repo0 = (members: readonly TargetAsk[]) => members[0]!.f.repo;

const byLine = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/** The answer's option label, or the person's words. */
const answerLabel = (q: Question): string | undefined =>
  q.answer?.option !== undefined ? q.options[q.answer.option - 1]?.label : q.answer?.text;

/** The groups a person said don't all go to one place: their questions' words. */
export function splitTargetGroups(questions: readonly Question[]): Set<string> {
  return new Set(
    questions
      .filter(
        (q) =>
          q.askedBy?.step === TARGETS_STEP &&
          q.state === "answered" &&
          answerLabel(q) === TARGETS_SPLIT,
      )
      .map((q) => q.question.trim()),
  );
}

/**
 * The target questions to ask (Q1): the calls of `ask` that go the same way are asked once, as
 * one question with every call's line as evidence, and one answer names the target of all of
 * them. A call alone in its group, or in a group a person said is split, keeps its own question,
 * word for word as before, so its id and any answer to it hold. Deterministic.
 */
export function groupedTargetDrafts(
  facts: readonly Fact[],
  records: readonly CatalogRecord[],
  op: OrgPack,
  asks: readonly FactJoinAsk[] | undefined,
  o: { ask: ReadonlySet<string>; split?: ReadonlySet<string> } & TargetDraftContext,
): TargetQuestionDraft[] {
  const { list } = targetAsks(facts, records, asks);
  const ctx: TargetDraftContext = {
    ...(o.estate ? { estate: o.estate } : {}),
    ...(o.questions ? { questions: o.questions } : {}),
  };
  const own = new Map(
    targetQuestionDrafts(facts, records, op, asks, ctx).map((d) => [d.factId, d]),
  );
  const groups = new Map<string, TargetAsk[]>();
  for (const a of list) {
    if (!o.ask.has(a.f.id)) continue;
    const k = targetGroupQuestion(a.f.repo, a.f, facts);
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const out: TargetQuestionDraft[] = [];
  for (const [question, members] of groups) {
    const split = targetGroupWordings(repo0(members), members[0]!.f, facts).some((w) =>
      o.split?.has(w),
    );
    if (members.length === 1 || split) {
      for (const m of members) out.push({ ...own.get(m.f.id)!, factIds: [m.f.id] });
      continue;
    }
    const repo = members[0]!.f.repo;
    const whats = [...new Set(members.map((m) => callWhat(m.f)))];
    const listed =
      whats.length > 5
        ? `${whats.slice(0, 5).join(", ")} and ${whats.length - 5} more`
        : whats.join(", ");
    const n = members.length;
    const evidence = [...new Set(members.flatMap((m) => m.q.evidence))].sort(byLine);
    const draft: QuestionDraft = {
      question,
      options: [
        ...offered(members, facts, records, op, asks, ctx).map((s) =>
          suggestionOption(s, repo, n, targetPathPrefix(members[0]!.f.path)),
        ),
        anotherOption(op),
        {
          label: TARGETS_SPLIT,
          means: `The ${n} calls (${listed}) don't all go to one place`,
          changes:
            "Nothing is joined from this answer; each call is asked on its own when the facts are next written",
        },
        {
          label: TARGETS_NONE,
          means: "Nothing in the estate or the org pack's systems answers any of them",
          changes: "The calls stay loose ends, and this isn't asked again",
        },
      ],
      evidence,
      scope: "repo",
    };
    out.push({
      factId: members[0]!.f.id,
      factIds: members.map((m) => m.f.id),
      id: questionId({ step: TARGETS_STEP, repo, question, evidence }),
      repo,
      draft,
    });
  }
  return out.sort((a, b) => a.factId.localeCompare(b.factId));
}

/** A rule several open target questions share (beta.12): one answer with it covers them all. */
export interface TargetRuleOffer {
  /** The rule: a path prefix (`/accounts/**`), or the host the calls go to. */
  match: string;
  /** The open questions of the repo it covers, this one among them, sorted. */
  ids: string[];
  /** How many calls they ask about. */
  calls: number;
}

/**
 * Beta.12: for each open targets question whose calls share a path prefix (Q1's, `/accounts`), or
 * a host, with another open targets question of the same repo, the rule one answer could take to
 * cover them all (ADR 0153, Q2): `--match '/accounts/**'`. A question's calls are the call facts
 * its evidence cites. Pure: the questions on file and each repo's facts.
 */
export function targetRuleOffers(
  questions: readonly Question[],
  factsOf: (repo: string) => readonly Fact[] | undefined,
): Map<string, TargetRuleOffer> {
  const byKey = new Map<string, { match: string; ids: string[]; calls: number }>();
  for (const q of questions) {
    if (q.state !== "open" || q.askedBy?.step !== TARGETS_STEP) continue;
    const facts = factsOf(q.repo) ?? [];
    const at = new Set(q.evidence);
    const calls = facts.filter(
      (f): f is FactOf<"call"> =>
        f.kind === "call" && f.repo === q.repo && at.has(`${f.cite.file}:${f.cite.line}`),
    );
    if (!calls.length) continue;
    const prefixes = new Set(calls.map((c) => targetPathPrefix(c.path)));
    const hosts = new Set(
      calls.map((c) => c.host?.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/:]/)[0]),
    );
    const [prefix] = prefixes;
    const [host] = hosts;
    const match =
      prefixes.size === 1 && prefix !== "/"
        ? `${prefix}/**`
        : hosts.size === 1 && host
          ? host
          : undefined;
    if (!match) continue;
    const key = `${q.repo}\n${match}`;
    const x = byKey.get(key) ?? { match, ids: [], calls: 0 };
    x.ids.push(q.id);
    x.calls += calls.length;
    byKey.set(key, x);
  }
  const out = new Map<string, TargetRuleOffer>();
  for (const x of byKey.values()) {
    if (x.ids.length < 2) continue;
    const ids = [...x.ids].sort();
    for (const id of ids) out.set(id, { match: x.match, ids, calls: x.calls });
  }
  return out;
}

/** A path's segments, a placeholder on either side being any one. */
const segmentsOf = (p: string) =>
  p
    .split(/[?#]/)[0]!
    .split("/")
    .filter(Boolean)
    .map((x) => (/^[{:<]/.test(x) ? "{}" : x));

/**
 * Whether a call is one an answer's rule covers (ADR 0153, Q2): a path prefix covers a call whose
 * path starts with its segments (`/forge/limits/**` and `/forge/limits` alike); a host pattern, a
 * call on a host it matches as the manifest matches hosts (the call's own host, or its base's URL).
 */
export function ruleCoversCall(match: string, f: FactOf<"call">, facts: readonly Fact[]): boolean {
  if (isPathMatch(match)) {
    const want = segmentsOf(match.replace(/\/\*\*$/, ""));
    const got = segmentsOf(f.path);
    return (
      want.length <= got.length &&
      want.every((x, i) => x === "{}" || got[i] === "{}" || x === got[i])
    );
  }
  const url = urlOf(f, facts);
  const hp = url ? urlHostPort(url) : undefined;
  return !!hp?.host && hostMatches(match, hp.host, hp.port);
}

/** A call a rule answers: the question whose answer has the rule, and the rule. */
export interface RuledCall {
  id: string;
  match: string;
  label: string;
}

/**
 * The calls of a repo the answers' rules cover (ADR 0153, Q2), by call fact id: each answered
 * targets question with a rule (`answer.match`) whose scope allows the repo (this repo, or its
 * type), for every call that still has no target, found now or later. Where two rules cover a
 * call, the one scoped to the repo wins, then the longer rule, then the later answer.
 */
export function ruledTargets(
  repo: string,
  facts: readonly Fact[],
  questions: readonly Question[],
  o: { repoType?: string } = {},
): Map<string, RuledCall> {
  const rules = questions
    .filter(
      (q) =>
        q.askedBy?.step === TARGETS_STEP &&
        q.state === "answered" &&
        !!q.answer?.match &&
        (q.answer.scope.level === "repo"
          ? q.answer.scope.id === repo
          : !!o.repoType && q.answer.scope.id === o.repoType),
    )
    .sort(
      (a, b) =>
        (a.answer!.scope.level === "repo" ? 0 : 1) - (b.answer!.scope.level === "repo" ? 0 : 1) ||
        b.answer!.match!.length - a.answer!.match!.length ||
        b.answer!.at.localeCompare(a.answer!.at) ||
        a.id.localeCompare(b.id),
    );
  const out = new Map<string, RuledCall>();
  if (!rules.length) return out;
  for (const f of facts) {
    if (!needsTarget(f, facts)) continue;
    const q = rules.find((r) => ruleCoversCall(r.answer!.match!, f, facts));
    const label = q ? answerLabel(q) : undefined;
    if (q && label && label !== TARGETS_SPLIT)
      out.set(f.id, { id: q.id, match: q.answer!.match!, label });
  }
  return out;
}

/**
 * The targets people named for calls (the answers to targets questions), by call fact id. An
 * option is its label; words of the person's own are read as the target's name; "None of these"
 * names nothing. Only answered questions count. A call's own question is read first; else the
 * answer to its group's question (Q1) names it, when the call is one the group asked (its line
 * is the question's evidence) or one that still has no target and no host, so a call added to
 * the group later reads the same answer; else an answer's rule that covers it (ADR 0153, Q2),
 * from any repo's question whose scope allows this repo (`repoType` for a repo-type scope).
 */
export function targetsFromAnswers(
  repo: string,
  facts: readonly Fact[],
  questions: readonly Question[],
  o: { repoType?: string } = {},
): Record<string, string> {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const groups = new Map<string, Question>();
  for (const q of [...questions]
    .filter(
      (x) =>
        x.askedBy?.step === TARGETS_STEP &&
        x.state === "answered" &&
        !!x.answer &&
        typeof x.question === "string",
    )
    .sort((a, b) => a.answer!.at.localeCompare(b.answer!.at) || a.id.localeCompare(b.id)))
    groups.set(q.question.trim(), q);
  const ruled = ruledTargets(repo, facts, questions, o);
  const out: Record<string, string> = {};
  for (const f of [...facts].sort((a, b) => a.id.localeCompare(b.id))) {
    // A call that names a target is asked only when the estate has no such target and two or
    // more entries could answer it; its answer counts the same.
    if (f.kind !== "call") continue;
    const q = targetQuestionFor(f);
    if (!q) continue;
    let asked = byId.get(questionId({ step: TARGETS_STEP, repo, ...q }));
    if (!asked || asked.state !== "answered" || !asked.answer) {
      const g = targetGroupWordings(repo, f, facts)
        .map((w) => groups.get(w))
        .find((x) => !!x);
      asked = g && (needsTarget(f, facts) || g.evidence.includes(q.evidence[0]!)) ? g : undefined;
    }
    let label =
      asked && asked.state === "answered" && asked.answer ? answerLabel(asked) : undefined;
    if (!label || label === TARGETS_SPLIT || label === TARGETS_ANOTHER)
      label = ruled.get(f.id)?.label;
    if (!label || label === TARGETS_SPLIT || label === TARGETS_ANOTHER) continue;
    // F3: "None of these" binds: the call is kept out of the join, not guessed by path.
    if (label === TARGETS_NONE) {
      out[f.id] = NO_TARGET;
      continue;
    }
    const to = slugify(label);
    if (to) out[f.id] = to;
  }
  return out;
}

/**
 * ADR 0162 (F8): the answered targets question whose answer names a call's target: the call's own,
 * else its group's (Q1) when the call is one the group asked. A target only a rule gives (Q2) has
 * none here: one call that disagrees doesn't reopen a rule that covers many.
 */
export function answeredQuestionOfCall(
  repo: string,
  facts: readonly Fact[],
  questions: readonly Question[],
  factId: string,
): Question | undefined {
  const f = facts.find((x) => x.id === factId);
  if (!f || f.kind !== "call") return undefined;
  const own = targetQuestionFor(f)!;
  const ownId = questionId({ step: TARGETS_STEP, repo, ...own });
  const answered = questions.filter(
    (q) => q.askedBy?.step === TARGETS_STEP && q.state === "answered" && q.repo === repo,
  );
  const q =
    answered.find((x) => x.id === ownId) ??
    answered.find(
      (x) =>
        targetGroupWordings(repo, f, facts).includes(x.question.trim()) &&
        x.evidence.includes(own.evidence[0]!),
    );
  // An answer given as a rule (Q2, `match`) covers many calls: one call that disagrees doesn't
  // name it, so it is never reopened from here.
  return q?.answer?.match ? undefined : q;
}

/**
 * Review item 2: the question reopened, and the person gave the answer it had again (the same
 * option, or the same target in their own words). Their word holds: it is not reopened again for
 * the same disagreement.
 */
export function answerReconfirmed(q: Question): boolean {
  if (!q.answer || !q.reopened) return false;
  const now = answerLabel(q);
  const was = answerLabel({ ...q, answer: q.reopened.answer });
  return !!now && !!was && slugify(now) === slugify(was);
}

/** How a join found its callee, in the words a retired question says. */
const JOINED_BY: Partial<Record<FactJoin["how"], string>> = {
  named: "the call names it",
  repo: "the call names its repo",
  host: "the manifest's hosts and base paths decide it",
  topic: "it listens on the call's topic",
};

/** The calls an open target question asks about: by its id for a call's own, by its words and lines for a group's. */
function callsOfTargetQuestion(
  repo: string,
  facts: readonly Fact[],
  q: Question,
): FactOf<"call">[] {
  return facts.filter((f): f is FactOf<"call"> => {
    if (f.kind !== "call") return false;
    const own = targetQuestionFor(f)!;
    if (questionId({ step: TARGETS_STEP, repo, ...own }) === q.id) return true;
    return (
      targetGroupWordings(repo, f, facts).includes(q.question.trim()) &&
      q.evidence.includes(own.evidence[0]!)
    );
  });
}

/**
 * The open target questions to retire after a write (J6, Q1), each with why: one whose calls are
 * asked now by another question (a group's, or each call's own once a group splits or shrinks)
 * names the questions that replace it; one whose every call the code now answers, with no answer
 * (it names its target, or joins by the manifest's hosts and base paths), says how each joins. A
 * call joined only by a guess (by path, a host's first label, a platform-wide setting, a
 * setting's folder name, or despite an open conflict) keeps its question open, and an
 * answered question is never listed: a person's answer stays what joins the call.
 */
export function staleTargetQuestions(input: {
  repo: string;
  facts: readonly Fact[];
  /** The repo's open questions of the targets step. */
  open: readonly Question[];
  /** The questions this write asks (`groupedTargetDrafts`). */
  drafted: readonly TargetQuestionDraft[];
  /** The calls this write asks about. */
  asked: ReadonlySet<string>;
  join?: FactsJoinResult;
  /** ADR 0153 (Q2): the calls an answer's rule covers (`ruledTargets`). */
  ruled?: ReadonlyMap<string, RuledCall>;
}): { id: string; why: string; replacedBy?: string[] }[] {
  const drafted = new Set(input.drafted.map((d) => d.id));
  const out: { id: string; why: string; replacedBy?: string[] }[] = [];
  for (const q of input.open) {
    if (q.state !== "open" || q.askedBy.step !== TARGETS_STEP || drafted.has(q.id)) continue;
    const calls = callsOfTargetQuestion(input.repo, input.facts, q);
    if (!calls.length) continue;
    const ids = new Set(calls.map((c) => c.id));
    const by = input.drafted.filter((d) => d.factIds.some((x) => ids.has(x))).map((d) => d.id);
    if (by.length) {
      out.push({ id: q.id, why: `its calls are asked now in ${by.join(", ")}`, replacedBy: by });
      continue;
    }
    if (calls.some((c) => input.asked.has(c.id))) continue;
    const reasons = calls.map((c) => {
      const rule = input.ruled?.get(c.id);
      if (rule) return `${callWhat(c)} is answered by rule in ${rule.id} (${rule.match})`;
      const j = input.join?.joins.find(
        (x) => x.call.repo === input.repo && x.call.fact === c.id && x.how !== "answer",
      );
      if (j && !isGuessedJoin(j) && JOINED_BY[j.how])
        return `${callWhat(c)} joins ${j.entry.component} in ${j.entry.repo}: ${JOINED_BY[j.how]}`;
      if (!j && c.to) return `${callWhat(c)} now names ${c.to} in the code`;
      return undefined;
    });
    const rules = [
      ...new Set(calls.flatMap((c) => (input.ruled?.get(c.id) ? [input.ruled.get(c.id)!.id] : []))),
    ].sort();
    if (reasons.every((r) => r !== undefined))
      out.push({
        id: q.id,
        why: reasons.join("; "),
        ...(rules.length ? { replacedBy: rules } : {}),
      });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** A repo's component renames: the id a fact's component had, and the estate-unique id it gets. */
export type ComponentRenames = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * Component ids two repos would share (B-fixes, problem 1): a fact's `component` is the
 * assistant's name for a folder of its repo (`frontend`, `backend`), so two repos can both have
 * one, and their records would merge into one Component owned by the repo written first. A
 * component id more than one repo uses becomes `<repo>-<component>` in each of them, except in
 * the repo whose own id it is (repo ids are unique). Every other id stays as it was, so a facts
 * file whose components no other repo has projects the same records as before. `taken` are
 * component ids other repos' records already hold (the catalog as it is): one of this list's
 * repos that uses one is renamed too, even when the other repo's facts aren't to hand.
 */
export function componentRenames(
  repos: readonly { repo: string; facts: readonly Fact[] }[],
  op: OrgPack,
  taken: readonly { id: string; repo: string }[] = [],
): ComponentRenames {
  const manifests = estateRepos(op);
  const users = new Map<string, Set<string>>(); // component id -> repos
  const use = (id: string, repo: string) => users.set(id, (users.get(id) ?? new Set()).add(repo));
  for (const { repo, facts } of repos) {
    const fallback = manifests.find((r) => r.id === repo)?.component;
    for (const f of facts)
      if (f.kind !== "field") use(factIdPart(f.component ?? fallback ?? repo), repo);
  }
  for (const t of taken) if (users.has(t.id)) use(t.id, t.repo);
  const out: Record<string, Record<string, string>> = {};
  for (const [id, set] of [...users].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (set.size < 2) continue;
    for (const repo of repos.map((r) => r.repo).filter((r) => set.has(r))) {
      if (factIdPart(repo) === id) continue;
      (out[repo] ??= {})[id] = factIdPart(`${repo}-${id}`);
    }
  }
  return out;
}

/** A repo's facts with its components renamed, the manifest's component filling one left out. */
function withComponents(
  repo: string,
  facts: readonly Fact[],
  op: OrgPack,
  renames: ComponentRenames | undefined,
): Fact[] {
  const fallback = estateRepos(op).find((r) => r.id === repo)?.component;
  const mine = renames?.[repo] ?? {};
  return facts.map((f): Fact => {
    const c = f.component ?? fallback;
    if (!c) return f;
    const to = mine[factIdPart(c)];
    return to ? { ...f, component: to } : f.component ? f : { ...f, component: c };
  });
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
  /** Component ids made estate-unique (componentRenames); left out, every id is kept. */
  renames?: ComponentRenames;
}) {
  const { repo, op } = input;
  const manifest = estateRepos(op).find((r) => r.id === repo);
  // A fact with no component belongs to the component the manifest names for the repo, and a
  // component another repo has too gets its estate-unique id.
  const facts = withComponents(repo, input.facts, op, input.renames).map((f): Fact => {
    let g: Fact = f;
    const to = input.targets?.[g.id];
    if (g.kind === "call" && !g.to && to && to !== NO_TARGET) g = { ...g, to };
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
/**
 * The outside systems a call's `to` may name (id, name and aliases): a call naming one keeps it
 * and is never joined by path (ADR 0124 addendum C-join). Every vendor, and (F3) every other
 * system the profiles declare that no estate repo belongs to, such as another team's.
 */
export function outsideSystems(op: OrgPack): string[] {
  return outsideProfileSystems(op)
    .flatMap((s) => [s.id, s.name, ...s.aliases])
    .sort();
}

/**
 * The profiles' systems outside the estate, each once, by id: every vendor, and (F3) every other
 * system no estate repo belongs to, such as another team's (ADR 0142: its published spec is read
 * as a vendor's is).
 */
export function outsideProfileSystems(op: OrgPack) {
  const own = new Set(estateRepos(op).flatMap((r) => (r.system ? [r.system] : [])));
  const seen = new Set<string>();
  return op.profiles
    .flatMap((p) => p.profile?.systems ?? [])
    .filter(
      (s) => (s.boundary === "vendor" || !own.has(s.id)) && !seen.has(s.id) && !!seen.add(s.id),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The aliases of a system that read as hosts (O1 adds one from a hosts question): `risk.forge.internal`. */
export const hostAliases = (aliases: readonly string[]): string[] =>
  aliases
    .filter((a) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(a))
    .map((a) => a.toLowerCase());

export function joinReposOf(
  op: OrgPack,
  list: readonly { repo: string; facts: readonly Fact[] }[],
  /** Component ids made estate-unique (componentRenames), so the join names the records' ids. */
  renames?: ComponentRenames,
): JoinRepo[] {
  const manifests = estateRepos(op);
  return list.map(({ repo, facts }) => {
    const m = manifests.find((r) => r.id === repo);
    // A module answers on its own hosts, or, giving only a base path, on its repo's (ADR 0134).
    const modules = (m?.modules ?? [])
      .filter((x) => x.hosts.length > 0 || (x.basePath && (m?.hosts.length ?? 0) > 0))
      .map((x) => (x.hosts.length ? x : { ...x, hosts: m!.hosts }));
    const component = m?.component
      ? (renames?.[repo]?.[factIdPart(m.component)] ?? m.component)
      : undefined;
    return {
      repo,
      facts: renames?.[repo] ? withComponents(repo, facts, op, renames) : facts,
      ...(component ? { component } : {}),
      ...(m?.hosts.length ? { hosts: m.hosts } : {}),
      ...(m?.basePath ? { basePath: m.basePath } : {}),
      ...(modules.length
        ? {
            modules: modules.map((x) => ({
              component: x.component,
              hosts: x.hosts,
              ...(x.basePath ? { basePath: x.basePath } : {}),
            })),
          }
        : {}),
      // An API gateway's entries are routes the join follows through (ADR 0124 addendum A-gateway).
      // A type that says which side it faces (`gateway-external`, `gateway-internal`) marks each
      // hop through it (A-gateway2); a plain `gateway` leaves that to the proxy's virtual host.
      ...(m && /^gateway(-|$)/.test(m.type) ? { gateway: true } : {}),
      ...(m?.type === "gateway-external"
        ? { facing: "external" as const }
        : m?.type === "gateway-internal"
          ? { facing: "internal" as const }
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
  /**
   * Who the gateway routes let in (ADR 0124 addendum A-callers): the consumers their files name
   * and the systems people declared, written as C1 records for the routes of `only` (every repo
   * when left out), over the whole estate's `join`.
   */
  withCallers?: { callers: CallersResult; join: FactsJoinResult; only?: readonly string[] },
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
  const re = remapIds(was);
  const joined = joinRecords(join, repos);
  const callers = withCallers
    ? callerRecords(withCallers.callers, repos, withCallers.join, {
        ...(withCallers.only ? { only: withCallers.only } : {}),
        existing: joined,
      })
    : [];
  // A GatewayRoute the callers fill in (its API product) replaces the join's.
  const filled = new Set(callers.map((r) => `${r.kind}|${r.id}`));
  return [
    ...kept.map((r): CatalogRecord => {
      if (r.kind === "Schema" && re(r.ref) !== r.ref) return { ...r, id: re(r.id), ref: re(r.ref) };
      if (r.kind === "FieldMapping" && re(r.interface) !== r.interface)
        return { ...r, id: re(r.id), interface: re(r.interface) };
      return r;
    }),
    ...joined.filter((r) => !filled.has(`${r.kind}|${r.id}`)),
    ...callers,
  ];
}

/** "METHOD /path" of the entry a join reaches, or its gRPC or SOAP name or topic. */
const entryText = (j: FactJoin) => (j.method ? `${j.method} ${j.path}` : j.path);

/** The part of an estate join about one repo: its calls, and the other repos' calls into it. */
function joinAbout(all: FactsJoinResult, repo: string): FactsJoinResult {
  // A join through a gateway of this repo too (A-callers): its routes are this repo's records,
  // so writing the gateway after the caller doesn't drop the GatewayRoute the call goes through.
  const joins = all.joins.filter(
    (j) =>
      j.call.repo === repo ||
      j.entry.repo === repo ||
      !!j.gateway?.some((h) => h.entry.repo === repo) ||
      // J0: a join whose placeholder this repo's config sets (a deploy or config repo) is
      // written again with it, so a changed value moves the link.
      [...(j.through ?? []), ...(j.entryThrough ?? [])].some((t) => t.repo === repo) ||
      // J1: and a join whose host or base path this repo's Route gives (a deploy repo's).
      [...(j.exposedBy ?? []), ...(j.gateway ?? []).flatMap((h) => h.exposedBy ?? [])].some(
        (t) => t.repo === repo,
      ),
  );
  const ifaces = new Set(joins.map((j) => j.interface));
  const outside = (all.outside ?? []).filter((o) => o.call.repo === repo);
  // J1: an exposure this repo holds, or one about this repo's component.
  const exposure = (all.exposure ?? []).filter(
    (x) => x.exposure.repo === repo || ("repo" in x && x.repo === repo),
  );
  return {
    joins,
    asks: all.asks.filter((a) => a.call.repo === repo),
    misses: all.misses.filter((m) => m.call.repo === repo),
    ...(outside.length ? { outside } : {}),
    ...(exposure.length ? { exposure } : {}),
    lineage: all.lineage.filter((l) => ifaces.has(l.interface)),
    gaps: all.gaps.filter((g) => ifaces.has(g.interface)),
  };
}

export function catalogWithFacts(given: FactsCatalogInput): FactsCatalogResult {
  const { repo, op } = given;
  if (isPrototypeRepo(op, repo)) return prototypeLeftOut(given);
  // ADR 0151: what an earlier write's contract files and traffic added is taken off first, so
  // it never keeps a record alive and is made again below from the evidence on file now.
  // ADR 0160: and what a shared map marked, so a map taken away leaves nothing behind.
  const input = { ...given, existing: stripSharedMaps(stripLinkEvidence(given.existing)) };
  // B-fixes, problem 1: a component id another repo has too (in the estate's facts, or a
  // Component of another repo the catalog already holds) is made unique by the repo's id.
  // A prototype's facts are never part of the estate (ADR 0133).
  const others = (input.estate ?? []).filter(
    (x) => x.repo !== repo && !isPrototypeRepo(op, x.repo),
  );
  const renames = componentRenames(
    [{ repo, facts: input.facts }, ...others],
    op,
    input.existing.flatMap((r) =>
      r.kind === "Component" && r.repo && r.repo !== repo ? [{ id: r.id, repo: r.repo }] : [],
    ),
  );
  const { facts, projected, newRecords, newFlows, looseFact } = factsRecords({
    ...input,
    renames,
  });

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
    // A declared caller's Interface (A-callers) rests on a person's word and this gateway's
    // route: it is made again from the profile each time the gateway is written, so a
    // declaration taken back leaves nothing behind.
    else if (m === ev.length || r.flags?.includes(DECLARED_CALLER))
      dropped.add(`${r.kind}|${r.id}`);
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
  let answerMisses: FactJoinMiss[] | undefined;
  let estateJoin: { whole: FactsJoinResult; repos: JoinRepo[] } | undefined;
  let terms: TermsResult | undefined;
  let records0 = [...kept, ...newRecords];
  if (input.estate) {
    const repos = joinReposOf(op, [{ repo, facts }, ...others], renames);
    const whole = joinFacts({
      repos,
      targets: { ...input.estateTargets, [repo]: input.targets ?? {} },
      outside: outsideSystems(op),
      ...joinConventions(op),
      // G4: the walk through gateways is a stack helper (ATTICUS_HELPERS_OFF=gateway-walk).
      walkGateways: helperOn("gateway-walk"),
    });
    join = joinAbout(whole, repo);
    estateJoin = { whole, repos };
    // F8: an answer the code now disagrees with, about a call of this repo or into it.
    const named = { ...input.estateTargets, [repo]: input.targets ?? {} };
    const mine = new Set([
      factIdPart(repo),
      ...repos
        .filter((r) => r.repo === repo)
        .flatMap((r) => [r.component, ...(r.modules ?? []).map((m) => m.component)])
        .filter((x): x is string => !!x)
        .map(factIdPart),
      ...facts.flatMap((f) => (f.component ? [factIdPart(f.component)] : [])),
    ]);
    answerMisses = whole.misses.filter((m) => {
      const t = named[m.call.repo]?.[m.call.fact];
      return !!t && t !== NO_TARGET && (m.call.repo === repo || mine.has(factIdPart(m.target)));
    });
    // A-callers: who this repo's gateway routes let in, read from the whole estate's join (a
    // route's scanned callers may be anywhere) and the systems people declared.
    records0 = applyFactJoins(records0, join, repos, {
      callers: joinCallers({
        repos,
        join: whole,
        declared: declaredCallsOf(op.profiles),
        ...joinConventions(op),
      }),
      join: whole,
      only: [repo],
    });
    // ADR 0163: the consumers this repo's term facts list, as access grants on its routes.
    terms = joinTerms({ repos, join: whole, bundleFolders: joinConventions(op).bundleFolders });
    records0 = [...records0, ...termGrantRecords(terms, repos, { only: [repo] })];
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
  const re = remapIds(remap);
  const records = merged.records.map((r): CatalogRecord => {
    if (r.kind === "Schema") return { ...r, id: re(r.id), ref: re(r.ref) };
    if (r.kind === "Endpoint" && r.schemaRefs.length)
      return { ...r, schemaRefs: r.schemaRefs.map(re).sort() };
    if (r.kind === "FieldMapping") return { ...r, interface: re(r.interface) };
    return r;
  });
  const curated = applyCurated([...records].sort(byKindId), input.decisions);
  // ADR 0151 (J3, J4): the links the consumers' contract files and the imported traffic bear
  // out, read against the whole estate's join so every repo's write marks the same links.
  const linkEvidence = estateJoin
    ? linkEvidenceOf({
        join: estateJoin.whole,
        repos: estateJoin.repos,
        contracts: input.linkEvidence?.contracts ?? [],
        traffic: input.linkEvidence?.traffic ?? [],
      })
    : undefined;
  const evidenced = linkEvidence
    ? { ...curated, records: applyLinkEvidence(curated.records, linkEvidence.marks) }
    : curated;
  // ADR 0160 (O3): the calls the whole estate's join left to a team's system, joined to the
  // entry of the map that team shares; every write marks the same links, whatever the order.
  const systems = outsideProfileSystems(op);
  const sharedWhole =
    estateJoin && input.shared?.length
      ? joinSharedMaps({
          outside: estateJoin.whole.outside ?? [],
          repos: estateJoin.repos,
          maps: input.shared,
          systems,
        })
      : undefined;
  // With no map on file the marks are still taken off the whole catalog (every repo's links,
  // as the link evidence's are), so a map taken away leaves nothing behind on any repo.
  const applied = {
    ...evidenced,
    records: sharedWhole
      ? applySharedMaps(evidenced.records, sharedWhole, systems)
      : stripSharedMaps(evidenced.records),
  };

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
    ...(linkEvidence ? { linkEvidence } : {}),
    ...(sharedWhole ? { shared: sharedJoinAbout(sharedWhole, repo) } : {}),
    ...(terms ? { terms } : {}),
    ...(answerMisses?.length ? { answerMisses } : {}),
  };
}

/**
 * Every repo's facts written into one catalog, as `atticus verify <repo> --write` writes them
 * one by one with the others' facts as the estate (ADR 0124, C-join): the catalog, each repo's
 * flows (in the order given) and the estate's whole join. The bench measures the estate with it.
 */
/**
 * A prototype's write (ADR 0133): its facts are verified and kept, but nothing is projected from
 * them, nothing joins them and nothing is asked about them. A record an earlier write made from
 * the repo alone (before the manifest typed it a prototype) goes; the rest of the catalog stays.
 */
export function prototypeLeftOut(input: FactsCatalogInput): FactsCatalogResult {
  const { repo } = input;
  const records = input.existing.filter((r) => {
    if (r.kind === "Flow" || r.kind === "CuratedDecision") return false;
    const ev = r.evidence as unknown[];
    return !(ev.length && ev.every((e) => (e as Ev).repo === repo));
  });
  return {
    records: [...records].sort(byKindId),
    flows: [],
    unresolved: [],
    curated: { applied: [], suppressed: [], problems: [] },
    projectionIssues: [],
    invalid: [],
    notes: [
      `${repo} is a prototype: its facts are kept in facts/${repo}.jsonl and compared with the estate (atticus change attach <change> --prototype ${repo}), never written into the catalog.`,
    ],
  };
}

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
  // A prototype is compared with the estate, never part of it (ADR 0133).
  const repos = input.repos.filter((x) => !isPrototypeRepo(input.op, x.repo));
  let records = [...(input.existing ?? [])];
  const specs: { repo: string; flows: FlowRecord[] }[] = [];
  const invalid: FactsCatalogResult["invalid"] = [];
  for (const { repo, facts } of repos) {
    const out = catalogWithFacts({
      repo,
      facts,
      existing: records,
      op: input.op,
      decisions: input.decisions ?? [],
      estate: repos.filter((x) => x.repo !== repo),
    });
    records = out.records;
    specs.push({ repo, flows: out.flows });
    invalid.push(...out.invalid);
  }
  const renames = componentRenames(repos, input.op);
  const join = joinFacts({
    repos: joinReposOf(
      input.op,
      repos.map(({ repo, facts }) => ({
        repo,
        facts: factsRecords({ repo, facts, op: input.op, renames }).facts,
      })),
    ),
    outside: outsideSystems(input.op),
    ...joinConventions(input.op),
    walkGateways: helperOn("gateway-walk"),
  });
  return { records, specs, join, invalid };
}

/**
 * ADR 0162 (F8): an answer given the same way in several repos: the calls on one host (or through
 * one config key) that people answered with the same target in two or more repos. One answer can
 * say it for all of them, as a rule (Q2, an answer's `match` with a repo-type scope), when the repos
 * share a type and the calls share a host or a path prefix. Never as a note on the type: a note is
 * what a term means (ADR 0163), not where calls go. Only the offer's words and its command are
 * made here; nothing is written.
 */
export interface AnswerRuleOffer {
  /** `on <host>` or `through <config key>`. */
  via: string;
  /** The target every answer names. */
  label: string;
  repos: string[];
  /** The answered questions, sorted. */
  questions: string[];
  /** The rule the answer would carry: the host, or the calls' shared path prefix. */
  match: string;
  /** The repos' one type. */
  type: string;
  /** The command that makes it a rule. */
  command: string;
  /** The offer in a person's words. */
  line: string;
}

export function answerRuleOffers(input: {
  repos: readonly { repo: string; facts: readonly Fact[]; type?: string }[];
  questions: readonly Question[];
}): AnswerRuleOffer[] {
  const ruled = input.questions.filter(
    (q) => q.askedBy?.step === TARGETS_STEP && q.state === "answered" && !!q.answer?.match,
  );
  const groups = new Map<
    string,
    {
      repo: string;
      q: Question;
      label: string;
      f: FactOf<"call">;
      facts: readonly Fact[];
      type?: string;
    }[]
  >();
  for (const r of input.repos)
    for (const f of r.facts) {
      if (f.kind !== "call") continue;
      const q = answeredQuestionOfCall(r.repo, r.facts, input.questions, f.id);
      const label = q ? answerLabel(q) : undefined;
      if (
        !q ||
        !label ||
        label === TARGETS_NONE ||
        label === TARGETS_SPLIT ||
        label === TARGETS_ANOTHER
      )
        continue;
      const url = urlOf(f, r.facts);
      const host = url ? urlHostPort(url)?.host : undefined;
      const via = host ? `on ${host.toLowerCase()}` : f.base ? `through ${f.base}` : undefined;
      if (!via) continue;
      groups.set(via, [
        ...(groups.get(via) ?? []),
        { repo: r.repo, q, label, f, facts: r.facts, ...(r.type ? { type: r.type } : {}) },
      ]);
    }
  const out: AnswerRuleOffer[] = [];
  for (const [via, xs] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const repos = [...new Set(xs.map((x) => x.repo))].sort();
    const labels = new Set(xs.map((x) => slugify(x.label)));
    if (repos.length < 2 || labels.size !== 1) continue;
    // Already said once by a rule that covers every call.
    if (xs.every((x) => ruled.some((q) => ruleCoversCall(q.answer!.match!, x.f, x.facts))))
      continue;
    const label = xs[0]!.label;
    const prefixes = new Set(xs.map((x) => targetPathPrefix(x.f.path)));
    const prefix = prefixes.size === 1 ? [...prefixes][0]! : undefined;
    const match = via.startsWith("on ")
      ? via.slice(3)
      : prefix && prefix !== "/"
        ? `${prefix}/**`
        : undefined;
    const types = new Set(xs.map((x) => x.type));
    const type = types.size === 1 ? xs[0]!.type : undefined;
    const questions = [...new Set(xs.map((x) => x.q.id))].sort();
    const first = xs.find((x) => x.q.id === questions[0])!.q;
    const n = first.options.findIndex((o) => o.label === label);
    const pick = n >= 0 ? `--option ${n + 1}` : `--text "${label}"`;
    // Review item 8: only the rule is offered. A note saying where calls go would be a routing
    // claim the reader writes from a person's words, not from code (ADR 0163 notes say what terms
    // mean); with no rule to offer (no match, or no type the repos share) nothing is offered.
    if (!match || !type) continue;
    const command = `atticus questions answer ${first.id} ${pick} --match ${match} --scope repo-type --type ${type}`;
    out.push({
      via,
      label,
      repos,
      questions,
      match,
      type,
      command,
      line: `${repos.length} repos (${repos.join(", ")}) answer the calls ${via} the same way, ${label} (${questions.join(", ")}): one answer can say it for every ${type} repo. As a rule: ${command}.`,
    });
  }
  return out;
}
