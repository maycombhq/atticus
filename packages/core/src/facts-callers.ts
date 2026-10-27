import type { CatalogRecord } from "./catalog.js";
import { catalogAuth, factIdPart } from "./facts.js";
import {
  APIGEE_BUNDLE,
  basePathOf,
  FACING_WORDS,
  gatewayRouteId,
  servedPath,
  type FacingWords,
  type FactEnd,
  type FactJoin,
  type FactsJoinResult,
  type GatewayFacing,
  type JoinRepo,
} from "./facts-join.js";
import { interfaceId } from "./identity.js";
import type { EvidenceT } from "./schema/common.js";
import type { CallerKind, Fact, FactOf } from "./schema/facts.js";
import type { Profile } from "./schema/orgpack.js";

/**
 * Who a gateway route lets in (ADR 0124 addendum A-callers). A route's own files usually name
 * its consumers (the API product it belongs to, the developer apps subscribed to it, a client id
 * or certificate subject a check admits), and the reader records them on the route's entry fact
 * as `callers`, each cited. A caller whose repo is never scanned (another team's product) can't
 * be read at all, so a person declares it in the org pack's profile, as a System with the
 * gateway identity it calls as (or the route itself): that declaration links to the cited
 * consumer when the route's files name it, stays marked as a person's word, and never replaces
 * or removes anything the code says.
 *
 * For every route of the estate this gives the consumers its files name, the declared systems
 * that call it, the scanned calls that reach it, and whether nothing at all is known ("callers
 * unknown", which the critic asks about rather than passing). For each declared caller it gives
 * the chain the join reads from there: the person's word first, then each gateway hop, the
 * service, and on through the calls the service makes from that entry.
 *
 * Pure: the same facts, join and declarations give the same result.
 */

/** A route's consumer as its own files name it: what it is, its name, and the line naming it. */
export interface NamedCaller {
  as: CallerKind;
  name: string;
  /** path:line of the citation. */
  at: string;
}

/** A gateway route a person says an unscanned system calls (the org pack's profile). */
export interface DeclaredCallInput {
  system: string;
  name: string;
  boundary: "product" | "internal" | "vendor";
  owner?: string;
  /** The identity the gateway knows the caller by, as the route's files would name it. */
  as?: CallerKind;
  identity?: string;
  /** The route: its handler (`proxy/flow`) or `METHOD /path` as the gateway serves it. */
  route?: string;
  /** Where the person said it, relative to the org pack (`profiles/<platform>/profile.yaml`). */
  source: string;
}

/** A declared caller of one route: the person's word, and the cited consumer it links to. */
export interface DeclaredCaller {
  system: string;
  name: string;
  boundary: "product" | "internal" | "vendor";
  owner?: string;
  as?: CallerKind;
  identity?: string;
  route?: string;
  /** The consumer the route's files name that the declaration says it is; left out when none. */
  linked?: NamedCaller;
  by: "person";
  source: string;
}

export interface RouteCallers {
  /** The gateway route (its entry fact). */
  route: FactEnd;
  /** Its catalog GatewayRoute. */
  gatewayRoute: string;
  method?: string;
  path: string;
  /** The consumers the route's own files name, in the facts' order. */
  named: NamedCaller[];
  /** The systems a person declared as calling it. */
  declared: DeclaredCaller[];
  /** The calls of scanned repos that land on it (a gateway's forwarding call into it, too). */
  scanned: FactEnd[];
  /** Nothing names, declares or makes a call into the route: who calls it is a question. */
  unknown?: true;
}

/** One step of a declared caller's chain. */
export type ChainStep =
  | {
      kind: "declared";
      system: string;
      name: string;
      as?: CallerKind;
      identity?: string;
      /** Whether a cited consumer of the route is the identity the person named. */
      linked: boolean;
    }
  | {
      kind: "gateway";
      component: string;
      proxy: string;
      route: string;
      auth?: string;
      scopes: string[];
      facing?: GatewayFacing;
    }
  | { kind: "service"; component: string; method?: string; path: string; entry: FactEnd };

export interface CallerChain {
  system: string;
  /** The GatewayRoute of the first hop: the route the person says the system calls. */
  route: string;
  steps: ChainStep[];
}

/** A declaration the facts can't place: no route matches what it names. */
export interface DeclaredProblem {
  system: string;
  source: string;
  message: string;
}

export interface CallersResult {
  routes: RouteCallers[];
  chains: CallerChain[];
  problems: DeclaredProblem[];
}

