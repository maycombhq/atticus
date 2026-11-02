import type { CatalogRecord } from "./catalog.js";
import { factIdPart } from "./facts.js";
import {
  APIGEE_BUNDLE,
  gatewayRouteId,
  type FactEnd,
  type FactsJoinResult,
  type JoinRepo,
} from "./facts-join.js";
import type { EvidenceT } from "./schema/common.js";
import type { FactOf, TermRole } from "./schema/facts.js";
import { gatewayBundleTest } from "./schema/conventions.js";

/**
 * The organisation's terms across the estate (ADR 0163). A `term` fact records an identifier of
 * the organisation's own (a CMDB id, an application id) as a repo writes it, with the role a note
 * or the file's own words give it: `owner` (the value names the repo's own system), `consumer`
 * (it names a system the repo lets in), `none` or `unknown`. Atticus knows no term; it only
 * compares the values the facts cite, word for word:
 *
 * - an owner value ties its repo to its system;
 * - a consumer value points to the repo whose owner value is the same;
 * - the same value in two repos that no owner and consumer explain is a possible link: inferred,
 *   flagged, shown for a person to confirm;
 * - a repo's consumers are who its routes let in: on a gateway they become AccessGrants on its
 *   routes, so the critic names them when a route changes;
 * - and they are checked against the calls the join found: a repo calling the routes whose owner
 *   value isn't listed is a finding, a listed consumer that makes no call is a note.
 *
 * Pure: the same facts and join give the same result.
 */

/** A term as one repo writes it. */
export interface TermSeen extends FactEnd {
  term: string;
  value: string;
  role: TermRole;
  /** path:line of the line that gives it its role. */
  meaningAt?: string;
  note?: number | string;
}

/** A consumer a repo lists, and the repo whose own value it is, when one says so. */
export interface TermConsumer {
  listedBy: TermSeen;
  owner?: TermSeen;
}

/** The flag a possible link by a shared value carries: a guess for a person to confirm. */
export const LINKED_BY_TERM_VALUE = "linked-by-term-value";

/** The same value in two or more repos, which no owner and its consumers explain. */
export interface PossibleTermLink {
  value: string;
  seen: TermSeen[];
  inferred: true;
  flag: typeof LINKED_BY_TERM_VALUE;
}

/** A consumer let in to a route: an access grant, read from the route repo's term facts. */
export interface TermGrant {
  route: FactEnd;
  gatewayRoute: string;
  consumer: TermSeen;
  owner?: TermSeen;
}

/**
 * What the consumers a repo lists say against the calls the join found. `caller-not-listed`: a
 * repo calls its routes and none of its own values is listed (a finding); `listed-no-call`: a
 * listed consumer's repo is known and makes no call into them (a note).
 */
export type TermAccessFinding =
  | {
      reason: "caller-not-listed";
      repo: string;
      route: FactEnd;
      call: FactEnd;
      /** The caller's own values (owner terms), none of which is listed. */
      callerValues: string[];
      message: string;
    }
  | {
      reason: "listed-no-call";
      repo: string;
      consumer: TermSeen;
      owner: TermSeen;
      message: string;
    };

export interface TermsResult {
  /** Every term of the estate, by repo and fact id. */
  terms: TermSeen[];
  consumers: TermConsumer[];
  possible: PossibleTermLink[];
  grants: TermGrant[];
  access: TermAccessFinding[];
}

