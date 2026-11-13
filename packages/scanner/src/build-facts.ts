import {
  cmpText,
  declaredCallsOf,
  factIdPart,
  helperOn,
  hostMatches,
  joinCallers,
  joinConventions,
  joinFactsSteps,
  runSteps,
  runStepsAsync,
  joinTerms,
  NO_TARGET,
  normalizePath,
  parseRecord,
  placeholderIn,
  preferredEnvironment,
  termGrantRecords,
  urlHostPort,
  type CatalogRecord,
  type Fact,
  type FactJoinMiss,
  type FactsJoinResult,
  type FlowRecord,
  type JoinAi,
  type JoinRepo,
  type OrgPack,
  type PersonPair,
  type TermsResult,
} from "@maycombhq/core";
import {
  applyFactJoins,
  componentRenames,
  entryText,
  factsRecords,
  joinAbout,
  joinReposOf,
  outsideProfileSystems,
  outsideSystems,
  remapIds,
} from "./facts-catalog.js";
import { estateRepos, isPrototypeRepo } from "./merge-input.js";

/**
 * The repos read from their facts in one build (ADR 0195 point 2): every current facts slot
 * projected at once, with nothing read from the catalog and nothing patched. The component
 * renames, the estate join, the gateway callers and the term grants are worked out over all of
 * them together, so the result is the same whatever order the repos were verified in. It replaces
 * `catalogWithFacts`'s incremental patch on the catalog it found (the `existing` drop and the
 * second `applyCurated`) for every writer.
 */

type Ev = { repo?: string; path?: string; line?: number; side?: string; source: string };

/** One repo read from its facts: its current facts slot, the targets and the pairings named for its calls. */
export interface FactsEstateRepo {
  repo: string;
  facts: readonly Fact[];
  targets?: Readonly<Record<string, string>>;
  pairs?: Readonly<Record<string, PersonPair>>;
  aiTargets?: Readonly<Record<string, JoinAi>>;
}

export interface FactsEstateProjection {
  /** Every fact repo's projected records (before the join). */
  records: CatalogRecord[];
  /** The repos as the join reads them (components made estate-unique). */
  repos: JoinRepo[];
  /** The whole estate's join, worked out once (point 2.3). */
  whole: FactsJoinResult;
  terms: TermsResult;
  per: Map<
    string,
    {
      facts: Fact[];
      projected: ReturnType<typeof factsRecords>["projected"];
      newRecords: CatalogRecord[];
      newFlows: FlowRecord[];
      looseFact: Map<string, string>;
      targets: Readonly<Record<string, string>>;
    }
  >;
  /** Projected ids a join remaps to its Interface, and the callee a call-out step reaches. */
  remap: Map<string, string>;
  stepTo: Map<string, { component: string; entry: string }>;
  /** Listeners a topic join pairs with a publish: their own loose end goes. */
  heard: Set<string>;
}

export function factsEstateRecords(
  op: OrgPack,
  given: readonly FactsEstateRepo[],
): FactsEstateProjection {
  return runSteps(factsEstateRecordsSteps(op, given));
}

/**
 * Beta.28.1: factsEstateRecords giving way after each repo it projects and inside the estate
 * join (joinFactsSteps), so a build that awaits `tick` there (the write's progress) lets its
 * heartbeat, its lines and a Stop through. The same projection either way.
 */
export function factsEstateRecordsAsync(
  op: OrgPack,
  given: readonly FactsEstateRepo[],
  tick: () => Promise<void>,
): Promise<FactsEstateProjection> {
  return runStepsAsync(factsEstateRecordsSteps(op, given), tick);
}