export interface JoinCallersInput {
  repos: readonly JoinRepo[];
  /** The estate's join (`joinFacts`), whole: scanned callers come from it. */
  join: FactsJoinResult;
  declared?: readonly DeclaredCallInput[];
  /** The estate's facing words, as given to `joinFacts`. */
  facing?: FacingWords;
}

/** Every call a person declared in the org pack's profiles, one per route or identity named. */
export function declaredCallsOf(
  profiles: readonly { platform: string; profile?: Profile }[],
): DeclaredCallInput[] {
  const out: DeclaredCallInput[] = [];
  for (const p of [...profiles].sort((a, b) => cmp(a.platform, b.platform)))
    for (const s of p.profile?.systems ?? [])
      for (const c of s.calls ?? [])
        out.push({
          system: s.id,
          name: s.name,
          boundary: s.boundary,
          ...(s.owner ? { owner: s.owner } : {}),
          ...(c.as && c.name ? { as: c.as, identity: c.name } : {}),
          ...(c.route ? { route: c.route } : {}),
          source: `profiles/${p.platform}/profile.yaml`,
        });
  return out;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const key = (repo: string, id: string) => `${repo}\u0000${id}`;
type Entry = FactOf<"entry">;
type Node = { repo: string; component: string; fact: Fact };
const atOf = (f: { file: string; line: number }) => `${f.file}:${f.line}`;
const MAX_CHAIN = 8;

/** Who each gateway route of the estate lets in, and the chain from each declared caller. */
export function joinCallers(input: JoinCallersInput): CallersResult {
  const repos = [...input.repos].sort((x, y) => cmp(x.repo, y.repo));
  const nodes: Node[] = repos.flatMap((r) =>
    [...r.facts]
      .sort((x, y) => cmp(x.id, y.id))
      .map((f) => ({
        repo: r.repo,
        fact: f,
        component: factIdPart(f.component ?? r.component ?? r.repo),
      })),
  );
  const byKey = new Map(nodes.map((n) => [key(n.repo, n.fact.id), n] as const));
  const end = (n: Node): FactEnd => ({
    repo: n.repo,
    fact: n.fact.id,
    component: n.component,
    at: atOf(n.fact.cite),
  });
  const gateways = new Set(repos.filter((r) => r.gateway).map((r) => r.repo));
  const isRoute = (n: Node): n is Node & { fact: Entry } =>
    n.fact.kind === "entry" && (gateways.has(n.repo) || APIGEE_BUNDLE.test(n.fact.cite.file));
  const routes = nodes.filter(isRoute);

  // ---- the scanned calls into each route: a join that lands on it directly, the first hop of a
  // join through it, or the previous gateway's forwarding call for a later hop
  const scanned = new Map<string, FactEnd[]>();
  const into = (route: { repo: string; fact: string }, call: FactEnd) => {
    const k = key(route.repo, route.fact);
    const got = scanned.get(k) ?? [];
    if (!got.some((c) => c.repo === call.repo && c.fact === call.fact)) got.push(call);
    scanned.set(k, got);
  };
  for (const j of input.join.joins) {
    if (!j.gateway?.length) {
      into(j.entry, j.call);
      continue;
    }
    j.gateway.forEach((h, k) => into(h.entry, k === 0 ? j.call : j.gateway![k - 1]!.call));
  }

  // ---- what each route's own files name, and what people declared
  const named = (r: Node & { fact: Entry }): NamedCaller[] =>
    (r.fact.callers ?? []).map((c) => ({ as: c.as, name: c.value, at: atOf(c) }));
  const routeMatches = (r: Node & { fact: Entry }, said: string) => {
    const s = said.trim();
    if (r.fact.handler && s.toLowerCase() === r.fact.handler.toLowerCase()) return true;
    const m = /^([A-Za-z]+)\s+(\S+)$/.exec(s);
    return (
      !!m &&
      m[1]!.toUpperCase() === (r.fact.method ?? "ANY").toUpperCase() &&
      m[2]!.replace(/\/+$/, "") === r.fact.path.replace(/\/+$/, "")
    );
  };
  const problems: DeclaredProblem[] = [];
  const declaredOn = new Map<string, DeclaredCaller[]>();
  for (const d of input.declared ?? []) {
    const hits = routes.flatMap((r) => {
      const names = named(r);
      const link =
        d.as && d.identity ? names.find((n) => n.as === d.as && n.name === d.identity) : undefined;
      // A route the person names is theirs to name; an identity alone places the caller only on
      // the routes whose files name that identity.
      if (d.route ? !routeMatches(r, d.route) : !link) return [];
      return [{ r, link }];
    });
    if (!hits.length) {
      problems.push({
        system: d.system,
        source: d.source,
        message: d.route
          ? `${d.name} is declared to call ${d.route}, and no gateway route the facts hold is that route`
          : `${d.name} is declared to call as ${d.as} ${d.identity}, and no gateway route the facts hold names that ${d.as}`,
      });
      continue;
    }
    for (const { r, link } of hits) {
      const k = key(r.repo, r.fact.id);
      declaredOn.set(k, [
        ...(declaredOn.get(k) ?? []),
        {
          system: d.system,
          name: d.name,
          boundary: d.boundary,
          ...(d.owner ? { owner: d.owner } : {}),
          ...(d.as && d.identity ? { as: d.as, identity: d.identity } : {}),
          ...(d.route ? { route: d.route } : {}),
          ...(link ? { linked: link } : {}),
          by: "person",
          source: d.source,
        },
      ]);
    }
  }

  const out: RouteCallers[] = routes.map((r) => {
    const k = key(r.repo, r.fact.id);
    const n = named(r);
    const d = (declaredOn.get(k) ?? []).sort((a, b) => cmp(a.system, b.system));
    const s = (scanned.get(k) ?? []).sort((a, b) => cmp(a.repo, b.repo) || cmp(a.fact, b.fact));
    return {
      route: end(r),
      gatewayRoute: gatewayRouteId(r),
      ...(r.fact.method ? { method: r.fact.method.toUpperCase() } : {}),
      path: r.fact.path,
      named: n,
      declared: d,
      scanned: s,
      ...(n.length || d.length || s.length ? {} : { unknown: true as const }),
    };
  });

  // ---- each declared caller's chain: the route's hop, where it forwards, and on from there
  const words = input.facing ?? FACING_WORDS;
  const facingOf = (r: Node & { fact: Entry }): GatewayFacing | undefined => {
    const own = repos.find((x) => x.repo === r.repo)?.facing;
    if (own) return own;
    const proxy = r.fact.handler?.split("/")[0];
    const vh = nodes
      .filter(
        (n) =>
          n.repo === r.repo &&
          n.fact.kind === "config" &&
          /^virtualhost$/i.test(n.fact.key) &&
          !!proxy &&
          n.fact.target === proxy,
      )
      .sort((x, y) => cmp(x.fact.id, y.fact.id))[0];
    const v = vh?.fact.kind === "config" ? (vh.fact.value ?? "").toLowerCase() : "";
    if (!v) return undefined;
    const has = (list: readonly string[]) => list.some((w) => v.includes(w.toLowerCase()));
    return has(words.internal) ? "internal" : has(words.external) ? "external" : undefined;
  };
  const hopOf = (r: Node & { fact: Entry }): ChainStep => {
    const auth = catalogAuth(r.fact);
    const f = facingOf(r);
    return {
      kind: "gateway",
      component: r.component,
      proxy: r.fact.handler?.split("/")[0] || r.component,
      route: gatewayRouteId(r),
      ...(auth ? { auth } : {}),
      scopes: (r.fact.scopes ?? []).map((s) => s.value),
      ...(f ? { facing: f } : {}),
    };
  };
  const joinsOf = (repo: string, from: string) =>
    input.join.joins.filter((j) => {
      const c = byKey.get(key(j.call.repo, j.call.fact))?.fact;
      return j.call.repo === repo && c?.kind === "call" && c.from === from;
    });
  /** The one place the calls `from` a fact all join, else undefined. */
  const onward = (repo: string, from: string): FactJoin | undefined => {
    const js = joinsOf(repo, from).filter((j) => j.how !== "topic");
    if (!js.length) return undefined;
    const first = js[0]!;
    return js.every((j) => j.entry.repo === first.entry.repo && j.entry.fact === first.entry.fact)
      ? first
      : undefined;
  };
  const chains: CallerChain[] = [];
  for (const rc of out)
    for (const d of rc.declared) {
      const r = byKey.get(key(rc.route.repo, rc.route.fact)) as Node & { fact: Entry };
      const steps: ChainStep[] = [
        {
          kind: "declared",
          system: d.system,
          name: d.name,
          ...(d.as && d.identity ? { as: d.as, identity: d.identity } : {}),
          linked: !!d.linked,
        },
        hopOf(r),
      ];
      let at: { repo: string; fact: string } = rc.route;
      for (let n = 0; n < MAX_CHAIN; n++) {
        const j = onward(at.repo, at.fact);
        if (!j) break;
        for (const h of j.gateway ?? []) {
          const hr = byKey.get(key(h.entry.repo, h.entry.fact));
          if (hr && isRoute(hr)) steps.push(hopOf(hr));
        }
        const e = byKey.get(key(j.entry.repo, j.entry.fact));
        if (!e || e.fact.kind !== "entry") break;
        if (isRoute(e)) {
          // Joined at a gateway that forwards nowhere exact: the chain ends at that gateway.
          steps.push(hopOf(e));
          break;
        }
        steps.push({
          kind: "service",
          component: j.entry.component,
          ...(j.method ? { method: j.method } : {}),
          path: j.path,
          entry: j.entry,
        });
        at = j.entry;
      }
      chains.push({ system: d.system, route: rc.gatewayRoute, steps });
    }
  chains.sort(
    (a, b) => cmp(a.system, b.system) || cmp(chainText(a), chainText(b)) || cmp(a.route, b.route),
  );
  return {
    routes: out,
    chains,
    problems: problems.sort((a, b) => cmp(a.system, b.system) || cmp(a.message, b.message)),
  };
}

/** A chain in one line: `Harbor Desk (declared; app harbor-desk-portal) → edge-gateway … → …`. */
export function chainText(c: CallerChain): string {
  return c.steps
    .map((s) => {
      if (s.kind === "declared")
        return `${s.name} (declared${s.as ? `; ${s.as} ${s.identity}` : ""}${s.as && !s.linked ? ", which the gateway's files don't name" : ""})`;
      if (s.kind === "gateway") {
        const what = [
          ...(s.auth ? [s.auth] : []),
          s.scopes.length ? `scopes ${s.scopes.join(", ")}` : "no scope",
          ...(s.facing ? [s.facing] : []),
        ];
        return `${s.component} ${s.proxy} (${what.join("; ")})`;
      }
      return `${s.component} ${[s.method, s.path].filter(Boolean).join(" ")}`;
    })
    .join(" → ");
}

/**
 * The flag on a declared caller's Interface (A-callers): the person's word, made again from the
 * profile whenever the gateway is written, never kept on its own.
 */
export const DECLARED_CALLER = "declared-caller";

/** What each kind of consumer is as a C1 AccessGrant's subject. */
const SUBJECT_KIND: Record<CallerKind, "oauth-client" | "group" | "service-account"> = {
  app: "oauth-client",
  "client-id": "oauth-client",
  product: "group",
  subject: "service-account",
};

/**
 * The callers as C1 records, for the routes of `repos` (the gateway repos being written): one
 * AccessGrant per consumer a route names (its subject the identity, its resource the route's
 * GatewayRoute, the route's scopes, cited on the line that names it; `flags` say which kind of
 * identity it is), a GatewayRoute for a route no scanned call reaches (as `joinRecords` writes
 * one for a route a call goes through, with the API product a route belongs to as `product`),
 * and one Interface per declared caller: from the declared System to where the route forwards,
 * `via: gateway` through the route, `asserted`, its evidence the person's word (`manual`) beside
 * the route's line and the consumer line it links to. C1 as it is: no schema change.
 */
export function callerRecords(
  result: CallersResult,
  repos: readonly JoinRepo[],
  join: FactsJoinResult,
  o: { only?: readonly string[]; existing?: readonly CatalogRecord[] } = {},
): CatalogRecord[] {
  const facts = new Map<string, Fact>();
  for (const r of repos) for (const f of r.facts) facts.set(key(r.repo, f.id), f);
  const only = o.only ? new Set(o.only) : undefined;
  const have = new Map((o.existing ?? []).map((r) => [`${r.kind}|${r.id}`, r] as const));
  const out = new Map<string, CatalogRecord>();
  const put = (r: CatalogRecord) => out.set(`${r.kind}|${r.id}`, r);
  for (const rc of result.routes) {
    if (only && !only.has(rc.route.repo)) continue;
    const route = facts.get(key(rc.route.repo, rc.route.fact));
    if (route?.kind !== "entry") continue;
    const gev = (p: { file: string; line: number }): EvidenceT => ({
      source: "gateway",
      repo: rc.route.repo,
      path: p.file,
      line: p.line,
      commit: route.commit,
      side: "gateway",
      by: route.by,
    });
    const scopes = (route.scopes ?? []).map((s) => s.value);
    const products = rc.named.filter((n) => n.as === "product").map((n) => n.name);
    // Where the route forwards: the service (or the next gateway) its forwarding calls all join.
    const forwards = join.joins.filter((j) => {
      const c = facts.get(key(j.call.repo, j.call.fact));
      return j.call.repo === rc.route.repo && c?.kind === "call" && c.from === route.id;
    });
    const target =
      forwards.length &&
      forwards.every(
        (j) => j.entry.repo === forwards[0]!.entry.repo && j.entry.fact === forwards[0]!.entry.fact,
      )
        ? forwards[0]
        : undefined;
    const known = have.get(`GatewayRoute|${rc.gatewayRoute}`);
    // Every route of the gateway is a GatewayRoute, called or not: a route nothing names, declares
    // or calls is one the critic asks about ("callers unknown"), so it has to be there to be found.
    if (!known) {
      put({
        kind: "GatewayRoute",
        schemaVersion: 2,
        id: rc.gatewayRoute,
        status: "current",
        confidence: route.conf === "declared" ? "verified" : "inferred",
        proxy: route.handler?.split("/")[0] || rc.route.component,
        basepath: basePathOf(route),
        ...(target
          ? { target: target.gateway?.[0]?.entry.component ?? target.entry.component }
          : {}),
        policies: route.authCite ? [route.authCite.value] : [],
        scopes,
        ...(products.length === 1 ? { product: products[0] } : {}),
        evidence: once([
          gev(route.cite),
          ...(route.authCite ? [gev(route.authCite)] : []),
          ...(route.scopes ?? []).map(gev),
          // The forwarding calls, joined or not: a gateway's own call into the service is how the
          // critic finds the route a changed operation is carried by.
          ...[...facts.values()]
            .filter((f) => f.kind === "call" && f.repo === rc.route.repo && f.from === route.id)
            .sort((a, b) => cmp(a.id, b.id))
            .map((f) => gev(f.cite)),
        ]),
      } as CatalogRecord);
    } else if (known && products.length === 1 && known.kind === "GatewayRoute" && !known.product)
      put({ ...known, product: products[0] } as CatalogRecord);
    for (const c of route.callers ?? []) {
      const id = fit(`ag-${rc.gatewayRoute.replace(/^gw-/, "")}-${c.as}-${factIdPart(c.value)}`);
      put({
        kind: "AccessGrant",
        schemaVersion: 2,
        id,
        status: "current",
        confidence: route.conf === "declared" ? "verified" : "inferred",
        subjectKind: SUBJECT_KIND[c.as],
        subject: c.value,
        resource: rc.gatewayRoute,
        scopesOrPermissions: scopes,
        flags: [`caller:${c.as}`],
        evidence: once([gev(c), ...(c.with ?? []).map(gev)]),
      } as CatalogRecord);
    }
    for (const d of rc.declared) {
      const callee = target?.entry;
      const entry = callee ? facts.get(key(callee.repo, callee.fact)) : undefined;
      const toComponent = callee?.component ?? rc.route.component;
      const method = (target?.method ?? route.method)?.toUpperCase();
      const path =
        entry?.kind === "entry" ? servedPath(entry) : servedPath(route as FactOf<"entry">);
      const auth = catalogAuth(route) ?? (entry?.kind === "entry" ? catalogAuth(entry) : undefined);
      const linked = d.linked
        ? (route.callers ?? []).find((c) => atOf(c) === d.linked!.at)
        : undefined;
      put({
        kind: "Interface",
        schemaVersion: 2,
        id: interfaceId(d.system, toComponent, method, path),
        status: "current",
        confidence: "asserted",
        from: d.system,
        to: toComponent,
        via: "gateway",
        route: rc.gatewayRoute,
        ...(method ? { method } : {}),
        normalizedPath: path,
        ...(auth ? { auth } : {}),
        sync: "sync",
        direction: "outbound",
        conflicts: [],
        flags: [DECLARED_CALLER],
        evidence: once([
          { source: "manual", path: d.source, by: "person" },
          gev(route.cite),
          ...(linked ? [gev(linked)] : []),
        ]),
      } as CatalogRecord);
    }
  }
  return [...out.values()].sort((a, b) =>
    a.kind === b.kind ? cmp(a.id, b.id) : cmp(a.kind, b.kind),
  );
}

const fit = (id: string) => (id.length <= 120 ? id : id.slice(0, 120).replace(/[-.]+$/, ""));

function once(ev: EvidenceT[]): EvidenceT[] {
  const seen = new Set<string>();
  return ev.filter((e) => {
    const k = `${e.source}|${e.repo}|${e.path}|${e.line}|${e.side}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