export interface JoinTermsInput {
  repos: readonly JoinRepo[];
  /** The estate's join (`joinFacts`), whole: the calls into each repo's routes come from it. */
  join?: FactsJoinResult;
  /** The gateway bundle folders (ADR 0147), as given to `joinFacts`. */
  bundleFolders?: readonly string[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const atOf = (f: { file: string; line: number }) => `${f.file}:${f.line}`;
type Term = FactOf<"term">;
type Entry = FactOf<"entry">;

/** Who owns, lists and shares each value, and what the lists say against the calls. */
export function joinTerms(input: JoinTermsInput): TermsResult {
  const repos = [...input.repos].sort((x, y) => cmp(x.repo, y.repo));
  const componentOf = (r: JoinRepo, f: { component?: string }) =>
    factIdPart(f.component ?? r.component ?? r.repo);
  const terms: TermSeen[] = repos.flatMap((r) =>
    r.facts
      .filter((f): f is Term => f.kind === "term")
      .sort((x, y) => cmp(x.id, y.id))
      .map((f) => ({
        repo: r.repo,
        fact: f.id,
        component: componentOf(r, f),
        at: atOf(f.cite),
        term: f.term,
        value: f.value,
        role: f.role,
        ...(f.meaning ? { meaningAt: atOf(f.meaning) } : {}),
        ...(f.note !== undefined ? { note: f.note } : {}),
      })),
  );
  const owners = new Map<string, TermSeen[]>();
  for (const t of terms)
    if (t.role === "owner") owners.set(t.value, [...(owners.get(t.value) ?? []), t]);
  /** The one repo a value is the own value of; none when two repos claim it. */
  const ownerOf = (value: string, not: string) => {
    const o = (owners.get(value) ?? []).filter((x) => x.repo !== not);
    return new Set(o.map((x) => x.repo)).size === 1 ? o[0] : undefined;
  };

  const consumers: TermConsumer[] = terms
    .filter((t) => t.role === "consumer")
    .map((t) => {
      const owner = ownerOf(t.value, t.repo);
      return { listedBy: t, ...(owner ? { owner } : {}) };
    });

  // ---- a value two repos write that no owner and its consumers explain
  const byValue = new Map<string, TermSeen[]>();
  for (const t of terms)
    if (t.role !== "none") byValue.set(t.value, [...(byValue.get(t.value) ?? []), t]);
  const possible: PossibleTermLink[] = [];
  for (const [value, seen] of [...byValue].sort(([a], [b]) => cmp(a, b))) {
    if (new Set(seen.map((s) => s.repo)).size < 2) continue;
    const ownerRepos = new Set(seen.filter((s) => s.role === "owner").map((s) => s.repo));
    const explained =
      ownerRepos.size === 1 &&
      seen.every((s) => s.role === "consumer" || (s.role === "owner" && ownerRepos.has(s.repo)));
    if (!explained) possible.push({ value, seen, inferred: true, flag: LINKED_BY_TERM_VALUE });
  }

  // ---- who each repo's routes let in, and the calls the join found into them
  const bundle = input.bundleFolders ? gatewayBundleTest(input.bundleFolders) : APIGEE_BUNDLE;
  const grants: TermGrant[] = [];
  const access: TermAccessFinding[] = [];
  for (const r of repos) {
    const listed = consumers.filter((c) => c.listedBy.repo === r.repo);
    if (!listed.length) continue;
    const routes = r.facts
      .filter((f): f is Entry => f.kind === "entry")
      .sort((x, y) => cmp(x.id, y.id))
      .map((f) => ({
        fact: f,
        end: { repo: r.repo, fact: f.id, component: componentOf(r, f), at: atOf(f.cite) },
        gateway: !!r.gateway || bundle.test(f.cite.file),
      }));
    for (const route of routes.filter((x) => x.gateway))
      for (const c of listed)
        grants.push({
          route: route.end,
          gatewayRoute: gatewayRouteId({ component: route.end.component, fact: route.fact }),
          consumer: c.listedBy,
          ...(c.owner ? { owner: c.owner } : {}),
        });
    if (!input.join) continue;
    const isRoute = (e: { repo: string; fact: string }) =>
      e.repo === r.repo && routes.some((x) => x.fact.id === e.fact);
    // The calls of other repos that land on these routes, directly or as a hop on the way.
    const into = input.join.joins
      .filter((j) => j.call.repo !== r.repo)
      .flatMap((j) => {
        const hit = isRoute(j.entry) ? j.entry : j.gateway?.find((h) => isRoute(h.entry))?.entry;
        return hit ? [{ call: j.call, route: hit }] : [];
      });
    const values = new Set(listed.map((c) => c.listedBy.value));
    const callers = new Set<string>();
    for (const { call, route } of into) {
      callers.add(call.repo);
      const own = terms
        .filter((t) => t.repo === call.repo && t.role === "owner")
        .map((t) => t.value);
      if (own.some((v) => values.has(v))) continue;
      access.push({
        reason: "caller-not-listed",
        repo: r.repo,
        route,
        call,
        callerValues: own,
        message: own.length
          ? `${call.repo} calls ${r.repo} (${call.at}), and its own ${plainList(own)} is not among the consumers ${r.repo} lists`
          : `${call.repo} calls ${r.repo} (${call.at}), which lists its consumers, and no fact of ${call.repo} names its own id to look for there`,
      });
    }
    for (const c of listed)
      if (c.owner && !callers.has(c.owner.repo))
        access.push({
          reason: "listed-no-call",
          repo: r.repo,
          consumer: c.listedBy,
          owner: c.owner,
          message: `${r.repo} lets in ${c.listedBy.value} (${c.owner.repo}, ${c.listedBy.at}), and no call of ${c.owner.repo} reaches it`,
        });
  }
  return { terms, consumers, possible, grants, access };
}

const plainList = (xs: readonly string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/** The flag a term's AccessGrant carries beside its `caller:<term>`, so it is told apart. */
export const termFlag = (term: string) => `term:${term}`;

/**
 * The consumers a gateway repo's term facts list, as C1 AccessGrants on its routes (ADR 0163):
 * one per consumer and route, the subject the value as written, the resource the route's
 * GatewayRoute, cited on the value's line and the line giving it its role. `caller:<term>` lets
 * the critic name them as a route's consumers when the route changes, as it names a route's own
 * callers (A-callers). C1 as it is: no schema change.
 */
export function termGrantRecords(
  result: TermsResult,
  repos: readonly JoinRepo[],
  o: { only?: readonly string[] } = {},
): CatalogRecord[] {
  const only = o.only ? new Set(o.only) : undefined;
  const factOf = new Map<string, Term>();
  for (const r of repos)
    for (const f of r.facts) if (f.kind === "term") factOf.set(`${r.repo}\u0000${f.id}`, f);
  const out = new Map<string, CatalogRecord>();
  for (const g of result.grants) {
    if (only && !only.has(g.route.repo)) continue;
    const f = factOf.get(`${g.consumer.repo}\u0000${g.consumer.fact}`);
    if (!f) continue;
    const ev = (p: { file: string; line: number }): EvidenceT => ({
      source: "gateway",
      repo: g.consumer.repo,
      path: p.file,
      line: p.line,
      commit: f.commit,
      side: "gateway",
      by: f.by,
    });
    const id = fit(
      `ag-${g.gatewayRoute.replace(/^gw-/, "")}-${factIdPart(f.term)}-${factIdPart(f.value)}`,
    );
    out.set(id, {
      kind: "AccessGrant",
      schemaVersion: 2,
      id,
      status: "current",
      confidence: f.conf === "declared" ? "verified" : "inferred",
      subjectKind: "oauth-client",
      subject: f.value,
      resource: g.gatewayRoute,
      scopesOrPermissions: [],
      flags: [`caller:${f.term}`, termFlag(f.term)],
      evidence: [
        ev(f.cite),
        ...(f.meaning && atOf(f.meaning) !== atOf(f.cite) ? [ev(f.meaning)] : []),
      ],
    } as CatalogRecord);
  }
  return [...out.values()].sort((a, b) => cmp(a.id, b.id));
}

const fit = (id: string) => (id.length <= 120 ? id : id.slice(0, 120).replace(/[-.]+$/, ""));

/**
 * The flag an owner term gives its repo's Component (ADR 0163): `term:<term>=<value>`, the
 * identifier the organisation knows the system by. `flags` is C1's existing optional field.
 */
export const ownerTermFlag = (term: string, value: string) => `term:${term}=${value}`;
