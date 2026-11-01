import { createHash } from "node:crypto";
import type { CatalogRecord } from "./catalog.js";
import { callPath, catalogAuth, entryEndpointId, factIdPart } from "./facts.js";
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
 * service receives after the gateway's rewrite, and keeps the hop (the route, its forwarding
 * call and the TargetServer or KVM config that ties it to a host). A route whose forwarding call
 * is asked or missed, or that forwards to several services, is joined at the gateway, as before.
 * A base whose config values (one per environment) are hosts different repos answer on is asked,
 * never one of them guessed.
 *
 * Through several gateways (A-gateway2): where a route forwards into another gateway's route, the
 * walk goes on, so `gateway` is the hops in order (caller → gateway A → gateway B → service) and
 * `path` is what the last one's target receives. Each hop keeps its own auth and the `scopes` its
 * route demands, and is marked `internal` or `external` when something says which: the repo's
 * manifest type (`gateway-external`, `gateway-internal`), else the proxy's own `VirtualHost`
 * config fact. Nothing says, the hop is just a gateway. The walk is bounded (`MAX_GATEWAY_HOPS`)
 * and a route that forwards back into a gateway already in the path is a question (`cycle`), not
 * a loop; a walk that runs past the bound is a question too. The join stops at the last gateway
 * whose next hop is asked, missed or forwards to several services, exactly as one hop does.
 *
 * Placeholders (J0): a base URL, host or topic written as `${X}`, `${X:default}` or `env:X` is
 * each value the config facts setting `X` give it, read in the caller's repo and in any repo of
 * the estate whose setting is for the caller's component (its folder, its deployment, its
 * `component` or `target`); a placeholder nothing sets takes its default. Every value a manifest
 * host or base path claims is accepted, values claimed by different repos are asked, and the join
 * cites the lines used (`through`). No model.
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
  /** The path its routes sit under on its hosts, when they are shared (ADR 0134). */
  basePath?: string;
  /** Modules with hosts of their own (ADR 0057), and their base paths (ADR 0134). */
  modules?: readonly { component: string; hosts: readonly string[]; basePath?: string }[];
  /** An API gateway (the manifest's `type: gateway`): its entries are routes it forwards. */
  gateway?: boolean;
  /**
   * Which side of the organisation this gateway faces, when the manifest's repo type says
   * (`gateway-external`, `gateway-internal`): a hop through it is marked so (A-gateway2). Left
   * out, the proxy's own `VirtualHost` config fact is read instead, and failing that the hop is
   * just a gateway.
   */
  facing?: GatewayFacing;
}

/** An Apigee proxy or shared flow bundle's file: its entries are gateway routes whatever the repo. */
export const APIGEE_BUNDLE = /(^|\/)(apiproxy|sharedflowbundle)\//;

/** Whether a gateway hop stays inside the organisation or faces a partner or the internet. */
export type GatewayFacing = "internal" | "external";

/**
 * How far the walk through gateways goes before it gives up and asks (A-gateway2). Four is a
 * gateway at each of three boundaries and one more: past that, nobody means it.
 */
export const MAX_GATEWAY_HOPS = 4;

/** The words a `VirtualHost` (or a manifest repo type) uses for each side (A-gateway2). */
export interface FacingWords {
  internal: readonly string[];
  external: readonly string[];
}

/**
 * The default words, overridable per estate (`joinFacts`'s `facing`), because which virtual host
 * means which side is each estate's own convention. A value that says neither leaves the hop a
 * plain gateway: the join never guesses from a basepath or a host's shape.
 */
export const FACING_WORDS: FacingWords = {
  internal: ["internal", "private", "intranet", "inside"],
  external: ["external", "partner", "public", "internet", "egress"],
};