function* factsEstateRecordsSteps(
  op: OrgPack,
  given: readonly FactsEstateRepo[],
): Generator<void, FactsEstateProjection, void> {
  // A prototype is compared with the estate, never part of it (ADR 0133).
  const list = [...given]
    .filter((x) => !isPrototypeRepo(op, x.repo))
    .sort((a, b) => cmpText(a.repo, b.repo));
  const renames = componentRenames(list, op);
  const per: FactsEstateProjection["per"] = new Map();
  const records: CatalogRecord[] = [];
  for (const r of list) {
    const p = factsRecords({
      repo: r.repo,
      facts: r.facts,
      op,
      ...(r.targets ? { targets: r.targets } : {}),
      renames,
    });
    per.set(r.repo, {
      facts: p.facts,
      projected: p.projected,
      newRecords: p.newRecords,
      newFlows: p.newFlows,
      looseFact: p.looseFact,
      targets: r.targets ?? {},
    });
    records.push(...p.newRecords);
    yield;
  }
  const repos = joinReposOf(
    op,
    list.map((r) => ({ repo: r.repo, facts: per.get(r.repo)!.facts })),
    renames,
  );
  const whole = yield* joinFactsSteps({
    repos,
    targets: Object.fromEntries(list.map((r) => [r.repo, r.targets ?? {}])),
    pairs: Object.fromEntries(list.map((r) => [r.repo, r.pairs ?? {}])),
    aiTargets: Object.fromEntries(list.map((r) => [r.repo, r.aiTargets ?? {}])),
    outside: outsideSystems(op),
    ...joinConventions(op),
    // G4: the walk through gateways is a stack helper (ATTICUS_HELPERS_OFF=gateway-walk).
    walkGateways: helperOn("gateway-walk"),
  });
  const terms = joinTerms({ repos, join: whole, bundleFolders: joinConventions(op).bundleFolders });
  // A publish names its first listener's Interface (sorted), whatever repo was written first.
  const remap = new Map<string, string>();
  const stepTo = new Map<string, { component: string; entry: string }>();
  for (const j of whole.joins) {
    const id = per.get(j.call.repo)?.projected.ids[j.call.fact];
    if (!id || remap.has(id)) continue;
    remap.set(id, j.interface);
    stepTo.set(id, { component: j.entry.component, entry: entryText(j) });
  }
  const heard = new Set(
    whole.joins
      .filter((j) => j.how === "topic")
      .map((j) => `${j.entry.repo}|${j.entry.at}|${j.entry.component}`),
  );
  return { records, repos, whole, terms, per, remap, stepTo, heard };
}

/**
 * The estate join put into a build's code records (point 2.3): what a joined call made goes, the
 * joins' Interfaces and the gateway callers come in, and the term grants are added. Run once over
 * every repo's records, readers' and facts' alike, before the merge.
 */
export function withFactsEstateJoins(
  records: readonly CatalogRecord[],
  op: OrgPack,
  p: FactsEstateProjection,
): CatalogRecord[] {
  const joined = applyFactJoins(records, p.whole, p.repos, {
    callers: joinCallers({
      repos: p.repos,
      join: p.whole,
      declared: declaredCallsOf(op.profiles),
      ...joinConventions(op),
    }),
    join: p.whole,
  });
  return [...toOutsideHosts(joined, op, p), ...termGrantRecords(p.terms, p.repos)];
}

/** A host as an outside system's alias may be written: labels and dots, a port maybe. */
const HOST_ALIAS = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i;

