import { createHash } from "node:crypto";
import type { CatalogRecord } from "./catalog.js";
import { callPath, entryEndpointId, factIdPart } from "./facts.js";
import { hostQuestionText } from "./host-questions.js";
import { interfaceId } from "./identity.js";
import type { EvidenceT } from "./schema/common.js";
import type { Fact, FactOf } from "./schema/facts.js";
import { hostHasPort, hostMatches, urlHostPort } from "./schema/workspace.js";

/**
 * The estate join from facts (ADR 0124 addendum C-join): every call a repo's facts name, joined
 * to the entry of the repo that serves it, deterministically and with a citation at both ends.
 *
 * Which repo a call goes to is read, in order, from: a person's answer; the call's `to` (a
 * component, or a repo, of the estate); the host, or the base URL a config fact gives, that a
 * repo lists in the manifest (or a host whose first label is a component). A host nobody lists
 * is asked (`Which repo answers on <host>?`), never guessed, and a call whose `to` names an
 * outside system (or names something outside the estate and has a host) is left to that name.
 * A call with no host whose `to` names nothing in the estate (a relative call whose reader
 * guessed a name), or that names nothing, joins the one entry of the caller's own repo that
 * serves that method and path (or gRPC/SOAP name) in the same shape, else the one of the
 * estate, marked inferred; two or more is a question. A publish joins every listener of its topic.
 *
 * Then the fields that cross: a caller's request fields to the callee entry's, the callee's
 * response fields back, a message's to the listener's, by name (last dotted part, case, `_`
 * and `-` aside), each with the column the receiving side stores it in when a store under the
 * entry writes it (the field's `mappedTo`, else by name). A sent field nothing takes is a gap.
 *
 * Through a gateway (ADR 0124 addendum A-gateway): a call that lands on a gateway's route (an
 * entry of a repo the manifest types `gateway`, or one cited in an Apigee bundle) whose
 * forwarding calls (`from` the route) all join one entry joins that entry, with the path the
 * service receives after the gateway's rewrite, and keeps the hop (`gateway`: the route, its
 * forwarding call and the TargetServer or KVM config that ties it to a host). A route whose
 * forwarding call is asked or missed, or that forwards to several services, is joined at the
 * gateway, as before. A base whose config values (one per environment) are hosts different
 * repos answer on is asked, never one of them guessed.
 *
 * Pure: the same facts and answers give the same result, whatever order the repos come in.
 */

export interface JoinRepo {
  repo: string;
  facts: readonly Fact[];
  /** The component a fact with none belongs to (the manifest's); the repo when left out. */
  component?: string;
  /** Hosts the repo answers on (repos.manifest.yaml). */
  hosts?: readonly string[];
  /** Modules with hosts of their own (ADR 0057). */
  modules?: readonly { component: string; hosts: readonly string[] }[];
  /** An API gateway (the manifest's `type: gateway`): its entries are routes it forwards. */
  gateway?: boolean;
}

/** An Apigee proxy or shared flow bundle's file: its entries are gateway routes whatever the repo. */
export const APIGEE_BUNDLE = /(^|\/)(apiproxy|sharedflowbundle)\//;

/** The hop a call takes through a gateway: the route it lands on and the call that forwards it. */
export interface GatewayHop {
  /** The gateway's route (its entry fact). */
  entry: FactEnd;
  /** The gateway's forwarding call, whose path is the one the service receives. */
  call: FactEnd;
  /** The config fact (a TargetServer, a KVM entry) that ties the forwarding call to its host. */
  tie?: FactEnd;
  /** The catalog GatewayRoute of the route. */
  route: string;
}

/** One end of a join: a fact, its repo and component, and the line it cites. */
export interface FactEnd {
  repo: string;
  fact: string;
  component: string;
  /** path:line of the fact's citation. */
  at: string;
}

/**
 * How the callee was found: `answer` (a person named it), `named` (the call's `to` names the
 * component), `repo` (its `to` names the repo), `host` (a host or base URL the manifest lists,
 * or the component's own name as the host), `path` (no target named: the only entry of the
 * estate that serves it), `topic` (a listener of the published topic).
 */
export type JoinHow = "answer" | "named" | "repo" | "host" | "path" | "topic";

export interface FactJoin {
  call: FactEnd;
  entry: FactEnd;
  /** The config fact that gives the call's base URL, when one ties the call to the host. */
  tie?: FactEnd;
  how: JoinHow;
  /**
   * A join by path (the join fallback): nobody named the callee, so it is inferred. `within`
   * says where the one entry that serves the call was found: the caller's own repo first, else
   * the estate; `named` is the target the call gave, when it named one the estate doesn't have.
   */
  inferred?: { within: "repo" | "estate"; named?: string };
  /** The call went through a gateway's route to `entry` (A-gateway); `path` is the rewritten one. */
  gateway?: GatewayHop;
  callType: string;
  method?: string;
  /** The path, gRPC or SOAP name, or topic the entry serves, as the entry writes it. */
  path: string;
  /** The catalog Interface of the join. */
  interface: string;
}