/** The hop a call takes through a gateway: the route it lands on and the call that forwards it. */
export interface GatewayHop {
  /** The gateway's route (its entry fact). */
  entry: FactEnd;
  /** The gateway's forwarding call, whose path is the one the next hop or the service receives. */
  call: FactEnd;
  /** The config fact (a TargetServer, a KVM entry) that ties the forwarding call to its host. */
  tie?: FactEnd;
  /** J0: the config facts that set the tie's placeholder, as `FactJoin.through`. */
  through?: FactEnd[];
  /** J1: the exposure facts the forwarding call's host or base path came from, as `FactJoin.exposedBy`. */
  exposedBy?: FactEnd[];
  /** The catalog GatewayRoute of the route. */
  route: string;
  /** The auth a caller meets at this hop, when the route's facts say (A-gateway2). */
  auth?: string;
  /** The scopes this hop's route demands of the caller's token, in the facts' order (A-gateway2). */
  scopes?: string[];
  /** Which side this gateway faces, when the manifest or the proxy's virtual host says. */
  facing?: GatewayFacing;
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
 * F3: the target a person gave a call by answering "None of these": nothing in the estate
 * answers it. Not a name (no fact id has brackets), so it never names a component, and the call
 * is neither joined by path nor asked again.
 */
export const NO_TARGET = "(none)";

/** F2: an Interface's flags when nobody named its callee: found by path, or by a host's first label. */
export const JOINED_BY_PATH = "joined-by-path";
export const JOINED_BY_LABEL = "joined-by-label";
/**
 * C1 (ADR 0135): how a join nobody had to guess found its callee, as the Interface's flags, so
 * the app can say why two services are linked from the record alone: a person's answer, the
 * component or the repo the call names, or a host the manifest lists. A publish joined to its
 * listener carries none (its `via`, the bus, says it). These say how, never that something is
 * missing: the guesses (`joined-by-path`, `joined-by-label`) are the only join flags that are gaps.
 */
export const JOINED_BY_ANSWER = "joined-by-answer";
export const JOINED_BY_NAME = "joined-by-name";
export const JOINED_BY_REPO = "joined-by-repo";
export const JOINED_BY_HOST = "joined-by-host";
/** Flags that say how a link was made and nothing more: never a gap (C1, ADR 0135). */
export const JOIN_HOW_FLAGS: ReadonlySet<string> = new Set([
  JOINED_BY_ANSWER,
  JOINED_BY_NAME,
  JOINED_BY_REPO,
  JOINED_BY_HOST,
  // A-callers: a person declared who calls a gateway route (`DECLARED_CALLER`, facts-callers).
  "declared-caller",
]);

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
  /**
   * J0: where the tie's value is a placeholder (`${PAYMENTS_URL}`, `${X:default}`, `env:X`), or a
   * topic is, the config facts that set it, in the caller's repo or in a deploy or config repo of
   * the estate, each environment's line the join used; with every other tie that gave the same
   * callee. Left out when the value is written where the call reads it.
   */
  through?: FactEnd[];
  /** J0: the config facts that set a listener's placeholder topic (`${LEDGER_TOPIC}`). */
  entryThrough?: FactEnd[];
  how: JoinHow;
  /**
   * J1 (ADR 0143): the exposure facts (a Route's, an Ingress's, a Helm value's, a proxy's
   * BasePath) whose host or base path the call's matched, when the manifest alone didn't give
   * them. Left out when the manifest's hosts and base paths were all it took.
   */
  exposedBy?: FactEnd[];
  /**
   * A join by path (the join fallback): nobody named the callee, so it is inferred. `within`
   * says where the one entry that serves the call was found: the caller's own repo first, else
   * the estate; `named` is the target the call gave, when it named one the estate doesn't have.
   */
  inferred?: { within: "repo" | "estate"; named?: string };
  /**
   * F2: the host named no repo; its first label happened to be a component's name. A guess, so
   * the Interface is inferred and flagged `joined-by-label`.
   */
  byLabel?: true;
  /**
   * The gateway hops the call went through to reach `entry`, in the order it meets them
   * (A-gateway, many hops in A-gateway2); `path` is what the last hop's target receives. Left
   * out when the call reaches the entry directly.
   */
  gateway?: GatewayHop[];
  /**
   * Every scope the call's token must hold to get through, the hops' in order, each once
   * (A-gateway2). Left out when no hop demands one.
   */
  scopes?: string[];
  callType: string;
  method?: string;
  /** The path, gRPC or SOAP name, or topic the entry serves, as the entry writes it. */
  path: string;
  /** The catalog Interface of the join. */
  interface: string;
}

export interface FactJoinAsk {
  call: FactEnd;
  /**
   * `unknown-host`: no repo lists the host; `ambiguous`: more than one entry could answer;
   * `cycle`: the gateway routes the call passes through lead back into a gateway it has already
   * been through, so where the call ends can't be read from the facts (A-gateway2).
   */
  reason: "unknown-host" | "ambiguous" | "cycle";
  host?: string;
  question: string;
  /** The entries that could answer (none for an unknown host). */
  candidates: FactEnd[];
}

/**
 * J1 (ADR 0143): what an exposure fact says that the estate can't take as it is. `no-component`:
 * its `exposes` names no component or repo of the estate, so nothing is joined by it.
 * `host-conflict`: the manifest lists hosts for the component and the fact's is none of them;
 * `base-path-conflict`: the manifest gives a base path and the fact another. Both values are
 * joined in a conflict; the finding asks a person to settle it, and neither silently wins.
 */
export type ExposureFinding =
  | { reason: "no-component"; exposure: FactEnd; names: string; message: string }
  | {
      reason: "host-conflict" | "base-path-conflict";
      exposure: FactEnd;
      /** The repo the component is of, and the component. */
      repo: string;
      component: string;
      /** The fact's host or base path. */
      fact: string;
      /** What repos.manifest.yaml says instead. */
      manifest: string[];
      message: string;
    };

/** J2: a call left to a system outside the estate (a vendor, a cloud service), with the name it gave. */
export interface FactJoinOutside {
  call: FactEnd;
  target: string;
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
  /** J2: the calls left to a system outside the estate, by the name each gave; left out when none. */
  outside?: FactJoinOutside[];
  /** J1: exposure facts that conflict with the manifest or name no component; left out when none. */
  exposure?: ExposureFinding[];
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
  /**
   * The words this estate's virtual hosts and gateway repo types use for each side of the
   * organisation (A-gateway2). The defaults are `FACING_WORDS`; a value matching neither list
   * leaves the hop a plain gateway.
   */
  facing?: FacingWords;
}

type Entry = FactOf<"entry">;
type Call = FactOf<"call">;
type Field = FactOf<"field">;
type Store = FactOf<"store">;
type Config = FactOf<"config">;
type Deploy = FactOf<"deploy">;

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

/** The question for a call whose gateway routes lead back where they came from (A-gateway2). */
export function gatewayCycleQuestion(f: Call, component: string, gateway: string): string {
  const what = [f.method?.toUpperCase(), f.path].filter(Boolean).join(" ");
  return `Where does ${what}, which ${component} calls, end? Its gateway routes lead back into ${gateway}, which it has already been through, so the facts can't say.`;
}