/** A URL's own path (`https://host/api/v1` gives `/api/v1`), its trailing slash off. */
const urlPathIn = (url: string | undefined): string | undefined => {
  const m = url ? /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+(\/[^?#]*)/i.exec(url.trim()) : null;
  const p = m?.[1]?.replace(/\/+$/, "");
  return p ? p : undefined;
};

/**
 * The review of beta.27: a call whose own host is still a token (a gateway's forwarding call to
 * `@targetVendorUrl@`, or one whose lines alone write it) that the join leaves to an outside
 * system by a host the profile lists as that system's alias (O1, J2) is written as a call to that
 * host, so the merge draws it to the system as it draws a call that names the host itself. It
 * was left a loose end with the token for its host, and the Map drew no arrow. A target that
 * isn't a listed alias (a host only the call's settings give, a name a person answered) is left
 * as it was: the merge would take an unlisted host's first label for a component. Its review:
 * only an alias exactly one outside system lists, and never a host an estate repo or module
 * declares (the merge would draw it to that repo, or guess a component by its label); and the
 * target URL's own path (`/api/v1`, from the token's setting for that host) stays in front of the
 * route's, so the arrow says the path the vendor receives.
 */
function toOutsideHosts(
  records: readonly CatalogRecord[],
  op: OrgPack,
  p: FactsEstateProjection,
): CatalogRecord[] {
  // Each host alias, with the outside systems that list it: only one that names exactly one is
  // that system's, and never a host an estate repo or one of its modules answers on (the merge
  // would then draw the call to that repo, or take the host's first label for a component).
  const owners = new Map<string, Set<string>>();
  for (const s of outsideProfileSystems(op))
    for (const n of [s.name, ...s.aliases])
      if (HOST_ALIAS.test(n)) {
        const k = n.toLowerCase();
        owners.set(k, (owners.get(k) ?? new Set()).add(s.id));
      }
  const estateHosts = estateRepos(op).flatMap((r) => [
    ...(r.hosts ?? []),
    ...(r.modules ?? []).flatMap((m) => m.hosts ?? []),
  ]);
  const declared = (host: string) => {
    const hp = /^(.*):(\d+)$/.exec(host);
    return estateHosts.some((pat) =>
      hostMatches(pat, hp ? hp[1]! : host, hp ? Number(hp[2]) : undefined),
    );
  };
  const raw = new Map<string, string>();
  for (const o of p.whole.outside ?? []) {
    const target = o.target.toLowerCase();
    if (owners.get(target)?.size !== 1 || declared(target)) continue;
    const x = p.per.get(o.call.repo);
    const f = x?.facts.find((y) => y.id === o.call.fact);
    if (!x || f?.kind !== "call" || !["rest", "soap"].includes(f.callType)) continue;
    // Only a call whose own host is a token or missing: one that names a host keeps its URL.
    if (f.host && !/@[^@\s]+@|\{\{[^}]+\}\}|\$\{/.test(f.host)) continue;
    const u = [...x.looseFact].find(([, fact]) => fact === f.id)?.[0];
    if (!u) continue;
    const path = f.path.startsWith("/") ? f.path : `/${f.path}`;
    // The target URL's own path (`https://api.northwind-pay.example/api/v1`) stays in front of
    // the route's: the setting of the call's token whose host is this one says it.
    // The review of beta.27: when the environments set this host with different paths (dv
    // /api/v1, prod /api/v2), the arrow takes the prod-like environment's, else the first by name
    // (core's preferredEnvironment, the rule the Outside systems page names), never the first
    // fact's.
    const token = f.host?.trim();
    const sets = x.facts.filter(
      (c): c is Extract<typeof c, { kind: "config" }> =>
        c.kind === "config" &&
        !!token &&
        (c.key === token || c.key === placeholderIn(token)?.name) &&
        urlHostPort(c.value ?? "")?.host === target,
    );
    const env = preferredEnvironment(sets.flatMap((c) => (c.env ? [c.env] : [])));
    // Re-review: the same order as the join's (path, then id), so the Map and the Outside page agree.
    const byPathThenId = (a: (typeof sets)[number], b: (typeof sets)[number]) => {
      const pa = urlPathIn(a.value) ?? "";
      const pb = urlPathIn(b.value) ?? "";
      return pa < pb ? -1 : pa > pb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    };
    const set =
      [...sets].filter((c) => env !== undefined && c.env === env).sort(byPathThenId)[0] ??
      [...sets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    const basePath = set?.kind === "config" ? urlPathIn(set.value) : undefined;
    const full =
      basePath && path !== basePath && !path.startsWith(`${basePath}/`)
        ? `${basePath}${path === "/" ? "" : path}`
        : path;
    raw.set(u, `${f.method?.toUpperCase() ?? "ANY"} https://${o.target}${full}`);
  }
  if (!raw.size) return [...records];
  return records.map((r) =>
    r.kind === "Unresolved" && raw.has(r.id)
      ? ({ ...r, unresolvedKind: "http-call", raw: raw.get(r.id)! } as CatalogRecord)
      : r,
  );
}

/** Records after the merge, without the loose end of a listener a topic join paired with a publish. */
export function withoutHeardListeners(
  records: readonly CatalogRecord[],
  p: FactsEstateProjection | undefined,
): CatalogRecord[] {
  if (!p?.heard.size) return [...records];
  return records.filter(
    (r) =>
      !(
        r.kind === "Unresolved" &&
        r.unresolvedKind === "event-subscribe" &&
        (r.evidence as Ev[]).some((e) => p.heard.has(`${e.repo}|${e.path}:${e.line}|${r.owner}`))
      ),
  );
}

export interface FactsRepoAfterMerge {
  /** The repo's flows, with the catalog's ids, for specs/<repo>/. */
  flows: FlowRecord[];
  /** Its loose call records: Unresolved id → call fact id. */
  looseFact: Map<string, string>;
  /** The part of the estate join about it. */
  join: FactsJoinResult;
}

/**
 * The fact repos after the merge (point 2): the endpoint ids the merge gave and the Interfaces
 * loose calls became, put into schemas, schema refs and field mappings; and per repo its flows
 * with the catalog's ids, its loose calls and the part of the join about it.
 */
export function factsEstateAfterMerge(
  merged: readonly CatalogRecord[],
  p: FactsEstateProjection,
): { records: CatalogRecord[]; repos: Map<string, FactsRepoAfterMerge> } {
  const remap = new Map(p.remap);
  const endpoints = merged.filter(
    (r): r is Extract<CatalogRecord, { kind: "Endpoint" }> => r.kind === "Endpoint",
  );
  const stillLoose = new Set(merged.filter((r) => r.kind === "Unresolved").map((r) => r.id));
  const joinedTo = new Map<string, Map<string, string>>();
  for (const [repo, x] of p.per) {
    for (const r of x.projected.records) {
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
    const to = new Map<string, string>();
    for (const [id] of x.looseFact) {
      if (stillLoose.has(id)) continue;
      const rec = x.newRecords.find((r) => r.id === id);
      if (!rec) continue;
      const at = (rec.evidence as Ev[])[0];
      const iface = merged.find(
        (r) =>
          r.kind === "Interface" &&
          r.from === (rec as { owner?: string }).owner &&
          (r.evidence as Ev[]).some(
            (e) => e.repo === repo && e.path === at?.path && e.line === at?.line,
          ),
      ) as Extract<CatalogRecord, { kind: "Interface" }> | undefined;
      if (iface) {
        remap.set(id, iface.id);
        to.set(id, iface.to);
      }
    }
    joinedTo.set(repo, to);
  }
  const re = remapIds(remap);
  const records = merged.map((r): CatalogRecord => {
    if (r.kind === "Schema") return { ...r, id: re(r.id), ref: re(r.ref) };
    if (r.kind === "Endpoint" && r.schemaRefs.length)
      return { ...r, schemaRefs: r.schemaRefs.map(re).sort() };
    if (r.kind === "FieldMapping") return { ...r, interface: re(r.interface) };
    return r;
  });
  const out = new Map<string, FactsRepoAfterMerge>();
  for (const [repo, x] of p.per) {
    const to = joinedTo.get(repo)!;
    const flows = x.newFlows.map((f): FlowRecord => {
      const next = {
        ...f,
        trigger: { ...f.trigger, ...(f.trigger.ref ? { ref: re(f.trigger.ref) } : {}) },
        steps: f.steps.map((s) => {
          const was = s.to?.component;
          const direct = s.refs.map((r) => p.stepTo.get(r)).find((y) => !!y);
          const dest =
            s.to && direct
              ? { ...s.to, ...direct }
              : s.to && was && to.has(was)
                ? { ...s.to, component: to.get(was)! }
                : s.to;
          return { ...s, refs: s.refs.map(re), ...(dest ? { to: dest } : {}) };
        }),
      };
      const parsed = parseRecord(next);
      return (parsed.ok ? parsed.record : next) as FlowRecord;
    });
    out.set(repo, {
      flows: flows.sort((a, b) => cmpText(a.id, b.id)),
      looseFact: x.looseFact,
      join: joinAbout(p.whole, repo),
    });
  }
  return { records, repos: out };
}

/** ADR 0162 (F8), for one repo of a build: an answer the code now disagrees with, about a call of it or into it. */
export function answerMissesOf(p: FactsEstateProjection, repo: string): FactJoinMiss[] {
  const named = Object.fromEntries([...p.per].map(([r, x]) => [r, x.targets]));
  const mine = new Set([
    factIdPart(repo),
    ...p.repos
      .filter((r) => r.repo === repo)
      .flatMap((r) => [r.component, ...(r.modules ?? []).map((m) => m.component)])
      .filter((x): x is string => !!x)
      .map(factIdPart),
    ...(p.per.get(repo)?.facts ?? []).flatMap((f) =>
      f.component ? [factIdPart(f.component)] : [],
    ),
  ]);
  return p.whole.misses.filter((m) => {
    const t = named[m.call.repo]?.[m.call.fact];
    return !!t && t !== NO_TARGET && (m.call.repo === repo || mine.has(factIdPart(m.target)));
  });
}
