import {
  cmpNatural,
  askedByStep,
  cmpText,
  forwardHostQuestion,
  HOSTS_NONE,
  HOSTS_OUTSIDE_INTERNAL,
  HOSTS_OUTSIDE_VENDOR,
  HOSTS_STEP,
  hostOfQuestion,
  ignoredAnswer,
  ignoreOption,
  joinHostOfQuestion,
  listQuestions,
  outsideBoundaryOf,
  outsideSystemOfJoinHost,
  placeholderIn,
  TARGETS_STEP_ID,
  type CatalogRecord,
  type Fact,
  type FactJoinAsk,
  type FactsJoinResult,
  type Question,
  type QuestionDraft,
} from "@maycombhq/core";
import { hostQuestionDrafts, type HostAsk, type HostRepo } from "./hosts-asked.js";
import { targetPathPrefix } from "./target-prefix.js";

/**
 * Beta.24 review: the join's questions about hosts, raised as question files. The estate join asks
 * about a call whose host no repo, component or profile system is known by (`unknown-host`); the
 * CLI only counted them, so a person working in the app never saw "which system is this host?".
 *
 * - A host still written as a token (a gateway's forwarding call to `@targetVendorUrl@`, no
 *   deploy file setting it) is asked as a targets question (`facts-targets`), once per host of
 *   the repo and path prefix (beta.27, as Q1 groups the targets questions), in the join's words, which say to read the gateway repo again
 *   (`forwardHostQuestion`). Its options: the estate's repos that serve HTTP (those serving the
 *   calls' paths first), an outside system (new) named by the host, None of these and Ignore. Its
 *   answer names the target of every call it cites (`joinHostTarget`), as a targets answer does.
 * - Any other host is a hosts question (`scan-hosts`, ADR 0088), drafted as `askHosts` drafts
 *   one, when no hosts question asks about it yet: its answer writes the manifest or the profile.
 *
 * Pure: the join's asks, the catalog, the manifest's repos and the repo's facts.
 */

/** Entry point types a call over HTTP reaches. */
const HTTP_TYPES = new Set(["rest", "graphql", "soap", "websocket", "sse", "webhook"]);