const SECRETISH = /^(env:|vault:|secret:|ref:|\$\{|\{\{)/i;

/** A path's segments, lower case, or undefined for none (ADR 0134). */
function pathSegments(p: string | undefined): string[] | undefined {
  if (!p) return undefined;
  const segs = p
    .split(/[?#]/)[0]!
    .split("/")
    .filter(Boolean)
    .map((x) => (/^\{[^}]*\}$/.test(x) ? "{}" : x.toLowerCase()));
  return segs.length ? segs : undefined;
}

/** A base path's segment and a call's, the same: a `{placeholder}` on either side is any one. */
const sameSegment = (a: string, b: string) => a === "{}" || b === "{}" || a === b;
/** Two base paths, the same segment for segment (none and none are the same). */
const sameSegments = (a: string[] | undefined, b: string[] | undefined) =>
  (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((x, i) => sameSegment(x, b![i]!));

/** The path part of a URL (`https://host/forge/limits` gives `/forge/limits`), when it has one. */
function urlPathOf(s: string | undefined): string | undefined {
  const m = s ? /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+(\/[^?#]*)/i.exec(s.trim()) : null;
  return m && m[1] !== "/" ? m[1] : undefined;
}

const joinPaths = (base: string | undefined, path: string | undefined) =>
  base ? `${base.replace(/\/+$/, "")}/${(path ?? "").replace(/^\/+/, "")}` : path;

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

/**
 * The host a call goes to as the join reads it (P1): the call's own host, else the host of the
 * config fact its `base` names (the first by id), else the base itself; `host:port` when the text
 * writes a port. Undefined when nothing names one (a relative call, a `${PLACEHOLDER}` base with
 * no key that reads as a host). The measure uses it to tell which outside system took a call.
 */
export function callHostOf(f: Call, repoFacts: readonly Fact[]): string | undefined {
  const tie = repoFacts
    .filter(
      (n): n is Config => n.kind === "config" && !!f.base && n.key === f.base && !!hostIn(n.value),
    )
    .sort((x, y) => cmp(x.id, y.id))[0];
  // A base that is a config key of the repo is never a host itself (J0).
  const keyed = !!f.base && repoFacts.some((n) => n.kind === "config" && n.key === f.base);
  const h =
    hostIn(f.host) ?? (tie ? hostIn(tie.value) : undefined) ?? (keyed ? undefined : hostIn(f.base));
  return h ? (h.named ? `${h.host}:${h.named}` : h.host) : undefined;
}

interface Node {
  repo: string;
  fact: Fact;
  component: string;
}

/**
 * J0: a config placeholder: `${X}` or Spring's `${X:default}` anywhere in a value (a URL may be
 * written around it, `https://${HOST}/v2`), or `env:X` as the whole value. Two placeholders in
 * one value are not resolved: which part each gives can't be read without guessing.
 */
export function placeholderIn(
  s: string | undefined,
): { name: string; fallback?: string; before: string; after: string } | undefined {
  const t = (s ?? "").trim();
  const env = /^env:([A-Za-z_][A-Za-z0-9_.-]*)$/i.exec(t);
  if (env) return { name: env[1]!, before: "", after: "" };
  const i = t.indexOf("${");
  if (i < 0) return undefined;
  let depth = 0;
  let j = i + 2;
  for (; j < t.length; j++) {
    if (t[j] === "{") depth++;
    else if (t[j] === "}") {
      if (depth === 0) break;
      depth--;
    }
  }
  if (j >= t.length) return undefined;
  const inner = t.slice(i + 2, j);
  const after = t.slice(j + 1);
  if (after.includes("${")) return undefined;
  const colon = inner.indexOf(":");
  const name = (colon < 0 ? inner : inner.slice(0, colon)).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_.[\]-]*$/.test(name)) return undefined;
  const fallback = colon < 0 ? undefined : inner.slice(colon + 1).trim();
  return { name, ...(fallback ? { fallback } : {}), before: t.slice(0, i), after };
}

/**
 * A setting's name as a placeholder finds it: letter case, `.`, `-`, `_` and list brackets aside,
 * as Spring's relaxed binding reads `PAYMENTS_URL` for `${payments.url}`.
 */
export const settingNameKey = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** How many placeholders deep a value is followed (`${A}` set to `${B}` set to a host). */
const MAX_PLACEHOLDER_DEPTH = 4;

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

  // ---- J0: placeholders resolved through the config facts that set them
  const configNodes = nodes.filter((n): n is Node & { fact: Config } => n.fact.kind === "config");
  /** Each file's deployments, by the name it deploys (a ConfigMap or Helm values beside one). */
  const deploysIn = new Map<string, Set<string>>();
  for (const n of nodes) {
    if (n.fact.kind !== "deploy" || !n.fact.resourceName) continue;
    const k = key(n.repo, n.fact.cite.file);
    deploysIn.set(k, (deploysIn.get(k) ?? new Set()).add(factIdPart(n.fact.resourceName)));
  }
  /**
   * Whether a setting is for a component: in its own repo, any of the component's or the
   * repo's own; in another (a deploy or config repo), one whose component or `target` is the
   * component, whose file sits in a folder named for it (`apps/<component>/values-prod.yaml`),
   * or whose file deploys it (a Deployment's `env` beside its name).
   */
  const setsFor = (n: Node & { fact: Config }, owner: Node): boolean => {
    const names = new Set([owner.component, factIdPart(owner.repo)]);
    if (n.fact.target && names.has(factIdPart(n.fact.target))) return true;
    if (n.repo === owner.repo) return n.component === owner.component || !n.fact.component;
    if (n.component === owner.component) return true;
    const parts = n.fact.cite.file.split("/");
    if (parts.some((p) => names.has(factIdPart(p.replace(/\.[^.]*$/, ""))))) return true;
    const deployed = deploysIn.get(key(n.repo, n.fact.cite.file));
    return !!deployed && [...names].some((x) => deployed.has(x));
  };
  /** Names a setting's file or fields could be for: every component and repo of the estate. */
  const known = new Set([...components, ...repoIds.keys()]);
  /**
   * A setting for no component in particular: another repo's, with no `target` or component of
   * its own, in a file no folder or deployment of which names any component or repo of the estate
   * (a platform chart's `charts/platform/values.yaml`). Read only when nothing sets the variable
   * for the component itself.
   */
  const setsForAll = (n: Node & { fact: Config }, owner: Node): boolean => {
    if (n.repo === owner.repo || n.fact.target || n.fact.component) return false;
    const parts = n.fact.cite.file.split("/");
    if (parts.some((p) => known.has(factIdPart(p.replace(/\.[^.]*$/, ""))))) return false;
    return !deploysIn.has(key(n.repo, n.fact.cite.file));
  };
  /**
   * A value with its placeholders resolved, once per setting that sets it (one per environment,
   * say), each with the config facts it went through; a placeholder nothing sets takes its
   * Spring default. A value nothing resolves gives none; a ring of placeholders ends.
   */
  const resolve = (
    raw: string | undefined,
    owner: Node,
    seen: ReadonlySet<string>,
    depth = 0,
  ): { value: string; through: (Node & { fact: Config })[] }[] => {
    const v = raw?.trim();
    if (!v) return [];
    const p = placeholderIn(v);
    if (!p) return SECRETISH.test(v) ? [] : [{ value: v, through: [] }];
    if (depth >= MAX_PLACEHOLDER_DEPTH) return [];
    const want = settingNameKey(p.name);
    const out: { value: string; through: (Node & { fact: Config })[] }[] = [];
    const named = configNodes.filter(
      (s) => !seen.has(key(s.repo, s.fact.id)) && settingNameKey(s.fact.key) === want,
    );
    const mine = named.filter((s) => setsFor(s, owner));
    for (const s of mine.length ? mine : named.filter((x) => setsForAll(x, owner))) {
      const k = key(s.repo, s.fact.id);
      for (const r of resolve(
        s.fact.value ?? s.fact.source,
        owner,
        new Set([...seen, k]),
        depth + 1,
      ))
        out.push({ value: `${p.before}${r.value}${p.after}`, through: [s, ...r.through] });
    }
    if (out.length || !p.fallback) return out;
    return resolve(p.fallback, owner, seen, depth + 1).map((r) => ({
      value: `${p.before}${r.value}${p.after}`,
      through: r.through,
    }));
  };
  const uniqueEnds = (ns: readonly Node[]): FactEnd[] => {
    const seen = new Set<string>();
    return ns
      .filter((n) => {
        const k = key(n.repo, n.fact.id);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map(end);
  };
  /** A topic as written, or each value its placeholder resolves to, with the settings it went through. */
  const topicsOf = (n: Node, path: string) =>
    placeholderIn(path)
      ? resolve(path, n, new Set())
      : [{ value: path, through: [] as (Node & { fact: Config })[] }];
  // ---- J1 (ADR 0143): where each component is reached, from the manifest's hosts and base
  // paths and from the exposure facts (a Route's, an Ingress's, a Helm value's or a proxy's
  // BasePath). Both are accepted; where they disagree the finding says so, and neither wins.
  type Exposure = Node & { fact: Deploy };
  interface Reached {
    repo: string;
    /** A module's component; left out for the repo itself. */
    component: string | undefined;
    manifestHosts: string[];
    manifestBase: string | undefined;
    /** Each host and base path, with the exposures that give it; `listed` when the manifest does. */
    hosts: { pattern: string; by: Exposure[]; listed?: true }[];
    paths: { path: string | undefined; by: Exposure[]; listed?: true }[];
  }
  const reached = new Map<string, Reached>();
  const reachedOf = (repo: string, component: string | undefined): Reached => {
    const k = `${repo}\u0000${component ?? ""}`;
    let g = reached.get(k);
    if (!g) {
      g = { repo, component, manifestHosts: [], manifestBase: undefined, hosts: [], paths: [] };
      reached.set(k, g);
    }
    return g;
  };
  const addHost = (g: Reached, pattern: string, by?: Exposure) => {
    const h = g.hosts.find((x) => x.pattern.toLowerCase() === pattern.toLowerCase());
    if (h) {
      if (by) h.by.push(by);
    } else g.hosts.push({ pattern, by: by ? [by] : [], ...(by ? {} : { listed: true as const }) });
  };
  const addPath = (g: Reached, path: string, by?: Exposure) => {
    const segs = pathSegments(path);
    const h = g.paths.find((x) => sameSegments(pathSegments(x.path), segs));
    if (h) {
      if (by) h.by.push(by);
    } else g.paths.push({ path, by: by ? [by] : [], ...(by ? {} : { listed: true as const }) });
  };
  for (const r of repos) {
    const g = reachedOf(r.repo, undefined);
    g.manifestHosts = [...(r.hosts ?? [])];
    g.manifestBase = r.basePath;
    for (const h of g.manifestHosts) addHost(g, h);
    if (r.basePath) addPath(g, r.basePath);
    for (const m of r.modules ?? []) {
      const mg = reachedOf(r.repo, factIdPart(m.component));
      mg.manifestHosts = [...m.hosts];
      mg.manifestBase = m.basePath;
      for (const h of m.hosts) addHost(mg, h);
      if (m.basePath) addPath(mg, m.basePath);
    }
  }
  const mainOf = new Map(repos.map((r) => [factIdPart(r.component ?? r.repo), r.repo] as const));
  const moduleOf = new Map(
    repos.flatMap((r) => (r.modules ?? []).map((m) => [factIdPart(m.component), r.repo] as const)),
  );
  /** The repo (and module) an exposure reaches: its `exposes`, else its own component. */
  const exposedOwner = (
    n: Exposure,
  ): { repo: string; component: string | undefined } | undefined => {
    const own = (repo: string, component: string) =>
      mainOf.get(component) === repo ? { repo, component: undefined } : { repo, component };
    if (!n.fact.exposes) return own(n.repo, n.component);
    const slug = factIdPart(n.fact.exposes);
    const repo = repoIds.get(slug) ?? mainOf.get(slug);
    if (repo) return { repo, component: undefined };
    const mod = moduleOf.get(slug);
    if (mod) return { repo: mod, component: slug };
    // A component the facts name (a module the manifest doesn't list), or one made estate-unique.
    const named = nodes.find(
      (x) =>
        x.repo !== n.repo &&
        (x.component === slug || x.component === factIdPart(`${x.repo}-${slug}`)),
    );
    return named ? own(named.repo, named.component) : undefined;
  };
  const exposure: ExposureFinding[] = [];
  for (const n of nodes) {
    if (n.fact.kind !== "deploy" || (!n.fact.host && !n.fact.basePath)) continue;
    const x = n as Exposure;
    const where = `${x.repo}'s ${x.fact.id} (${at(x.fact)})`;
    const owner = exposedOwner(x);
    if (!owner) {
      exposure.push({
        reason: "no-component",
        exposure: end(x),
        names: x.fact.exposes!,
        message: `${where} exposes ${x.fact.exposes}, which is no component or repo of the estate: name the component the route reaches, or drop the fact`,
      });
      continue;
    }
    const g = reachedOf(owner.repo, owner.component);
    const component =
      owner.component ??
      factIdPart(repos.find((r) => r.repo === owner.repo)?.component ?? owner.repo);
    const holder = owner.component ? `${owner.repo}'s module ${owner.component}` : owner.repo;
    const env = x.fact.env ? ` (${x.fact.env})` : "";
    if (x.fact.host) {
      const host = x.fact.host;
      if (g.manifestHosts.length && !g.manifestHosts.some((p) => hostMatches(p, host)))
        exposure.push({
          reason: "host-conflict",
          exposure: end(x),
          repo: owner.repo,
          component,
          fact: host,
          manifest: [...g.manifestHosts],
          message: `${component} is reached on ${host}${env} by ${where}, and repos.manifest.yaml lists ${g.manifestHosts.join(", ")} for ${holder}: both are joined; list the host in the manifest, or correct the one that is wrong`,
        });
      addHost(g, host, x);
    }
    if (x.fact.basePath) {
      const path = x.fact.basePath;
      if (g.manifestBase && !sameSegments(pathSegments(g.manifestBase), pathSegments(path)))
        exposure.push({
          reason: "base-path-conflict",
          exposure: end(x),
          repo: owner.repo,
          component,
          fact: path,
          manifest: [g.manifestBase],
          message: `${component} is reached under ${path}${env} by ${where}, and repos.manifest.yaml gives ${g.manifestBase} for ${holder}: both are joined; set the manifest's basePath to it, or correct the one that is wrong`,
        });
      addPath(g, path, x);
    }
  }
  const declared = [...reached.values()].flatMap((g) => {
    // A module (or a repo's component) with a base path and no hosts of its own answers on its
    // repo's hosts (ADR 0134), whether the manifest or an exposure gave them.
    const hosts = g.hosts.length
      ? g.hosts
      : g.component
        ? (reached.get(`${g.repo}\u0000`)?.hosts ?? [])
        : [];
    const paths = g.paths.length ? g.paths : [{ path: undefined, by: [] as Exposure[] }];
    return hosts.flatMap((h) =>
      paths.map((p) => ({
        pattern: h.pattern,
        repo: g.repo,
        component: g.component,
        basePath: pathSegments(p.path),
        // The exposures the pair rests on: none for what the manifest lists itself.
        by: [...(h.listed ? [] : h.by), ...(p.listed ? [] : p.by)],
      })),
    );
  });
  /**
   * Every repo (or module) that lists a host: those naming its port, else those that don't. A
   * host several repos list (a shared API gateway host, each proxy in a repo of its own) is
   * answered by whichever of them serves the call's path, never by the first one listed.
   */
  const claimed = (h: { host: string; port?: number }, path?: string) => {
    const ported = declared.filter(
      (d) => hostHasPort(d.pattern) && hostMatches(d.pattern, h.host, h.port),
    );
    const listed = ported.length
      ? ported
      : declared.filter((d) => !hostHasPort(d.pattern) && hostMatches(d.pattern, h.host, h.port));
    if (!listed.length) return undefined;
    // ADR 0134: where repos give the base path they answer under, the call's path picks among
    // them: only those with the longest base path that starts it. None starting it leaves the
    // repos that give no base path; a repo whose base path rules the call out is never joined.
    const segs = pathSegments(path) ?? [];
    const starts = listed.filter(
      (d) =>
        d.basePath &&
        d.basePath.length <= segs.length &&
        d.basePath.every((x, i) => sameSegment(x, segs[i]!)),
    );
    const longest = Math.max(0, ...starts.map((d) => d.basePath!.length));
    const all = starts.length
      ? starts.filter((d) => d.basePath!.length === longest)
      : listed.filter((d) => !d.basePath);
    if (!all.length)
      return {
        scope: () => false,
        target: `${h.host} (no repo's base path starts ${path ?? "the call's path"})`,
        key: `none|${h.host}`,
        by: [] as FactEnd[],
      };
    const owns = (d: (typeof declared)[number]) => (e: Node) =>
      d.component ? e.component === d.component : e.repo === d.repo;
    const targets = [...new Set(all.map((d) => d.component ?? d.repo))].sort();
    return {
      scope: (e: Node) => all.some((d) => owns(d)(e)),
      target: targets.join(", "),
      key: targets.join("|"),
      by: uniqueEnds(all.flatMap((d) => d.by)),
    };
  };

  const outside = new Set((input.outside ?? []).map(factIdPart));
  const joins: FactJoin[] = [];
  const asks: FactJoinAsk[] = [];
  const misses: FactJoinMiss[] = [];
  const outsideCalls: FactJoinOutside[] = [];

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
      // J0: a topic either side gives as a placeholder is each value its settings give it.
      const sent = topicsOf(call, f.path);
      for (const e of entries) {
        if (e.fact.entryType !== f.callType || e.component === call.component) continue;
        const heard = topicsOf(e, e.fact.path);
        const both = sent.filter((s) => heard.some((h) => h.value === s.value));
        if (!both.length) continue;
        const path = both.map((s) => s.value).sort(cmp)[0]!;
        const through = uniqueEnds(both.filter((s) => s.value === path).flatMap((s) => s.through));
        const entryThrough = uniqueEnds(
          heard.filter((h) => h.value === path).flatMap((h) => h.through),
        );
        joins.push({
          call: end(call),
          entry: end(e),
          ...(through.length ? { through } : {}),
          ...(entryThrough.length ? { entryThrough } : {}),
          how: "topic",
          callType: f.callType,
          path,
          interface: interfaceId(call.component, e.component, undefined, path),
        });
      }
      continue;
    }
    if (!SERVES[f.callType]) continue;

    // The config fact that gives the call's base URL ties it to a host; where its value is a
    // placeholder (J0), each value the settings for the caller's component give it does.
    const keyed = configNodes.filter(
      (n) => n.repo === call.repo && !!f.base && n.fact.key === f.base,
    );
    type Cand = { value: string; tie?: Node & { fact: Config }; through: Node[] };
    const cands: Cand[] = [];
    if (!hostIn(f.host)) {
      if (placeholderIn(f.host)) cands.push(...resolve(f.host, call, new Set()));
      else if (keyed.length)
        for (const t of keyed)
          for (const r of resolve(
            t.fact.value ?? t.fact.source,
            call,
            new Set([key(t.repo, t.fact.id)]),
          ))
            cands.push({ ...r, tie: t });
      else if (placeholderIn(f.base)) cands.push(...resolve(f.base, call, new Set()));
    }
    const configs = cands.filter((x) => !!hostIn(x.value));
    const claimOf = (x: Cand) => claimed(hostIn(x.value)!, joinPaths(urlPathOf(x.value), f.path));
    // Every value a manifest host or base path claims is accepted, with the lines that gave it;
    // with none claimed, the first stands, as one value always has.
    const firstClaim = configs.map(claimOf).find((d) => !!d);
    const used = firstClaim
      ? configs.filter((x) => claimOf(x)?.key === firstClaim.key)
      : configs.slice(0, 1);
    const tieNode = used[0]?.tie;
    const throughEnds = uniqueEnds(
      used.flatMap((x) => [...(x.tie && x.tie !== tieNode ? [x.tie] : []), ...x.through]),
    );
    const tie = {
      ...(tieNode ? { tie: end(tieNode) } : {}),
      ...(throughEnds.length ? { through: throughEnds } : {}),
    };
    // A base that is a config key of the repo (resolved or not) is never read as a host itself.
    const host =
      hostIn(f.host) ??
      (used[0] ? hostIn(used[0].value) : undefined) ??
      (keyed.length ? undefined : hostIn(f.base));
    // The whole path the call sends: a base URL's own path (`https://host/forge/limits`) in front.
    const fullPath = joinPaths(
      urlPathOf(f.host) ??
        (used[0] ? urlPathOf(used[0].value) : undefined) ??
        (keyed.length ? undefined : urlPathOf(f.base)),
      f.path,
    );

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
      for (const x of configs) {
        const d = claimOf(x);
        if (d) owners.set(d.key, d.scope);
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
    let byLabel = false;
    let exposedBy: FactEnd[] = [];
    if (answer === NO_TARGET) continue;
    // C2 (ADR 0135): a target a person set (a correction from the Map) outranks every rule
    // after an answer: one naming nothing in the estate is outside it, never joined by its host,
    // a host's label or its path.
    if (!answer && f.by === "person" && f.to && !named(f.to)) continue;
    if (answer) {
      scope = named(answer);
      if (!scope) {
        // A vendor named by a person: nothing in the estate to join, the call goes outside.
        outsideCalls.push({ call: end(call), target: answer });
        continue;
      }
      how = "answer";
    } else if (f.to && named(f.to)) {
      const n = named(f.to)!;
      scope = n;
      how = n.repo ? "repo" : "named";
    } else if (host && claimed(host, fullPath)) {
      const d = claimed(host, fullPath)!;
      scope = { scope: d.scope, target: d.target };
      how = "host";
      exposedBy = d.by;
    } else if (
      host &&
      outside.has(factIdPart(host.named ? `${host.host}:${host.named}` : host.host))
    ) {
      // O1: an outside system the profile names by this host takes the call (J0: listed, so a
      // host only a placeholder's setting gives is said outside too).
      outsideCalls.push({
        call: end(call),
        target: host.named ? `${host.host}:${host.named}` : host.host,
      });
      continue;
    } else if (host && components.has(factIdPart(host.host.split(".")[0]!))) {
      const comp = factIdPart(host.host.split(".")[0]!);
      scope = { scope: (e) => e.component === comp, target: comp };
      how = "host";
      byLabel = true;
    } else if (f.to && (host || outside.has(factIdPart(f.to)))) {
      // A target outside the estate (a vendor, a cloud service): the call keeps it.
      outsideCalls.push({ call: end(call), target: f.to });
      continue;
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
        ...(byLabel ? { byLabel: true as const } : {}),
        ...(exposedBy.length ? { exposedBy } : {}),
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

  // ---- through the gateways (A-gateway; a chain of them, A-gateway2): a call that lands on a
  // route joins where the route forwards, and on through every further gateway it reaches.
  const gateways = new Set(repos.filter((r) => r.gateway).map((r) => r.repo));
  const facingOf = new Map(repos.flatMap((r) => (r.facing ? [[r.repo, r.facing] as const] : [])));
  const words = input.facing ?? FACING_WORDS;
  const saysFacing = (value: string | undefined): GatewayFacing | undefined => {
    const v = (value ?? "").toLowerCase();
    if (!v) return undefined;
    const has = (list: readonly string[]) => list.some((w) => v.includes(w.toLowerCase()));
    // Internal first: a word list that claims both is read as the inside, never as both.
    return has(words.internal) ? "internal" : has(words.external) ? "external" : undefined;
  };
  /** The proxy's own `VirtualHost` config fact, when the route's handler names its proxy. */
  const virtualHostOf = (route: Node & { fact: Entry }): string | undefined => {
    const proxy = route.fact.handler?.split("/")[0];
    if (!proxy) return undefined;
    return nodes
      .filter(
        (n): n is Node & { fact: Config } =>
          n.repo === route.repo &&
          n.fact.kind === "config" &&
          /^virtualhost$/i.test(n.fact.key) &&
          n.fact.target === proxy,
      )
      .sort((x, y) => cmp(x.fact.id, y.fact.id))[0]?.fact.value;
  };
  const isRoute = (n: Node) =>
    n.fact.kind === "entry" && (gateways.has(n.repo) || APIGEE_BUNDLE.test(n.fact.cite.file));
  const joinsOf = new Map<string, FactJoin[]>();
  for (const j of joins) {
    const k = key(j.call.repo, j.call.fact);
    joinsOf.set(k, [...(joinsOf.get(k) ?? []), j]);
  }
  /**
   * Where the route a join lands on forwards to, when the facts say it exactly: every forwarding
   * call joined, and all to the same entry. Else undefined: the call stays at the gateway.
   */
  const forwardedTo = (route: Node & { fact: Entry }): FactJoin | undefined => {
    const forwards = nodes.filter(
      (n): n is Node & { fact: Call } =>
        n.repo === route.repo &&
        n.fact.kind === "call" &&
        n.fact.from === route.fact.id &&
        !EVENTS.has(n.fact.callType),
    );
    const got = forwards.map((n) => joinsOf.get(key(n.repo, n.fact.id)) ?? []);
    if (!got.length || got.some((h) => h.length !== 1)) return undefined;
    const lands = got.map((h) => h[0]!);
    const first = lands[0]!;
    return lands.some((l) => l.entry.repo !== first.entry.repo || l.entry.fact !== first.entry.fact)
      ? undefined
      : first;
  };
  const cycles: FactJoinAsk[] = [];
  for (const [i, j] of joins.entries()) {
    if (j.how === "topic") continue;
    let route = byKey.get(key(j.entry.repo, j.entry.fact))!;
    if (!isRoute(route)) continue;
    const caller = byKey.get(key(j.call.repo, j.call.fact))! as Node & { fact: Call };
    const hops: GatewayHop[] = [];
    const seen = new Set<string>();
    let landed: FactJoin | undefined;
    let looped: { at: Node; hop: FactJoin } | undefined;
    while (isRoute(route)) {
      const r = route as Node & { fact: Entry };
      const next = forwardedTo(r);
      if (!next) break;
      if (seen.has(key(r.repo, r.fact.id)) || hops.length >= MAX_GATEWAY_HOPS) {
        looped = { at: r, hop: next };
        break;
      }
      seen.add(key(r.repo, r.fact.id));
      // What the manifest's repo type says, else the proxy's own virtual host; nothing else is
      // read as a boundary, so a proxy or basepath whose name hints at one is not taken for it.
      const facing = facingOf.get(r.repo) ?? saysFacing(virtualHostOf(r));
      const scopes = (r.fact.scopes ?? []).map((s) => s.value);
      hops.push({
        entry: end(r),
        call: next.call,
        ...(next.tie ? { tie: next.tie } : {}),
        ...(next.through ? { through: next.through } : {}),
        ...(next.exposedBy ? { exposedBy: next.exposedBy } : {}),
        route: gatewayRouteId(r),
        // A-uncited: the gate on the way into C1, as the projection has it.
        ...(catalogAuth(r.fact) ? { auth: catalogAuth(r.fact) } : {}),
        ...(scopes.length ? { scopes } : {}),
        ...(facing ? { facing } : {}),
      });
      landed = next;
      route = byKey.get(key(next.entry.repo, next.entry.fact))!;
    }
    // A ring of routes: where the call ends can't be read from the facts, so it is asked.
    if (looped) {
      const q = {
        call: end(caller),
        reason: "cycle" as const,
        question: gatewayCycleQuestion(caller.fact, caller.component, looped.at.component),
        candidates: [end(looped.at), looped.hop.entry].sort(
          (x, y) => cmp(x.repo, y.repo) || cmp(x.fact, y.fact),
        ),
      };
      if (!cycles.some((c) => c.call.repo === q.call.repo && c.call.fact === q.call.fact))
        cycles.push(q);
      continue;
    }
    if (!landed || !hops.length) continue;
    const callee = byKey.get(key(landed.entry.repo, landed.entry.fact))! as Node & { fact: Entry };
    if (callee.component === caller.component) continue;
    const forward = byKey.get(key(landed.call.repo, landed.call.fact))!.fact as Call;
    const method = (forward.method ?? caller.fact.method ?? callee.fact.method)?.toUpperCase();
    const scopes = [...new Set(hops.flatMap((h) => h.scopes ?? []))];
    joins[i] = {
      call: j.call,
      entry: landed.entry,
      ...(j.tie ? { tie: j.tie } : {}),
      ...(j.through ? { through: j.through } : {}),
      how: j.how,
      ...(j.inferred ? { inferred: j.inferred } : {}),
      ...(j.byLabel ? { byLabel: j.byLabel } : {}),
      gateway: hops,
      ...(scopes.length ? { scopes } : {}),
      callType: j.callType,
      ...(method ? { method } : {}),
      path: callee.fact.path,
      interface: interfaceId(caller.component, callee.component, method, servedPath(callee.fact)),
    };
  }
  asks.push(...cycles);

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
    // Left out when none, so a join with nothing outside reads as it did before J2.
    ...(outsideCalls.length ? { outside: outsideCalls.sort(byEnds) } : {}),
    ...(exposure.length ? { exposure } : {}),
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
export function servedPath(e: Entry): string {
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
export function gatewayRouteId(n: { component: string; fact: Entry }): string {
  const id = `gw-${factIdPart(`${n.component} ${n.fact.method ?? ""} ${n.fact.path}`)}`
    .replace(/-{2,}/g, "-")
    .replace(/-$/, "");
  return fitId(id, `gw-${n.component}`).replace(/\./g, "-");
}

/**
 * A route's base path: the part of its citation (`cite.with`) its path starts with (an Apigee
 * `<BasePath>`), else its whole path.
 */
export function basePathOf(e: Entry): string {
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
  // F2: how a guessed join found its callee, as the Interface's flags.
  const guessed = (j: FactJoin): string[] => [
    ...(j.inferred ? [JOINED_BY_PATH] : []),
    ...(j.byLabel ? [JOINED_BY_LABEL] : []),
  ];
  // C1 (ADR 0135): how any other join found it; a guess says it by its own flag alone.
  const HOW: Partial<Record<JoinHow, string>> = {
    answer: JOINED_BY_ANSWER,
    named: JOINED_BY_NAME,
    repo: JOINED_BY_REPO,
    host: JOINED_BY_HOST,
  };
  const flagsOf = (j: FactJoin): string[] =>
    guessed(j).length ? guessed(j) : HOW[j.how] ? [HOW[j.how]!] : [];
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
        evidence: once([
          ...ev(j.call, "code", "caller"),
          ...(j.through ?? []).flatMap((t) => ev(t, "config", "caller")),
          ...ev(j.entry, "code", "callee"),
          ...(j.entryThrough ?? []).flatMap((t) => ev(t, "config", "callee")),
        ]),
      } as CatalogRecord);
      continue;
    }
    const call = fact(j.call) as Call;
    const entry = fact(j.entry) as Entry;
    if (j.gateway?.length) {
      // Through the gateways (A-gateway; a chain of them, A-gateway2): the caller to the service,
      // via the first route the caller meets, which the Interface names and a GatewayRoute per hop
      // records with the scopes it demands; the auth a caller meets is that route's, else the
      // service's. Every hop is cited, in order.
      const g = j.gateway[0]!;
      const route = fact(g.entry) as Entry;
      const declared = [
        call,
        entry,
        ...j.gateway.flatMap((h) => [fact(h.entry), fact(h.call)]),
      ].every((f) => f?.conf === "declared");
      const confidence = declared && !guessed(j).length ? "verified" : "inferred";
      const auth = catalogAuth(route) ?? catalogAuth(entry);
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
        ...(flagsOf(j).length ? { flags: flagsOf(j) } : {}),
        ...(j.method ? { method: j.method } : {}),
        normalizedPath: servedPath(entry),
        ...(auth ? { auth } : {}),
        sync: call.sync ?? "sync",
        direction: "outbound",
        conflicts: [],
        evidence: once([
          ...ev(j.call, "code", "caller"),
          ...(j.tie ? ev(j.tie, "config", "caller") : []),
          ...(j.through ?? []).flatMap((t) => ev(t, "config", "caller")),
          ...(j.exposedBy ?? []).flatMap((t) => ev(t, "infrastructure", "gateway")),
          ...j.gateway.flatMap((h) => [
            ...ev(h.entry, "gateway", "gateway"),
            ...ev(h.call, "gateway", "gateway"),
            ...(h.tie ? ev(h.tie, "config", "gateway") : []),
            ...(h.through ?? []).flatMap((t) => ev(t, "config", "gateway")),
            ...(h.exposedBy ?? []).flatMap((t) => ev(t, "infrastructure", "callee")),
          ]),
          ...ev(j.entry, "code", "callee"),
        ]),
      } as CatalogRecord);
      // One GatewayRoute per hop, each with the scopes its own route demands and the component it
      // forwards to (the next gateway for a middle hop, the service for the last).
      j.gateway.forEach((h, k) => {
        if (out.has(h.route)) return;
        const hopRoute = fact(h.entry) as Entry | undefined;
        if (!hopRoute || hopRoute.kind !== "entry") return;
        const at = (p: { file: string; line: number }) => [
          {
            source: "gateway" as const,
            repo: h.entry.repo,
            path: p.file,
            line: p.line,
            commit: hopRoute.commit,
            side: "gateway" as const,
            by: hopRoute.by,
          },
        ];
        out.set(h.route, {
          kind: "GatewayRoute",
          schemaVersion: 2,
          id: h.route,
          status: "current",
          confidence: hopRoute.conf === "declared" ? "verified" : "inferred",
          proxy: hopRoute.handler?.split("/")[0] || h.entry.component,
          basepath: basePathOf(hopRoute),
          target: (j.gateway![k + 1]?.entry.component ?? j.entry.component)!,
          policies: hopRoute.authCite ? [hopRoute.authCite.value] : [],
          scopes: (hopRoute.scopes ?? []).map((s) => s.value),
          evidence: once([
            ...ev(h.entry, "gateway", "gateway"),
            ...(hopRoute.authCite ? at(hopRoute.authCite) : []),
            ...(hopRoute.scopes ?? []).flatMap(at),
            ...ev(h.call, "gateway", "gateway"),
          ]),
        } as CatalogRecord);
      });
      continue;
    }
    const declared = call.conf === "declared" && entry.conf === "declared";
    const method = (call.method ?? entry.method)?.toUpperCase();
    out.set(j.interface, {
      kind: "Interface",
      schemaVersion: 2,
      id: j.interface,
      status: "current",
      confidence: declared && !guessed(j).length ? "verified" : "inferred",
      ...(flagsOf(j).length ? { flags: flagsOf(j) } : {}),
      from: j.call.component,
      to: j.entry.component,
      ...(entry.entryType !== "rest"
        ? { endpoint: entryEndpointId(entry, j.entry.component) }
        : {}),
      via: call.callType === "webhook" ? "webhook" : call.callType === "sftp" ? "sftp" : "direct",
      ...(method ? { method } : {}),
      normalizedPath: servedPath(entry),
      ...(catalogAuth(entry) ? { auth: catalogAuth(entry) } : {}),
      sync: call.sync ?? "sync",
      direction: "outbound",
      conflicts: [],
      evidence: once([
        ...ev(j.call, "code", "caller"),
        ...(j.tie ? ev(j.tie, "config", "caller") : []),
        ...(j.through ?? []).flatMap((t) => ev(t, "config", "caller")),
        ...ev(j.entry, "code", "callee"),
        ...(j.exposedBy ?? []).flatMap((t) => ev(t, "infrastructure", "callee")),
      ]),
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