export interface FactJoinAsk {
  call: FactEnd;
  /** `unknown-host`: no repo lists the host; `ambiguous`: more than one entry could answer. */
  reason: "unknown-host" | "ambiguous";
  host?: string;
  question: string;
  /** The entries that could answer (none for an unknown host). */
  candidates: FactEnd[];
}

/** A call whose named target (a repo or component of the estate) has no entry for it. */
export interface FactJoinMiss {
  call: FactEnd;
  target: string;
  message: string;
}

export interface FieldEnd {
  repo: string;
  fact: string;
  name: string;
}

/** A field crossing a join: the sender's field, the receiver's, and where the receiver stores it. */
export interface FieldLink {
  interface: string;
  side: "request" | "response" | "message";
  from: FieldEnd;
  to: FieldEnd;
  column?: { table: string; name: string; fact?: string; how: "mapped" | "name" };
}

/** A field sent (or expected back) that the other side's facts don't have. */
export interface FieldGap {
  interface: string;
  side: "request" | "response" | "message";
  field: FieldEnd;
  message: string;
}

export interface FactsJoinResult {
  joins: FactJoin[];
  asks: FactJoinAsk[];
  misses: FactJoinMiss[];
  lineage: FieldLink[];
  gaps: FieldGap[];
}

export interface JoinFactsInput {
  repos: readonly JoinRepo[];
  /** A person's answer naming the repo or component a call goes to: repo → call fact id → name. */
  targets?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * Outside systems (the org pack's vendors), by id: a call whose `to` names one keeps it and
   * is never joined by path to an entry of the estate.
   */
  outside?: readonly string[];
}

type Entry = FactOf<"entry">;
type Call = FactOf<"call">;
type Field = FactOf<"field">;
type Store = FactOf<"store">;
type Config = FactOf<"config">;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const at = (f: Fact) => `${f.cite.file}:${f.cite.line}`;
/** A field's name as compared: its last dotted part, letter case, `_` and `-` aside. */
export const fieldNameKey = (name: string) =>
  name
    .split(".")
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** Entry types each call type reaches. */
const SERVES: Record<string, readonly string[]> = {
  rest: ["rest", "webhook", "websocket", "sse"],
  soap: ["soap"],
  graphql: ["graphql"],
  grpc: ["grpc"],
  webhook: ["webhook", "rest"],
  sftp: ["file-drop"],
  "event-topic": ["event-topic"],
  "mq-queue": ["mq-queue"],
};
const EVENTS = new Set(["event-topic", "mq-queue"]);
const NAMED = new Set(["grpc", "soap"]);
/** Paths every service serves: a call to one with no target named joins nobody in particular. */
const GENERIC =
  /^\/(health|healthz|ready|readiness|live|liveness|ping|status|info|metrics|prometheus|actuator)(\/|$)/i;

/** Path segments as compared: lower case, parameters `{}`, a catch-all `**`. */
function segments(path: string): string[] | undefined {
  const p = (path.trim().split(/[?#]/, 1)[0] ?? "").replace(/\{([^}:?]*)[^}]*\}/g, "{$1}");
  if (!p.includes("/")) return undefined;
  return p
    .split("/")
    .filter(Boolean)
    .map((s) =>
      /^(\{\*[^}]*\}|\*\*|\{\*\*\})$/.test(s)
        ? "**"
        : /^(\{[^}]*\}|:[^/]+|<[^>]+>|\$\{[^}]*\})$/.test(s)
          ? "{}"
          : s.toLowerCase(),
    );
}

/**
 * How well a called path matches a served one: 1000 the same; 500 less one for each served
 * parameter standing for a literal of the call; 100 and up a catch-all route whose fixed part
 * starts the call; the length of the shorter when it ends the other with a plain segment (a
 * context path or base path in front); else 0.
 */
export function routeScore(called: string, served: string): number {
  const a = segments(called);
  const b = segments(served);
  if (!a || !b) return 0;
  const star = b.indexOf("**");
  if (star >= 0) {
    const fixed = b.slice(0, star);
    return fixed.some((s) => s !== "{}") &&
      a.length >= fixed.length &&
      fixed.every((s, i) => s === "{}" || s === a[i])
      ? 100 + fixed.length
      : 0;
  }
  if (a.length === b.length) {
    if (a.every((s, i) => s === b[i])) return 1000;
    let loose = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (b[i] === "{}" && a[i] !== "{}") loose++;
      else return 0;
    }
    return a.some((s, i) => s === b[i] && s !== "{}") ? 500 - loose : 0;
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  if (!short.some((s) => s !== "{}")) return 0;
  const tail = long.slice(long.length - short.length);
  return tail.every((s, i) => s === short[i]) ? short.length : 0;
}

/** How well a called gRPC or SOAP name matches a served one: the same, or the same short service and method. */
export function nameScore(called: string, served: string): number {
  const norm = (s: string) => s.trim().replace(/^\/+/, "").toLowerCase();
  const a = norm(called);
  const b = norm(served);
  if (!a.includes("/") || !b.includes("/")) return 0;
  if (a === b) return 1000;
  const [as, am] = a.split("/");
  const [bs, bm] = b.split("/");
  return am === bm && as!.split(".").pop() === bs!.split(".").pop() ? 500 : 0;
}

const sameMethod = (a: string | undefined, b: string | undefined) => {
  const x = a?.toUpperCase();
  const y = b?.toUpperCase();
  return !x || !y || x === "ANY" || y === "ANY" || x === y;
};

/** The question for a call no single repo answers: the same words as the facts-targets question. */
export function callTargetQuestion(f: Call, component: string): string {
  const what = [f.method?.toUpperCase(), f.path].filter(Boolean).join(" ");
  return `Which repo or system answers ${what}, which ${component} calls${f.base ? ` through ${f.base}` : ""}?`;
}

const SECRETISH = /^(env:|vault:|secret:|ref:|\$\{|\{\{)/i;

/** A host written as a URL or as `name[:port]`; `named` is the port the text writes, if any. */
function hostIn(
  s: string | undefined,
): { host: string; port?: number; named?: number } | undefined {
  if (!s || SECRETISH.test(s.trim())) return undefined;
  const u = urlHostPort(s.trim());
  if (u) {
    const named = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?[^/?#:]*:(\d+)/i.exec(s.trim())?.[1];
    return u.host ? { ...u, ...(named ? { named: Number(named) } : {}) } : undefined;
  }
  const m = /^([a-z0-9][a-z0-9.-]*)(?::(\d+))?$/i.exec(s.trim());
  return m
    ? {
        host: m[1]!.toLowerCase(),
        ...(m[2] ? { port: Number(m[2]), named: Number(m[2]) } : {}),
      }
    : undefined;
}

interface Node {
  repo: string;
  fact: Fact;
  component: string;
}

/** Join every call of the estate's facts to the entry that serves it, or say why not. */
export function joinFacts(input: JoinFactsInput): FactsJoinResult {
  const repos = [...input.repos].sort((x, y) => cmp(x.repo, y.repo));
  const componentOf = (r: JoinRepo, f: Fact) => factIdPart(f.component ?? r.component ?? r.repo);
  const nodes: Node[] = [];
  for (const r of repos)
    for (const f of [...r.facts].sort((x, y) => cmp(x.id, y.id)))
      nodes.push({ repo: r.repo, fact: f, component: componentOf(r, f) });
  const key = (repo: string, id: string) => `${repo}\u0000${id}`;
  const byKey = new Map(nodes.map((n) => [key(n.repo, n.fact.id), n] as const));
  const end = (n: Node): FactEnd => ({
    repo: n.repo,
    fact: n.fact.id,
    component: n.component,
    at: at(n.fact),
  });
  const entries = nodes.filter((n): n is Node & { fact: Entry } => n.fact.kind === "entry");
  const components = new Set(nodes.map((n) => n.component));
  for (const r of repos) components.add(factIdPart(r.component ?? r.repo));
  const repoIds = new Map(repos.map((r) => [factIdPart(r.repo), r.repo] as const));
  const declared = repos.flatMap((r) => [
    ...(r.modules ?? []).flatMap((m) =>
      m.hosts.map((h) => ({ pattern: h, repo: r.repo, component: factIdPart(m.component) })),
    ),
    ...(r.hosts ?? []).map((h) => ({ pattern: h, repo: r.repo, component: undefined })),
  ]);
  const claimed = (h: { host: string; port?: number }) =>
    declared.find((d) => hostHasPort(d.pattern) && hostMatches(d.pattern, h.host, h.port)) ??
    declared.find((d) => !hostHasPort(d.pattern) && hostMatches(d.pattern, h.host, h.port));

  const outside = new Set((input.outside ?? []).map(factIdPart));
  const joins: FactJoin[] = [];
  const asks: FactJoinAsk[] = [];
  const misses: FactJoinMiss[] = [];

  /** The entries of a scope that serve a call, best first: score and node. */
  const serving = (c: Node & { fact: Call }, inScope: (e: Node) => boolean, loose: boolean) => {
    const types = SERVES[c.fact.callType] ?? [];
    const scored: { e: Node & { fact: Entry }; score: number }[] = [];
    for (const e of entries) {
      if (e.component === c.component || !types.includes(e.fact.entryType) || !inScope(e)) continue;
      if (!sameMethod(c.fact.method, e.fact.method)) continue;
      const score = NAMED.has(c.fact.callType)
        ? nameScore(c.fact.path, e.fact.path)
        : routeScore(c.fact.path, e.fact.path);
      // With no target named, only an entry of the same shape counts (no prefix or catch-all).
      if (score > 0 && (!loose || score >= 400)) scored.push({ e, score });
    }
    const best = Math.max(0, ...scored.map((s) => s.score));
    return scored.filter((s) => s.score === best).map((s) => s.e);
  };

  for (const c of nodes) {
    if (c.fact.kind !== "call") continue;
    const call = c as Node & { fact: Call };
    const f = call.fact;
    if (EVENTS.has(f.callType)) {
      if (/^(subscribe|consume|listen)$/i.test(f.method ?? "")) continue;
      for (const e of entries)
        if (
          e.fact.entryType === f.callType &&
          e.component !== call.component &&
          e.fact.path === f.path
        )
          joins.push({
            call: end(call),
            entry: end(e),
            how: "topic",
            callType: f.callType,
            path: e.fact.path,
            interface: interfaceId(call.component, e.component, undefined, e.fact.path),
          });
      continue;
    }
    if (!SERVES[f.callType]) continue;

    // The config fact that gives the call's base URL ties it to a host.
    const configs = nodes
      .filter(
        (n): n is Node & { fact: Config } =>
          n.repo === call.repo &&
          n.fact.kind === "config" &&
          !!f.base &&
          n.fact.key === f.base &&
          !!hostIn(n.fact.value),
      )
      .sort((x, y) => cmp(x.fact.id, y.fact.id));
    const tieNode = configs[0];
    const tie = tieNode ? { tie: end(tieNode) } : {};
    const host =
      hostIn(f.host) ?? (tieNode ? hostIn(tieNode.fact.value) : undefined) ?? hostIn(f.base);

    const answer = input.targets?.[call.repo]?.[f.id];
    const named = (name: string) => {
      const slug = factIdPart(name);
      // A repo's name covers all its components; a component's, only that one.
      const repo = repoIds.get(slug);
      if (repo) return { scope: (e: Node) => e.repo === repo, target: repo, repo: true };
      if (components.has(slug)) return { scope: (e: Node) => e.component === slug, target: slug };
      return undefined;
    };
    // A base whose values (a TargetServer or KVM entry per environment) are hosts different repos
    // answer on: which one is meant is asked, not taken from the first (A-gateway).
    if (!answer && !hostIn(f.host) && !(f.to && named(f.to)) && configs.length > 1) {
      const owners = new Map<string, (e: Node) => boolean>();
      for (const n of configs) {
        const d = claimed(hostIn(n.fact.value)!);
        if (d)
          owners.set(
            d.component ? `c:${d.component}` : `r:${d.repo}`,
            d.component ? (e) => e.component === d.component : (e) => e.repo === d.repo,
          );
      }
      if (owners.size > 1) {
        asks.push({
          call: end(call),
          reason: "ambiguous",
          question: callTargetQuestion(f, call.component),
          candidates: [...owners.values()]
            .flatMap((s) => serving(call, s, false))
            .map(end)
            .sort((x, y) => cmp(x.repo, y.repo) || cmp(x.fact, y.fact)),
        });
        continue;
      }
    }
    let scope: { scope: (e: Node) => boolean; target: string } | undefined;
    let how: JoinHow | undefined;
    if (answer) {
      scope = named(answer);
      if (!scope) continue; // a vendor or "none": nothing in the estate to join
      how = "answer";
    } else if (f.to && named(f.to)) {
      const n = named(f.to)!;
      scope = n;
      how = n.repo ? "repo" : "named";
    } else if (host && claimed(host)) {
      const d = claimed(host)!;
      scope = d.component
        ? { scope: (e) => e.component === d.component, target: d.component }
        : { scope: (e) => e.repo === d.repo, target: d.repo };
      how = "host";
    } else if (host && components.has(factIdPart(host.host.split(".")[0]!))) {
      const comp = factIdPart(host.host.split(".")[0]!);
      scope = { scope: (e) => e.component === comp, target: comp };
      how = "host";
    } else if (f.to && (host || outside.has(factIdPart(f.to)))) {
      continue; // a target outside the estate (a vendor, a cloud service): the call keeps it
    } else if (host) {
      const h = host.named ? `${host.host}:${host.named}` : host.host;
      asks.push({
        call: end(call),
        reason: "unknown-host",
        host: h,
        question: hostQuestionText(h),
        candidates: [],
      });
      continue;
    } else {
      // The join fallback: no host, and a target that names nothing in the estate (a relative
      // call's guessed name) or none. The one entry of the caller's own repo that serves it,
      // else of the estate; two or more is a question.
      if (GENERIC.test(f.path)) continue;
      how = "path";
    }

    let within: "repo" | "estate" | undefined;
    let hits: (Node & { fact: Entry })[];
    if (how === "path") {
      within = "repo";
      hits = serving(call, (e) => e.repo === call.repo, true);
      if (hits.length === 0) {
        within = "estate";
        hits = serving(call, () => true, true);
      }
    } else hits = serving(call, scope?.scope ?? (() => true), false);
    if (hits.length === 1) {
      const e = hits[0]!;
      joins.push({
        call: end(call),
        entry: end(e),
        ...tie,
        how,
        ...(within ? { inferred: { within, ...(f.to ? { named: f.to } : {}) } } : {}),
        callType: f.callType,
        ...(f.method || e.fact.method
          ? { method: (f.method ?? e.fact.method)!.toUpperCase() }
          : {}),
        path: e.fact.path,
        interface: interfaceOf(call, e),
      });
    } else if (hits.length > 1) {
      asks.push({
        call: end(call),
        reason: "ambiguous",
        question: callTargetQuestion(f, call.component),
        candidates: hits.map(end).sort((x, y) => cmp(x.repo, y.repo) || cmp(x.fact, y.fact)),
      });
    } else if (scope) {
      const what = [f.method?.toUpperCase(), f.path].filter(Boolean).join(" ");
      misses.push({
        call: end(call),
        target: scope.target,
        message: `${call.component} calls ${what} on ${scope.target}, and no entry of ${scope.target} the facts name serves it`,
      });
    }
  }

  // ---- through a gateway (A-gateway): a call that lands on a route joins where the route forwards
  const gateways = new Set(repos.filter((r) => r.gateway).map((r) => r.repo));
  const isRoute = (n: Node) =>
    n.fact.kind === "entry" && (gateways.has(n.repo) || APIGEE_BUNDLE.test(n.fact.cite.file));
  const joinsOf = new Map<string, FactJoin[]>();
  for (const j of joins) {
    const k = key(j.call.repo, j.call.fact);
    joinsOf.set(k, [...(joinsOf.get(k) ?? []), j]);
  }
  for (const [i, j] of joins.entries()) {
    if (j.how === "topic") continue;
    const route = byKey.get(key(j.entry.repo, j.entry.fact))!;
    if (!isRoute(route)) continue;
    const forwards = nodes.filter(
      (n): n is Node & { fact: Call } =>
        n.repo === route.repo &&
        n.fact.kind === "call" &&
        n.fact.from === route.fact.id &&
        !EVENTS.has(n.fact.callType),
    );
    // Each forwarding call joined to one entry, and all to the same one; else joined at the gateway.
    const hops = forwards.map((n) => joinsOf.get(key(n.repo, n.fact.id)) ?? []);
    if (!hops.length || hops.some((h) => h.length !== 1)) continue;
    const lands = hops.map((h) => h[0]!);
    const hop = lands[0]!;
    if (lands.some((l) => l.entry.repo !== hop.entry.repo || l.entry.fact !== hop.entry.fact))
      continue;
    const callee = byKey.get(key(hop.entry.repo, hop.entry.fact))! as Node & { fact: Entry };
    const caller = byKey.get(key(j.call.repo, j.call.fact))! as Node & { fact: Call };
    if (callee.component === caller.component) continue;
    const forward = byKey.get(key(hop.call.repo, hop.call.fact))!.fact as Call;
    const method = (forward.method ?? caller.fact.method ?? callee.fact.method)?.toUpperCase();
    joins[i] = {
      call: j.call,
      entry: hop.entry,
      ...(j.tie ? { tie: j.tie } : {}),
      how: j.how,
      ...(j.inferred ? { inferred: j.inferred } : {}),
      gateway: {
        entry: j.entry,
        call: hop.call,
        ...(hop.tie ? { tie: hop.tie } : {}),
        route: gatewayRouteId(route as Node & { fact: Entry }),
      },
      callType: j.callType,
      ...(method ? { method } : {}),
      path: callee.fact.path,
      interface: interfaceId(caller.component, callee.component, method, servedPath(callee.fact)),
    };
  }

  // ---- the fields that cross each join
  const fieldsOf = (repo: string, owner: string) =>
    nodes.filter(
      (n): n is Node & { fact: Field } =>
        n.repo === repo && n.fact.kind === "field" && n.fact.owner === owner,
    );
  const sideOf = (f: Field) => f.side ?? "request";
  const fieldEnd = (n: Node & { fact: Field }): FieldEnd => ({
    repo: n.repo,
    fact: n.fact.id,
    name: n.fact.name,
  });
  /** Where an entry's field is stored: its mappedTo column, else a column of that name a store under the entry writes. */
  const columnOf = (repo: string, entry: string, field: Field): FieldLink["column"] => {
    const tableOf = (s: Store) => `${factIdPart(s.store)}.${factIdPart(s.name)}`;
    if (field.mappedTo) {
      const col = byKey.get(key(repo, field.mappedTo))?.fact;
      const store = col?.kind === "field" ? byKey.get(key(repo, col.owner))?.fact : undefined;
      if (col?.kind === "field" && store?.kind === "store")
        return { table: tableOf(store), name: col.name, fact: col.id, how: "mapped" };
    }
    const want = fieldNameKey(field.name);
    for (const n of nodes) {
      const s = n.fact;
      if (n.repo !== repo || s.kind !== "store" || s.under !== entry || s.op !== "write") continue;
      const col = fieldsOf(repo, s.id).find((x) => fieldNameKey(x.fact.name) === want);
      if (col) return { table: tableOf(s), name: col.fact.name, fact: col.fact.id, how: "name" };
      const named = (s.columns ?? []).find((x) => fieldNameKey(x) === want);
      if (named) return { table: tableOf(s), name: named, how: "name" };
    }
    return undefined;
  };
  const lineage: FieldLink[] = [];
  const gaps: FieldGap[] = [];
  for (const j of joins) {
    const callNode = byKey.get(key(j.call.repo, j.call.fact))! as Node & { fact: Call };
    const sent = fieldsOf(j.call.repo, j.call.fact);
    const took = fieldsOf(j.entry.repo, j.entry.fact);
    const event = j.how === "topic";
    const what = event
      ? callNode.fact.path
      : [callNode.fact.method?.toUpperCase(), callNode.fact.path].filter(Boolean).join(" ");
    const outward = event ? (["message"] as const) : (["request"] as const);
    for (const side of outward) {
      const mine = sent.filter((x) => sideOf(x.fact) === side);
      const theirs = took.filter((x) => sideOf(x.fact) === side);
      for (const s of mine) {
        const t = theirs.find((x) => fieldNameKey(x.fact.name) === fieldNameKey(s.fact.name));
        if (t) {
          const column = columnOf(j.entry.repo, j.entry.fact, t.fact);
          lineage.push({
            interface: j.interface,
            side,
            from: fieldEnd(s),
            to: fieldEnd(t),
            ...(column ? { column } : {}),
          });
        } else if (theirs.length)
          gaps.push({
            interface: j.interface,
            side,
            field: fieldEnd(s),
            message: `${j.call.component} sends ${s.fact.name} to ${what}, and no ${side} field of ${j.entry.component}'s entry takes it`,
          });
      }
    }
    if (event) continue;
    const back = took.filter((x) => sideOf(x.fact) === "response");
    for (const s of sent.filter((x) => sideOf(x.fact) === "response")) {
      const t = back.find((x) => fieldNameKey(x.fact.name) === fieldNameKey(s.fact.name));
      if (t)
        lineage.push({
          interface: j.interface,
          side: "response",
          from: fieldEnd(t),
          to: fieldEnd(s),
        });
      else if (back.length)
        gaps.push({
          interface: j.interface,
          side: "response",
          field: fieldEnd(s),
          message: `${j.call.component} reads ${s.fact.name} from ${what}, and no response field of ${j.entry.component}'s entry returns it`,
        });
    }
  }

  const byEnds = (x: { call: FactEnd }, y: { call: FactEnd }) =>
    cmp(x.call.repo, y.call.repo) || cmp(x.call.fact, y.call.fact);
  return {
    joins: joins.sort(
      (x, y) => byEnds(x, y) || cmp(x.entry.repo, y.entry.repo) || cmp(x.entry.fact, y.entry.fact),
    ),
    asks: asks.sort(byEnds),
    misses: misses.sort(byEnds),
    lineage: lineage.sort(
      (x, y) =>
        cmp(x.interface, y.interface) ||
        cmp(x.side, y.side) ||
        cmp(x.from.fact, y.from.fact) ||
        cmp(x.to.fact, y.to.fact),
    ),
    gaps: gaps.sort(
      (x, y) =>
        cmp(x.interface, y.interface) || cmp(x.side, y.side) || cmp(x.field.fact, y.field.fact),
    ),
  };
}

/** The path a joined Interface records: the entry's, normalised (a gRPC or SOAP name as written). */
function servedPath(e: Entry): string {
  return NAMED.has(e.entryType) ? callPath(e.entryType, e.path) : callPath("rest", e.path);
}

function interfaceOf(c: Node & { fact: Call }, e: Node & { fact: Entry }): string {
  const method = (c.fact.method ?? e.fact.method)?.toUpperCase();
  return interfaceId(c.component, e.component, method, servedPath(e.fact));
}

const MAX_ID = 120;
const fitId = (id: string, base: string) =>
  id.length <= MAX_ID
    ? id
    : `${base}.${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 16)}`;

/**
 * Evidence with each line once (a route and its forwarding call may cite the same `<Condition>`),
 * so a record reads the same whichever write merged it.
 */
function once(ev: EvidenceT[]): EvidenceT[] {
  const seen = new Set<string>();
  return ev.filter((e) => {
    const k = `${e.source}|${e.repo}|${e.path}|${e.line}|${e.side}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A gateway route's GatewayRoute id: `gw-<component>-<method>-<path>`, no dots (as a hop names one). */
function gatewayRouteId(n: Node & { fact: Entry }): string {
  const id = `gw-${factIdPart(`${n.component} ${n.fact.method ?? ""} ${n.fact.path}`)}`
    .replace(/-{2,}/g, "-")
    .replace(/-$/, "");
  return fitId(id, `gw-${n.component}`).replace(/\./g, "-");
}

/**
 * A route's base path: the part of its citation (`cite.with`) its path starts with (an Apigee
 * `<BasePath>`), else its whole path.
 */
function basePathOf(e: Entry): string {
  const segs = (p: string) => p.split(/[?#]/, 1)[0]!.split("/").filter(Boolean);
  const path = segs(e.path);
  const base = (e.cite.with ?? [])
    .map((p) => segs(p.value))
    .filter((s) => s.length > 0 && s.length < path.length && s.every((x, k) => x === path[k]))
    .sort((a, b) => b.length - a.length)[0];
  return base ? `/${base.join("/")}` : e.path;
}

/**
 * The joins as C1 records: an Interface per call joined to an entry (a publish to each
 * listener, as the merge would pair them), citing the caller's call, the config that ties it to
 * the host and the callee's entry; and a FieldMapping per field that crosses, and
 * per column the receiving side stores a field in. Mappings by name are inferred, by `mappedTo`
 * verified.
 */
export function joinRecords(result: FactsJoinResult, repos: readonly JoinRepo[]): CatalogRecord[] {
  const facts = new Map<string, Fact>();
  for (const r of repos) for (const f of r.facts) facts.set(`${r.repo}\u0000${f.id}`, f);
  const fact = (e: { repo: string; fact: string }) => facts.get(`${e.repo}\u0000${e.fact}`);
  const ev = (
    e: { repo: string; fact: string },
    source: EvidenceT["source"],
    side?: EvidenceT["side"],
  ): EvidenceT[] => {
    const f = fact(e);
    if (!f) return [];
    return [
      {
        source,
        repo: e.repo,
        path: f.cite.file,
        line: f.cite.line,
        commit: f.commit,
        ...(side ? { side } : {}),
        by: f.by,
      },
    ];
  };
  const out = new Map<string, CatalogRecord>();
  for (const j of result.joins) {
    if (j.how === "topic") {
      // As the merge pairs a publish with a listener: via the bus, async, at the topic.
      const call = fact(j.call) as Call;
      const entry = fact(j.entry) as Entry;
      out.set(j.interface, {
        kind: "Interface",
        schemaVersion: 2,
        id: j.interface,
        status: "current",
        confidence: call.conf === "declared" && entry.conf === "declared" ? "verified" : "inferred",
        from: j.call.component,
        to: j.entry.component,
        endpoint: entryEndpointId(entry, j.entry.component),
        via: call.callType === "mq-queue" ? "mq" : "event-bus",
        normalizedPath: j.path,
        sync: "async",
        direction: "outbound",
        conflicts: [],
        evidence: [...ev(j.call, "code", "caller"), ...ev(j.entry, "code", "callee")],
      } as CatalogRecord);
      continue;
    }
    const call = fact(j.call) as Call;
    const entry = fact(j.entry) as Entry;
    if (j.gateway) {
      // Through a gateway (A-gateway): the caller to the service, via the route, which the
      // GatewayRoute records; the auth a caller meets is the route's, else the service's.
      const g = j.gateway;
      const route = fact(g.entry) as Entry;
      const forward = fact(g.call) as Call;
      const declared = [call, entry, route, forward].every((f) => f.conf === "declared");
      const confidence = declared ? "verified" : "inferred";
      const auth = route.auth ?? entry.auth;
      out.set(j.interface, {
        kind: "Interface",
        schemaVersion: 2,
        id: j.interface,
        status: "current",
        confidence,
        from: j.call.component,
        to: j.entry.component,
        ...(entry.entryType !== "rest"
          ? { endpoint: entryEndpointId(entry, j.entry.component) }
          : {}),
        via: "gateway",
        route: g.route,
        ...(j.method ? { method: j.method } : {}),
        normalizedPath: servedPath(entry),
        ...(auth ? { auth } : {}),
        sync: call.sync ?? "sync",
        direction: "outbound",
        conflicts: [],
        evidence: once([
          ...ev(j.call, "code", "caller"),
          ...(j.tie ? ev(j.tie, "config", "caller") : []),
          ...ev(g.entry, "gateway", "gateway"),
          ...ev(g.call, "gateway", "gateway"),
          ...(g.tie ? ev(g.tie, "config", "gateway") : []),
          ...ev(j.entry, "code", "callee"),
        ]),
      } as CatalogRecord);
      if (!out.has(g.route)) {
        const authAt = route.authCite
          ? [
              {
                source: "gateway" as const,
                repo: g.entry.repo,
                path: route.authCite.file,
                line: route.authCite.line,
                commit: route.commit,
                side: "gateway" as const,
                by: route.by,
              },
            ]
          : [];
        out.set(g.route, {
          kind: "GatewayRoute",
          schemaVersion: 2,
          id: g.route,
          status: "current",
          confidence: route.conf === "declared" ? "verified" : "inferred",
          proxy: route.handler?.split("/")[0] || g.entry.component,
          basepath: basePathOf(route),
          target: j.entry.component,
          policies: route.authCite ? [route.authCite.value] : [],
          scopes: [],
          evidence: once([
            ...ev(g.entry, "gateway", "gateway"),
            ...authAt,
            ...ev(g.call, "gateway", "gateway"),
          ]),
        } as CatalogRecord);
      }
      continue;
    }
    const declared = call.conf === "declared" && entry.conf === "declared";
    const method = (call.method ?? entry.method)?.toUpperCase();
    out.set(j.interface, {
      kind: "Interface",
      schemaVersion: 2,
      id: j.interface,
      status: "current",
      confidence: declared ? "verified" : "inferred",
      from: j.call.component,
      to: j.entry.component,
      ...(entry.entryType !== "rest"
        ? { endpoint: entryEndpointId(entry, j.entry.component) }
        : {}),
      via: call.callType === "webhook" ? "webhook" : call.callType === "sftp" ? "sftp" : "direct",
      ...(method ? { method } : {}),
      normalizedPath: servedPath(entry),
      ...(entry.auth ? { auth: entry.auth } : {}),
      sync: call.sync ?? "sync",
      direction: "outbound",
      conflicts: [],
      evidence: [
        ...ev(j.call, "code", "caller"),
        ...(j.tie ? ev(j.tie, "config", "caller") : []),
        ...ev(j.entry, "code", "callee"),
      ],
    } as CatalogRecord);
  }
  const mapping = (
    iface: string,
    id: string,
    source: string,
    target: string,
    how: "mapped" | "name",
    evidence: EvidenceT[],
  ) => {
    const rid = fitId(id, iface);
    if (out.has(rid) || evidence.length === 0) return;
    out.set(rid, {
      kind: "FieldMapping",
      schemaVersion: 2,
      id: rid,
      status: "current",
      confidence: how === "mapped" ? "verified" : "inferred",
      interface: iface,
      sourceField: source,
      targetField: target,
      evidence,
    } as CatalogRecord);
  };
  for (const l of result.lineage) {
    mapping(
      l.interface,
      `${l.interface}.${l.side}.${factIdPart(l.from.name)}-to-${factIdPart(l.to.name)}`,
      l.from.name,
      l.to.name,
      "name",
      [...ev(l.from, "code"), ...ev(l.to, "code")],
    );
    if (!l.column) continue;
    const store = repos
      .find((r) => r.repo === l.to.repo)
      ?.facts.find(
        (f): f is Store =>
          f.kind === "store" && `${factIdPart(f.store)}.${factIdPart(f.name)}` === l.column!.table,
      );
    const tableName = store?.name ?? l.column.table.split(".").pop()!;
    mapping(
      l.interface,
      `${l.interface}.column.${factIdPart(l.to.name)}-to-${factIdPart(`${tableName}-${l.column.name}`)}`,
      l.to.name,
      `${tableName}.${l.column.name}`,
      l.column.how,
      [
        ...ev(l.to, "code"),
        ...(l.column.fact ? ev({ repo: l.to.repo, fact: l.column.fact }, "migration") : []),
      ],
    );
  }
  return [...out.values()].sort((a, b) =>
    a.kind === b.kind ? cmp(a.id, b.id) : cmp(a.kind, b.kind),
  );
}