/** A path's segments, a placeholder being any one. */
const segs = (p: string) =>
  p
    .split(/[?#]/)[0]!
    .split("/")
    .filter(Boolean)
    .map((x) => (/^[{:<$*]/.test(x) ? "{}" : x));

/** Whether a served path ends with a called one (a context path or base path in front). */
const servesPath = (entry: string, path: string) => {
  const e = segs(entry);
  const c = segs(path);
  if (!c.length || c.length > e.length) return false;
  const tail = e.slice(e.length - c.length);
  return tail.every((x, i) => x === "{}" || c[i] === "{}" || x === c[i]);
};

/** A join host question to raise: the step that asks it, its draft and the calls it cites. */
export interface JoinHostDraft {
  step: typeof TARGETS_STEP_ID | typeof HOSTS_STEP;
  host: string;
  /** The call facts it asks about, sorted. */
  factIds: string[];
  draft: QuestionDraft;
}

/** Whether a host the join asks about is a token, which only a read of its repo can set. */
export const isTokenHost = (host: string): boolean => !!placeholderIn(host);

export function joinHostQuestionDrafts(input: {
  repo: string;
  /** The repo's facts (its calls). */
  facts: readonly Fact[];
  /** The join's asks; only this repo's `unknown-host` ones are drafted. */
  asks: readonly FactJoinAsk[];
  records: readonly CatalogRecord[];
  repos: readonly HostRepo[];
  /** The calls asked another way already (a targets question of their own, an answer). */
  skip?: ReadonlySet<string>;
  /** The hosts a hosts question asks about already, answered or not. */
  hostsAsked?: ReadonlySet<string>;
}): JoinHostDraft[] {
  const byHost = new Map<string, FactJoinAsk[]>();
  for (const a of input.asks) {
    if (a.reason !== "unknown-host" || !a.host || a.call.repo !== input.repo) continue;
    if (input.skip?.has(a.call.fact)) continue;
    if (!isTokenHost(a.host) && input.hostsAsked?.has(a.host)) continue;
    byHost.set(a.host, [...(byHost.get(a.host) ?? []), a]);
  }
  if (!byHost.size) return [];
  // The repos that serve HTTP, the caller aside: a component of theirs has an HTTP entry point.
  const compRepo = new Map<string, string>();
  for (const r of input.repos) {
    compRepo.set(r.component ?? r.id, r.id);
    for (const m of r.modules ?? []) compRepo.set(m.component, r.id);
  }
  const endpoints = input.records.filter(
    (r): r is Extract<CatalogRecord, { kind: "Endpoint" }> =>
      r.kind === "Endpoint" && HTTP_TYPES.has(r.endpointType),
  );
  const servers = [
    ...new Set(
      endpoints.flatMap((e) => (compRepo.has(e.component) ? [compRepo.get(e.component)!] : [])),
    ),
  ]
    .filter((r) => r !== input.repo)
    .sort(cmpText);
  const factOf = new Map(input.facts.map((f) => [f.id, f] as const));
  // Beta.27: a token's calls are asked once per path prefix, as the targets questions group
  // (Q1): one question when they share one, in the join's words as before; else one per prefix,
  // each naming the routes it is about.
  const groups: { host: string; asks: FactJoinAsk[]; question: string }[] = [];
  for (const [host, asks] of [...byHost].sort(([a], [b]) => cmpText(a, b))) {
    const prefixOf = (a: FactJoinAsk) => {
      const f = factOf.get(a.call.fact);
      return f?.kind === "call" ? targetPathPrefix(f.path) : "/";
    };
    const prefixes = [...new Set(asks.map(prefixOf))].sort(cmpText);
    if (!isTokenHost(host) || prefixes.length < 2) {
      groups.push({ host, asks, question: asks[0]!.question });
      continue;
    }
    for (const p of prefixes)
      groups.push({
        host,
        asks: asks.filter((a) => prefixOf(a) === p),
        question: forwardHostQuestion(host, input.repo, p),
      });
  }
  const out: JoinHostDraft[] = [];
  for (const { host, asks, question } of groups) {
    const calls = asks
      .map((a) => ({ id: a.call.fact, at: a.call.at, f: factOf.get(a.call.fact) }))
      .sort((a, b) => cmpNatural(a.at, b.at) || cmpText(a.id, b.id));
    const paths = calls.flatMap((c) => (c.f?.kind === "call" ? [c.f.path] : []));
    // A repo with an entry serving a path the calls make is offered first, with that entry.
    const byPath: { repo: string; serves: string }[] = [];
    for (const r of servers) {
      const hit = endpoints.find(
        (e) => compRepo.get(e.component) === r && paths.some((p) => servesPath(e.pathOrTopic, p)),
      );
      if (hit)
        byPath.push({
          repo: r,
          serves: [hit.method?.toUpperCase(), hit.pathOrTopic].filter(Boolean).join(" "),
        });
    }
    const evidence = [...new Set(calls.map((c) => c.at))].sort(cmpNatural);
    const factIds = [...new Set(calls.map((c) => c.id))].sort(cmpText);
    if (!isTokenHost(host)) {
      // A host as a hosts question asks it (ADR 0088): its answer writes the manifest or profile.
      const first = byPath.map((b) => b.repo);
      const ask: HostAsk = {
        host,
        calls: evidence.map((at) => ({ repo: input.repo, at })),
        servers: [...first, ...servers.filter((s) => !first.includes(s))],
        ...(byPath.length ? { byPath } : {}),
      };
      const [d] = hostQuestionDrafts([ask]);
      if (d) out.push({ step: HOSTS_STEP, host, factIds, draft: d.draft });
      continue;
    }
    const n = factIds.length;
    const them = n === 1 ? "The call" : `The ${n} calls`;
    const system = outsideSystemOfJoinHost(host);
    const rerun = `atticus verify ${input.repo} --write`;
    const serves = new Map(byPath.map((b) => [b.repo, b.serves] as const));
    const ranked = [...byPath.map((b) => b.repo), ...servers.filter((s) => !serves.has(s))];
    out.push({
      step: TARGETS_STEP_ID,
      host,
      factIds,
      draft: {
        // The join's words: for a gateway's token, what to read again (forwardHostQuestion).
        question,
        options: [
          ...ranked.map((r) => ({
            label: r,
            means: serves.has(r)
              ? `${r} serves ${serves.get(r)}, a path the calls on ${host} make`
              : `${r} serves HTTP`,
            changes: `${them} on ${host} ${n === 1 ? "joins" : "join"} ${r} when the facts are next written (${rerun})`,
          })),
          ...(
            [
              [HOSTS_OUTSIDE_INTERNAL, "internal", "another team's system"],
              [HOSTS_OUTSIDE_VENDOR, "vendor", "a vendor's system"],
            ] as const
          ).map(([label, boundary, what]) => ({
            label,
            means: `${host} stands for ${what}, outside this estate, that the org pack doesn't name yet`,
            changes: `A system ${system.id} (${system.name}, boundary ${boundary}) goes into the profile, and ${them.toLowerCase()} on ${host} ${n === 1 ? "goes" : "go"} to it when the facts are next written (${rerun})`,
          })),
          {
            label: HOSTS_NONE,
            means: `Neither a repo of this estate nor a system of the org pack answers on ${host}`,
            changes: `${them} on ${host} ${n === 1 ? "stays a loose end" : "stay loose ends"}, and this isn't asked again`,
          },
          ignoreOption(),
        ],
        evidence,
        scope: "repo",
      },
    });
  }
  return out;
}

/** Whether a question is a join host question of the targets step (beta.24 review). */
export const isJoinHostQuestion = (q: Question): boolean =>
  q.askedBy?.step === TARGETS_STEP_ID && joinHostOfQuestion(q) !== undefined;

/**
 * The target an answered join host question names for the calls it cites, as a targets answer's
 * label: the repo picked, the outside system its answer added (by the id `outsideSystemOfJoinHost`
 * gives it), or "None of these" for None and Ignore (the join leaves the calls). Undefined for a
 * question not answered, or not a join host question.
 */
export function joinHostTarget(q: Question): string | undefined {
  if (!isJoinHostQuestion(q) || q.state !== "answered" || !q.answer) return undefined;
  if (ignoredAnswer(q)) return HOSTS_NONE;
  const label =
    q.answer.option !== undefined ? q.options[q.answer.option - 1]?.label : q.answer.text;
  if (!label) return undefined;
  if (outsideBoundaryOf(label)) return outsideSystemOfJoinHost(joinHostOfQuestion(q)!).id;
  return label;
}

/**
 * Beta.24 review: whether an answered hosts question says Ignore for a call: the call's line is
 * one it cites, or the call's host (with its port, as a hosts question names it) is its host. The
 * join then leaves the call (answered-none), as for a targets question's Ignore.
 */
export function hostsIgnoreCovers(
  q: Question,
  call: { repo: string; at: string; hostLabel?: string | undefined },
): boolean {
  if (q.askedBy?.step !== HOSTS_STEP || q.state !== "answered" || !ignoredAnswer(q)) return false;
  return (
    (q.repo === call.repo && q.evidence.includes(call.at)) ||
    (!!call.hostLabel && hostOfQuestion(q) === call.hostLabel)
  );
}

/**
 * The open join host questions of a repo to retire after a write, each with why: those this write
 * no longer asks (the read since set the host, a person's answer elsewhere joins the calls, the
 * calls are gone). One whose host is asked now under another id (its calls changed) names it.
 * An answered question is never listed: its answer still names the calls' target. Beta.25: the
 * repo's open hosts questions too (`hostsOpen`), once the join asks about their host from no repo.
 */
export function staleJoinHostQuestions(input: {
  repo: string;
  open: readonly Question[];
  drafted: readonly { id: string; host: string }[];
  join?: FactsJoinResult;
  /**
   * Beta.25: the open hosts questions (`scan-hosts`) of the repo. One retires the same way when
   * the join no longer asks about its host from any repo (the profile or the manifest names it
   * now, the calls are gone), unless the scan's own asking still asks it (`stillAsked`).
   */
  hostsOpen?: readonly Question[];
  /** The ids of the hosts questions the scan's asking (`askHosts`) still asks, kept open. */
  stillAsked?: ReadonlySet<string>;
}): { id: string; why: string; replacedBy?: string[] }[] {
  const drafted = new Set(input.drafted.map((d) => d.id));
  const out: { id: string; why: string; replacedBy?: string[] }[] = [];
  const joinAsks = new Set(
    (input.join?.asks ?? []).flatMap((a) =>
      a.reason === "unknown-host" && a.host ? [a.host] : [],
    ),
  );
  // No join this write: it can't say it no longer asks.
  const hostsStep = (input.join ? (input.hostsOpen ?? []) : []).filter(
    (q) =>
      q.state === "open" &&
      q.repo === input.repo &&
      q.askedBy?.step === HOSTS_STEP &&
      !input.stillAsked?.has(q.id) &&
      !!hostOfQuestion(q) &&
      !joinAsks.has(hostOfQuestion(q)!),
  );
  for (const q of [...input.open, ...hostsStep]) {
    const isHostsStep = q.askedBy?.step === HOSTS_STEP;
    if (!isHostsStep && (q.state !== "open" || q.repo !== input.repo || !isJoinHostQuestion(q)))
      continue;
    if (drafted.has(q.id)) continue;
    const host = isHostsStep ? hostOfQuestion(q)! : joinHostOfQuestion(q)!;
    const by = input.drafted.filter((d) => d.host === host).map((d) => d.id);
    if (by.length) {
      out.push({
        id: q.id,
        why: `the calls on ${host} are asked now in ${by.join(", ")}`,
        replacedBy: by,
      });
      continue;
    }
    const at = new Set(q.evidence);
    const joined = (input.join?.joins ?? []).filter(
      (j) => j.call.repo === input.repo && at.has(j.call.at),
    );
    const outside = (input.join?.outside ?? []).filter(
      (o) => o.call.repo === input.repo && at.has(o.call.at),
    );
    const how = [
      ...new Set([
        ...joined.map((j) => `joins ${j.entry.component} in ${j.entry.repo}`),
        ...outside.map((o) => `goes to ${o.target}, outside the estate`),
      ]),
    ].sort(cmpText);
    out.push({
      id: q.id,
      why: how.length
        ? `the join no longer asks about ${host}: the call ${how.join("; ")}`
        : `the join no longer asks about ${host}: no call of ${input.repo} goes there now`,
    });
  }
  return out.sort((a, b) => cmpText(a.id, b.id));
}

/**
 * The questions whose answers name where calls go, as `targetsFromAnswers` reads them: every
 * targets question, and (beta.24 review) every hosts question, whose Ignore leaves its calls.
 */
export async function joinAnswerQuestions(root: string): Promise<Question[]> {
  const of = (step: string) =>
    listQuestions(root, { step }).then(
      (r) => r.questions,
      () => [] as Question[],
    );
  return [...(await of(TARGETS_STEP_ID)), ...(await of(HOSTS_STEP))];
}

/**
 * `joinAnswerQuestions` of a list already read (ADR 0195: a rename builds from its renamed
 * questions before it writes them): the targets questions, then the hosts questions, each in
 * `listQuestions`' order.
 */
export function joinAnswerQuestionsOf(all: readonly Question[]): Question[] {
  const sorted = [...all].sort(
    (a, b) => cmpText(a.askedBy.at, b.askedBy.at) || cmpText(a.id, b.id),
  );
  return [
    ...sorted.filter((q) => askedByStep(q, TARGETS_STEP_ID)),
    ...sorted.filter((q) => askedByStep(q, HOSTS_STEP)),
  ];
}
