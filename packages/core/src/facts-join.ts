import { createHash } from "node:crypto";
import type { CatalogRecord } from "./catalog.js";
import { callPath, catalogAuth, entryEndpointId, factIdPart } from "./facts.js";
import { hostQuestionText } from "./host-questions.js";
import { interfaceId, normalizePath } from "./identity.js";
import type { EvidenceT } from "./schema/common.js";
import type { Fact, FactOf } from "./schema/facts.js";
import { hostHasPort, hostMatches, urlHostPort } from "./schema/workspace.js";
import { DEFAULT_FACING_WORDS, gatewayBundleTest } from "./schema/conventions.js";

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
 * The walk is a stack helper, optional (G4; `walkGateways: false`, or ATTICUS_HELPERS_OFF=
 * gateway-walk): without it a call is joined to the route it lands on, and each route's
 * forwarding call to its service on its own, so the chain is there in two links, not one.
 *
 * The path suffix (an Apigee proxy to its service): a forwarding call cited in a bundle whose
 * path no entry serves in the same shape is joined per route of its proxy (the route it is from,
 * else the proxy's flows, else its `<BasePath>/**`) at the target's path with the route's suffix
 * after it (none when `target.copy.pathsuffix` is false; everything under it for a pass-through),
 * matched against the service's entries with its base path taken off: the manifest's, an
 * exposure's, its context and servlet path settings, else the longest overlap, a guess
 * (`joined-by-path-overlap`). Each such join cites the route (`forRoute`) and the base (`base`).
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
  /**
   * Beta.25 (ADR 0192 addendum): every module the manifest lists, by its folder, hosts or not: a
   * build fact (`artifact`, `dependency`) that names no component is its build file's module's.
   */
  moduleDirs?: readonly { path: string; component: string }[];
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
export const APIGEE_BUNDLE = gatewayBundleTest();

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
export const FACING_WORDS: FacingWords = DEFAULT_FACING_WORDS;

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
  /** The base path the service behind this hop serves under, as `FactJoin.base`. */
  base?: JoinBase;
}

/**
 * The base path a service's entries sit under that the join took off the path an Apigee proxy
 * forwards before matching them (the path suffix): the manifest's `basePath`, an exposure's
 * (`deploy`: an OpenShift Route's or an Ingress's path), the service's own context path and
 * servlet path settings (`config`), or, with none of those, the longest run of the target's path
 * that starts the entry's (`overlap`, a guess: `joined-by-path-overlap`). `by` is the facts it
 * came from (none for the manifest or an overlap).
 */
export interface JoinBase {
  path: string;
  /**
   * `url`: nothing names the base, and one route's whole URL (the target's path and the flow's
   * suffix) ends in exactly one entry's whole path, at least one of the target's own segments
   * included: code at both ends, not a guess. `overlap` is that for a pass-through (every entry
   * under a guessed base), a guess.
   */
  from: "manifest" | "deploy" | "config" | "url" | "overlap";
  by?: FactEnd[];
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

/**
 * J1 (ADR 0143, beta.10): a Kubernetes Service's in-cluster address as an exposure's `host` is
 * written, `<name>.<namespace>.svc.cluster.local`, with `:<port>` when the Service's port is
 * cited: its name, namespace and port, or undefined for any other host.
 */
export function clusterServiceAddress(
  host: string,
): { name: string; namespace: string; port?: number } | undefined {
  const m =
    /^([a-z0-9]([a-z0-9-]*[a-z0-9])?)\.([a-z0-9]([a-z0-9-]*[a-z0-9])?)\.svc\.cluster\.local(?::(\d+))?$/i.exec(
      host.trim(),
    );
  if (!m) return undefined;
  return {
    name: m[1]!.toLowerCase(),
    namespace: m[3]!.toLowerCase(),
    ...(m[5] ? { port: Number(m[5]) } : {}),
  };
}

/**
 * Every name a call reaches a Service by inside the cluster (J1): the whole address, `.svc`,
 * `<name>.<namespace>` and the bare `<name>` (from its own namespace), each with the port when
 * one is cited. The bare name is the short one: a join by it is a guess (`joined-by-service-name`)
 * unless the caller's own namespace is cited and is the Service's (`isShortServiceHost`).
 */
export function clusterServiceHosts(a: {
  name: string;
  namespace: string;
  port?: number;
}): string[] {
  const port = a.port !== undefined ? `:${a.port}` : "";
  return [
    `${a.name}.${a.namespace}.svc.cluster.local`,
    `${a.name}.${a.namespace}.svc`,
    `${a.name}.${a.namespace}`,
    a.name,
  ].map((h) => `${h}${port}`);
}

/**
 * Whether a name `clusterServiceHosts` gives is the short one: the bare `<name>`, which the
 * cluster's DNS resolves only from the caller's own namespace. `<name>.<namespace>` resolves from
 * any namespace through the search path, so it names the Service as surely as `.svc` does.
 */
export const isShortServiceHost = (host: string): boolean =>
  !host.replace(/:\d+$/, "").includes(".");

/** A character that makes a path segment a regular expression (an Ingress `ImplementationSpecific` path). */
const PATH_PATTERN = /[()[\]|$^*+?\\]/;

/** Whether a base path is written as a regular expression (J1): `/forge/limits(/|$)(.*)`. */
export const isPatternPath = (path: string): boolean => PATH_PATTERN.test(path);

/**
 * A base path's plain prefix (J1): the segments before the first one a regular expression's
 * pattern is in, `/forge/limits(/|$)(.*)` giving `/forge/limits`. A plain path is itself.
 */
export function plainPathPrefix(path: string): string {
  const segs: string[] = [];
  for (const s of path.split("/").filter(Boolean)) {
    const at = s.search(PATH_PATTERN);
    if (at < 0) {
      segs.push(s);
      continue;
    }
    if (at > 0) segs.push(s.slice(0, at));
    break;
  }
  return `/${segs.join("/")}`;
}

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
/**
 * A call whose host nothing resolves, joined to a gateway proxy's flow by its whole path: the one
 * proxy whose cited `<BasePath>` starts it, the one flow of its method under it. Code at both
 * ends: a how, never a guess. Beta.25: verified only for a gateway's forwarding call that names
 * no host (a chained proxy); a call whose host nothing resolves is inferred, `joined-by-path` first.
 */
export const JOINED_BY_BASE_PATH = "joined-by-base-path";
/**
 * J0, J1: the guesses a join by host can rest on, though the host itself was cited. The setting
 * that gave the host is a platform-wide one nobody aimed at the caller (`setsForAll`), or one that
 * is the caller's only because a folder of its file is named like it (`apps/<component>/...`); or
 * the host or base path is an exposure fact's that an open `host-conflict` or `base-path-conflict`
 * finding disputes. A join with one is `inferred`, flagged with it, as a join by path is.
 */
export const JOINED_BY_PLATFORM_SETTING = "joined-by-platform-setting";
export const JOINED_BY_FOLDER_NAME = "joined-by-folder-name";
export const JOINED_DESPITE_CONFLICT = "joined-despite-conflict";
/**
 * J1 (beta.10): a call that reached a Kubernetes Service by its bare name,
 * which resolves to that Service only from a pod of its own namespace, with no cited namespace
 * of the caller's own (its own Service's in-cluster address) the same as the Service's. The
 * `<name>.<namespace>` and the whole `<name>.<namespace>.svc[.cluster.local]` address are no guess.
 */
export const JOINED_BY_SERVICE_NAME = "joined-by-service-name";
/** G1 (ADR 0174): a person paired the call with this entry on the canvas. */
export const JOINED_BY_PERSON = "joined-by-person";
/**
 * An Apigee proxy's forwarding call matched the service's entry only by taking off the front of
 * the target's path that nothing names as the service's base path (no manifest `basePath`, no
 * Route or Ingress path, no context path setting): `/forge-limits/v3/limits` and the suffix
 * `/check` against `/limits/check`. A guess, so the link is inferred; the Interface's flag only,
 * not one of `JOIN_GUESS_FLAGS` (the local API's guesses), and its how is the host's.
 */
export const JOINED_BY_PATH_OVERLAP = "joined-by-path-overlap";
/** How many entries a `<BasePath>/**` pass-through links to at most, in path order. */
export const MAX_PASS_THROUGH_LINKS = 50;
/**
 * ADR 0181: the AI decided the link (a pairing, or a target answer), applied by Atticus from its
 * run without a person. A how, never a person's word: the Interface is inferred, its evidence is
 * `source: ai` with the run, and plans and checks tell it from a person's.
 */
export const JOINED_BY_AI = "joined-by-ai";
/** The guesses of J0 and J1 a join by host can carry (`FactJoin.guesses`). */
export type JoinHostGuess =
  | typeof JOINED_BY_PLATFORM_SETTING
  | typeof JOINED_BY_FOLDER_NAME
  | typeof JOINED_DESPITE_CONFLICT
  | typeof JOINED_BY_SERVICE_NAME;
/**
 * Every flag that says a link is a guess (F2, J0, J1): the only join flags that are gaps. A reader
 * that treats a guessed link apart (the critic, a change's impact, the measure, J6) reads these.
 */
export const JOIN_GUESS_FLAGS = [
  JOINED_BY_PATH,
  JOINED_BY_LABEL,
  JOINED_BY_PLATFORM_SETTING,
  JOINED_BY_FOLDER_NAME,
  JOINED_DESPITE_CONFLICT,
  JOINED_BY_SERVICE_NAME,
] as const;
export type JoinGuessFlag = (typeof JOIN_GUESS_FLAGS)[number];
const GUESS_ORDER: readonly string[] = JOIN_GUESS_FLAGS;
/** The guesses, each once, in `JOIN_GUESS_FLAGS`' order. */
const guessList = (gs: Iterable<JoinHostGuess>): JoinHostGuess[] =>
  [...new Set(gs)].sort((a, b) => GUESS_ORDER.indexOf(a) - GUESS_ORDER.indexOf(b));

/** Flags that say how a link was made and nothing more: never a gap (C1, ADR 0135). */
export const JOIN_HOW_FLAGS: ReadonlySet<string> = new Set([
  JOINED_BY_PERSON,
  JOINED_BY_AI,
  JOINED_BY_ANSWER,
  JOINED_BY_NAME,
  JOINED_BY_REPO,
  JOINED_BY_HOST,
  JOINED_BY_BASE_PATH,
  // A-callers: a person declared who calls a gateway route (`DECLARED_CALLER`, facts-callers).
  "declared-caller",
  // ADR 0160 (O3): a call to another team's system, answered by an entry of the map they share.
  "joined-to-shared-map",
]);

/**
 * ADR 0160 (O3): a call left to another team's system that an entry of the team's shared map
 * answers (`shared-maps.ts`). A how, never a guess.
 */
export const JOINED_TO_SHARED_MAP = "joined-to-shared-map";

/**
 * How the callee was found: `answer` (a person named it), `named` (the call's `to` names the
 * component), `repo` (its `to` names the repo), `host` (a host or base URL the manifest lists,
 * or the component's own name as the host), `path` (no target named: the only entry of the
 * estate that serves it), `topic` (a listener of the published topic).
 */
export type JoinHow = "answer" | "named" | "repo" | "host" | "base-path" | "path" | "topic";

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
   * Beta.25: also a join by a proxy's BasePath (`how: "base-path"`) whose caller's host nothing
   * resolves (`within: "estate"`): the path is code at both ends, the host a guess.
   */
  inferred?: { within: "repo" | "estate"; named?: string };
  /**
   * F2: the host named no repo; its first label happened to be a component's name. A guess, so
   * the Interface is inferred and flagged `joined-by-label`.
   */
  byLabel?: true;
  /**
   * J0, J1: what the join by host (or a topic) guessed on the way, though the host was cited: a
   * platform-wide setting, a setting's folder name, or an exposure an open finding disputes. The
   * Interface is inferred and flagged with each. Left out when nothing was guessed.
   */
  guesses?: JoinHostGuess[];
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
  /**
   * G1 (ADR 0174): a person paired the call with this entry; who did. ADR 0181: `ai` when the
   * pairing is the AI's (written by Atticus from that run), never a person's word. `call` is set
   * when the pairing was a gateway hop's forwarding call (the line the person's evidence cites):
   * a hop a person paired makes the whole walked link that person's pairing.
   */
  paired?: { by: string; ai?: JoinAi; call?: FactEnd };
  /** ADR 0181: the target answer that joined it was the AI's, from that run. */
  aiAnswer?: JoinAi;
  /**
   * ADR 0181 (ninth UX walk): a gateway hop on the way (`gateway`) was joined by the AI (its
   * forwarding call's pairing or target answer), so the whole link is the AI's: `call` is that
   * hop's forwarding call, the line the AI's evidence cites.
   */
  aiHop?: JoinAi & { call: FactEnd };
  /**
   * An Apigee proxy's forwarding call (the path suffix): the proxy's route whose requests it
   * carries, when the path the target receives is the target's path and this route's suffix (or,
   * for a `<BasePath>/**` pass-through, everything under the target's path). A call that serves
   * several routes has a join per route.
   */
  forRoute?: FactEnd;
  /** The service's base path the join took off before matching its entry (the path suffix). */
  base?: JoinBase;
  /**
   * The setting that keeps the proxy's path suffix off (`target.copy.pathsuffix` false, in a
   * JavaScript or AssignMessage policy), so the target receives its own path as it is.
   */
  suffixOff?: FactEnd;
}

/** ADR 0181: the AI run a decision came from. */
export interface JoinAi {
  runtime: string;
  run: string;
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

/**
 * Why the join left a call it neither joined, asked about nor left to an outside system (with
 * `explain`), in its own words, at the point it gave up:
 * - `no-host`: no host, base or target in the code, and no entry of the estate serves its path;
 * - `unresolved-placeholder`: the host or base it names (a placeholder or a config key) no
 *   setting resolves (J0), and no entry serves its path;
 * - `host-no-route`: a host the manifest or an exposure lists, and no route there serves its path
 *   or method; `label-no-route`: the same for a host's first label naming a component;
 * - `target-no-route`: the repo or component it names (or a person's answer names) has no entry
 *   serving it;
 * - `generic-path`: a health, status or metrics path with no target, which every service serves;
 * - `answered-none`: a person answered that nothing in the estate answers it;
 * - `topic-unheard`: a publish no listener's topic matches; `topic-unresolved`: a placeholder
 *   topic no setting resolves (J0);
 * - `type-not-joined`: a call of a type the join doesn't join (`SERVES`).
 */
export const JOIN_LEFT_REASONS = [
  "no-host",
  "unresolved-placeholder",
  "host-no-route",
  "label-no-route",
  "target-no-route",
  "generic-path",
  "answered-none",
  "topic-unheard",
  "topic-unresolved",
  "type-not-joined",
] as const;
export type JoinLeftReason = (typeof JOIN_LEFT_REASONS)[number];

/** A call the join left, and why (with `explain`). */
export interface FactJoinLeft {
  call: FactEnd;
  reason: JoinLeftReason;
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
  /** With `explain`: every call left, with why; left out otherwise. */
  left?: FactJoinLeft[];
}

/**
 * G1 (ADR 0174): a person paired a call with an API of another box on the canvas: the entry of a
 * repo it reaches (by id, else by method and path when a read gave it another id), or an outside
 * system's operation. Written as a `link` line in the caller's corrections file.
 */
export interface PersonPair {
  /** The repo whose entry the call reaches; or `system` for an outside system. */
  repo?: string;
  system?: string;
  /** The entry's fact id when it was paired. */
  entry?: string;
  method?: string;
  path: string;
  by: string;
  /** ADR 0181: the pairing is the AI's, with its run; joined `joined-by-ai`. */
  ai?: JoinAi;
  /**
   * Review round 48: a person said the call reaches none (their `unlink` is the newest): no
   * pairing, and an AI answer naming a target doesn't join it (a person's answer still does).
   */
  none?: boolean;
}

export interface JoinFactsInput {
  repos: readonly JoinRepo[];
  /** A person's answer naming the repo or component a call goes to: repo → call fact id → name. */
  targets?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * ADR 0181: of `targets`, those the AI answered (repo → call fact id → its run): joined
   * `joined-by-ai`, never `joined-by-answer`, so no reader takes them as a person's word.
   */
  aiTargets?: Readonly<Record<string, Readonly<Record<string, JoinAi>>>>;
  /** G1: a person's pairings, caller repo → call fact id → what it reaches. They outrank answers. */
  pairs?: Readonly<Record<string, Readonly<Record<string, PersonPair>>>>;
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
  /**
   * The folders of a gateway's proxy bundles (ADR 0147, the org pack's conventions.yaml): an
   * entry cited under one is a gateway route whatever its repo. Default `APIGEE_BUNDLE`'s.
   */
  bundleFolders?: readonly string[];
  /**
   * G4: follow a call through the gateway routes it lands on to the service behind them (the
   * stack helper `gateway-walk`). False: a call is joined to the route it lands on, in the
   * gateway's repo, and the route's forwarding call is joined on its own. Default true.
   */
  walkGateways?: boolean;
  /** Say why each call left unjoined, unasked and not outside was left (`left`). Default false. */
  explain?: boolean;
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

/**
 * The segments of the paths read lately, as `segments` gives them: a join compares the same few
 * thousand paths millions of times. Bounded, and pure (the same path, the same segments).
 */
const SEGMENTS_SEEN = new Map<string, readonly string[] | undefined>();
const SEGMENTS_SEEN_MAX = 100_000;

/** Path segments as compared: lower case, parameters `{}`, a catch-all `**`. */
function segments(path: string): readonly string[] | undefined {
  if (SEGMENTS_SEEN.has(path)) return SEGMENTS_SEEN.get(path);
  const out = segmentsOf(path);
  if (SEGMENTS_SEEN.size >= SEGMENTS_SEEN_MAX) SEGMENTS_SEEN.clear();
  const frozen = out ? Object.freeze(out) : undefined;
  SEGMENTS_SEEN.set(path, frozen);
  return frozen;
}

function segmentsOf(path: string): string[] | undefined {
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

/**
 * The question for a gateway's forwarding call whose host nothing resolves. A host still written
 * as a token (`@targetUrl@`, `{{host}}`, `${HOST}`) is most often one a deploy tool's file sets
 * per environment (the Apigee config plugin's `config.json`), which a read before beta.24 didn't
 * record: the next step it says is to read the gateway repo again, never a guess at a repo.
 */
export function forwardHostQuestion(host: string, repo: string, prefix?: string): string {
  if (!placeholderIn(host)) return hostQuestionText(host);
  // Beta.27: asked once per token and path prefix (as the targets questions group, Q1), when the
  // token's calls span more than one: each question names the routes it is about.
  const routes = prefix ? ` for the routes under ${prefix === "/" ? "" : prefix}/**` : "";
  return `Which repo answers on ${host}? ${repo}'s target URL${routes} is a token no fact sets. If a deploy file sets it per environment (the Apigee config plugin's config.json), read ${repo} again with your assistant (Read with my assistant): the read records each environment's value, and the calls join where they go. Else name the repo or the outside system that answers.`;
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

/**
 * Beta.25 review: the path a URL writes after its host, the host a placeholder or not
 * (`https://${GATEWAY_HOST}/northwind-wallets/1.0`, `${GATEWAY_URL}/northwind-wallets/1.0`), when
 * it writes one and no placeholder is left in it.
 */
function pathAroundPlaceholder(s: string | undefined): string | undefined {
  const t = (s ?? "").trim();
  const p =
    urlPathOf(t) ??
    (() => {
      const ph = placeholderIn(t);
      if (!ph || ph.before.trim()) return undefined;
      const after = ph.after.split(/[?#]/, 1)[0] ?? "";
      return after.startsWith("/") && after !== "/" ? after : undefined;
    })();
  return p && !placeholderIn(p) ? p : undefined;
}

/**
 * The public top-level names a host may end in for the outside rule to place it by its last two
 * labels (`northwind.com`): the generic ones in common use and the reserved `example` the
 * fixtures use. Beta.25 review: a name ending in anything else is placed only as `PUBLIC_TLDS_3`
 * says, or not at all (`.corp`, `.local`, `.internal`, `.lan`, `.svc`, `.int`, `.api`, a
 * Kubernetes namespace such as `wallets.qa` or `wallets.payments`), and is asked about.
 */
const PUBLIC_TLDS: ReadonlySet<string> = new Set([
  "com",
  "net",
  "org",
  "io",
  "ai",
  "co",
  "cloud",
  "biz",
  "info",
  "tech",
  "xyz",
  "gov",
  "edu",
  "mil",
  "example",
]);
/**
 * Beta.25 review: public top-level names that are also words a team names a Kubernetes namespace
 * or an environment by (`dev`, `app`, `bank`, `pay`, a two-letter code such as `qa`, `uk`, `de`).
 * A host ending in one is placed only with three labels or more (a registrable domain and a host
 * label, `api.northwind.dev`); with two (`forge-wallets.dev`, `wallets.qa:8080`) it is a Service
 * and its namespace as likely as a public name, and asked about.
 */
const PUBLIC_TLDS_3: ReadonlySet<string> = new Set([
  "dev",
  "app",
  "online",
  "site",
  "pro",
  "services",
  "solutions",
  "systems",
  "digital",
  "finance",
  "bank",
  "pay",
  "money",
  "global",
  "group",
  "company",
  "network",
  "software",
]);
/** The common public suffixes of two labels: a registrable domain under them has three. */
const TWO_PART_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "ltd.uk",
  "plc.uk",
  "net.uk",
  "nhs.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "co.nz",
  "org.nz",
  "net.nz",
  "govt.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "ac.jp",
  "co.in",
  "net.in",
  "org.in",
  "gov.in",
  "co.za",
  "org.za",
  "com.br",
  "com.cn",
  "com.hk",
  "com.sg",
  "com.mx",
  "com.tr",
  "com.tw",
  "co.kr",
  "co.il",
  "com.ar",
  "com.my",
  "com.ph",
  "com.pk",
  "com.sa",
  "com.ua",
  "co.id",
  "co.th",
]);

/**
 * A host's registrable domain (`northwind.example` for `api.northwind.example`,
 * `northwind.co.uk` for `api.northwind.co.uk`), or undefined for a name the outside rule can't
 * place: one label, `localhost`, an address, a private or in-cluster name (`.corp`, `.svc`), a
 * Service and its namespace (`wallets.payments`, `wallets.qa`, `forge-wallets.dev`: two labels
 * whose last is no `PUBLIC_TLDS` name). A wildcard and a port are left off.
 */
export function registrableDomain(host: string): string | undefined {
  const h = host.trim().toLowerCase().replace(/^\*\./, "").replace(/:\d+$/, "").replace(/\.$/, "");
  if (!h || /[[\]:]/.test(h) || /^[\d.]+$/.test(h) || h === "localhost") return undefined;
  const ls = h.split(".");
  if (ls.length < 2 || ls.some((l) => !l)) return undefined;
  const tld = ls.at(-1)!;
  if (TWO_PART_SUFFIXES.has(ls.slice(-2).join(".")))
    return ls.length >= 3 ? ls.slice(-3).join(".") : undefined;
  if (PUBLIC_TLDS.has(tld)) return ls.slice(-2).join(".");
  if ((PUBLIC_TLDS_3.has(tld) || /^[a-z]{2}$/.test(tld)) && ls.length >= 3)
    return ls.slice(-2).join(".");
  return undefined;
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
    // A host still written as a token (`https://{{ host }}/v1`) is no host yet.
    return u.host && !/[{}@$\s]/.test(u.host)
      ? { ...u, ...(named ? { named: Number(named) } : {}) }
      : undefined;
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
 * written around it, `https://${HOST}/v2`), `env:X` as the whole value, or a build or deploy
 * token `@X@` (Maven filtering, a gateway bundle's token replace from CI properties). With two in one value
 * (`${SCHEME}://${HOST}/v1`) this is the first, the rest left in `after`.
 */
/**
 * The token forms besides `${X}` and `env:X`, as public tools write them: a build or deploy
 * token `@name@` (Maven resource filtering, an Apigee bundle's replace step from CI properties)
 * and a template's `{{name}}` (Mustache, Jinja, a CI variable). A Helm expression (`{{ .Values.x
 * }}`) names no setting by itself and isn't one.
 */
/**
 * The re-review of beta.28.1: a build or deploy token that is the whole host of a value (`@x@`,
 * `https://@x@/v1`, `@x@:8443`), never one that is only part of it (`api-@env@.forge.internal`).
 */
const WHOLE_HOST_TOKEN = /^(?:[a-z][a-z0-9+.-]*:\/\/)?@[A-Za-z_][A-Za-z0-9_.-]*@(?:[/:?#]|$)/i;

const TOKEN_FORMS: readonly RegExp[] = [
  /@([A-Za-z_][A-Za-z0-9_.-]*)@/,
  /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/,
];

/**
 * Beta.25: a Camel Simple expression (`${header.id}`, `${body}`, `${exchangeProperty.x}`) is the
 * route's message, read at run time, never a setting.
 */
const CAMEL_SIMPLE =
  /^(headers?|body|in\.(headers?|body)|out\.(headers?|body)|exchangeProperty|exchangeId|camelContext|routeId|messageTimestamp)(\.|$|\[)/;

export function placeholderIn(
  s: string | undefined,
): { name: string; fallback?: string; before: string; after: string } | undefined {
  const t = (s ?? "").trim();
  const env = /^env:([A-Za-z_][A-Za-z0-9_.-]*)$/i.exec(t);
  if (env) return { name: env[1]!, before: "", after: "" };
  type Found = { at: number; end: number; name: string; fallback?: string };
  // Beta.25 review: the first placeholder by position, whatever its form
  // (`{{forge.ledger.base-uri}}/accounts/${header.id}` names `forge.ledger.base-uri`).
  let dollar: Found | undefined;
  for (let i = t.indexOf("${"); i >= 0 && !dollar; i = t.indexOf("${", i + 2)) {
    let depth = 0;
    let j = i + 2;
    for (; j < t.length; j++) {
      if (t[j] === "{") depth++;
      else if (t[j] === "}") {
        if (depth === 0) break;
        depth--;
      }
    }
    if (j >= t.length) break;
    const inner = t.slice(i + 2, j);
    const colon = inner.indexOf(":");
    const name = (colon < 0 ? inner : inner.slice(0, colon)).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.[\]-]*$/.test(name) || CAMEL_SIMPLE.test(name)) continue;
    const fallback = colon < 0 ? undefined : inner.slice(colon + 1).trim();
    dollar = { at: i, end: j + 1, name, ...(fallback ? { fallback } : {}) };
  }
  // The token forms, each set by the same config facts by its name: the first in the value.
  const token = TOKEN_FORMS.flatMap((re) => {
    const m = re.exec(t);
    return m ? [{ at: m.index, end: m.index + m[0].length, name: m[1]! } as Found] : [];
  }).sort((a, b) => a.at - b.at)[0];
  const first = [dollar, token].filter((x): x is Found => !!x).sort((a, b) => a.at - b.at)[0];
  if (!first) return undefined;
  return {
    name: first.name,
    ...(first.fallback ? { fallback: first.fallback } : {}),
    before: t.slice(0, first.at),
    after: t.slice(first.end),
  };
}

/**
 * A setting's name as a placeholder finds it: letter case, `.`, `-`, `_` and list brackets aside,
 * as Spring's relaxed binding reads `PAYMENTS_URL` for `${payments.url}`.
 */
export const settingNameKey = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * J0: an environment variable a Deployment sets `valueFrom` a ConfigMap's or a Secret's key, as
 * the reader writes it: `configMapKeyRef:<name>/<key>` or `secretKeyRef:<name>/<key>`.
 */
export function keyRefIn(
  s: string | undefined,
): { secret: boolean; name: string; key: string } | undefined {
  const m = /^(configMapKeyRef|secretKeyRef):([^/\s]+)\/([^/\s]+)$/.exec((s ?? "").trim());
  return m ? { secret: m[1] === "secretKeyRef", name: m[2]!, key: m[3]! } : undefined;
}

/** A Secret's value the join may read: a host and nothing else (no user, path, query or fragment). */
const PLAIN_HOST = /^(?:https?:\/\/)?[a-z0-9][a-z0-9.-]*(?::\d+)?\/?$/i;

/** How many placeholders deep a value is followed (`${A}` set to `${B}` set to a host). */
const MAX_PLACEHOLDER_DEPTH = 4;

/** A value with its placeholders resolved: the settings it went through and what it guessed (J0). */
interface Resolved {
  value: string;
  through: (Node & { fact: Config })[];
  guesses: JoinHostGuess[];
}

/** Join every call of the estate's facts to the entry that serves it, or say why not. */
export function joinFacts(input: JoinFactsInput): FactsJoinResult {
  return runSteps(joinFactsSteps(input));
}

/**
 * Beta.28.1 (the review of "nothing slow runs silently"): joinFacts, giving way every
 * JOIN_YIELD_EVERY calls, so a caller that awaits `tick` between (joinFactsAsync) lets a
 * heartbeat, a Console line or a Stop through during a long join. The same join either way.
 */
export function joinFactsAsync(
  input: JoinFactsInput,
  tick: () => Promise<void>,
): Promise<FactsJoinResult> {
  return runStepsAsync(joinFactsSteps(input), tick);
}

/** How many calls the join reads between two points where it gives way. */
export const JOIN_YIELD_EVERY = 200;

/** Work written as steps (a generator that yields where it may give way), run to its end. */
export function runSteps<T>(g: Generator<void, T, void>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/** The same, awaiting `tick` at each point it may give way. */
export async function runStepsAsync<T>(
  g: Generator<void, T, void>,
  tick: () => Promise<void>,
): Promise<T> {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    await tick();
  }
}

/** joinFacts as steps: see joinFactsAsync. */
export function* joinFactsSteps(input: JoinFactsInput): Generator<void, FactsJoinResult, void> {
  let read = 0;
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
  /** Each repo's nodes and config nodes, in `nodes`' order: looked up, never scanned. */
  const nodesByRepo = new Map<string, Node[]>();
  for (const n of nodes) {
    const l = nodesByRepo.get(n.repo);
    if (l) l.push(n);
    else nodesByRepo.set(n.repo, [n]);
  }
  const configsByRepo = new Map<string, (Node & { fact: Config })[]>();
  /** The config nodes by the setting's name as a placeholder names it (`settingNameKey`). */
  const configsByName = new Map<string, (Node & { fact: Config })[]>();
  for (const n of configNodes) {
    const l = configsByRepo.get(n.repo);
    if (l) l.push(n);
    else configsByRepo.set(n.repo, [n]);
    const k = settingNameKey(n.fact.key);
    const m = configsByName.get(k);
    if (m) m.push(n);
    else configsByName.set(k, [n]);
  }
  /** The calls made from each entry (`from`, a gateway route's forwarding calls), by repo. */
  const callsFrom = new Map<string, (Node & { fact: Call })[]>();
  for (const n of nodes) {
    if (n.fact.kind !== "call" || !n.fact.from) continue;
    const k = key(n.repo, n.fact.from);
    const l = callsFrom.get(k);
    if (l) l.push(n as Node & { fact: Call });
    else callsFrom.set(k, [n as Node & { fact: Call }]);
  }
  const entriesByRepo = new Map<string, (Node & { fact: Entry })[]>();
  for (const e of entries) {
    const l = entriesByRepo.get(e.repo);
    if (l) l.push(e);
    else entriesByRepo.set(e.repo, [e]);
  }
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
  const setsFor = (n: Node & { fact: Config }, owner: Node): "cited" | "folder" | false => {
    const names = new Set([owner.component, factIdPart(owner.repo)]);
    if (n.fact.target && names.has(factIdPart(n.fact.target))) return "cited";
    if (n.repo === owner.repo)
      return n.component === owner.component || !n.fact.component ? "cited" : false;
    if (n.component === owner.component) return "cited";
    const deployed = deploysIn.get(key(n.repo, n.fact.cite.file));
    if (deployed && [...names].some((x) => deployed.has(x))) return "cited";
    // Only a folder named like the component: a guess (J0), though the line is cited.
    const parts = n.fact.cite.file.split("/");
    if (parts.some((p) => names.has(factIdPart(p.replace(/\.[^.]*$/, ""))))) return "folder";
    return false;
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
   * The ConfigMap's (or Secret's) entries a `valueFrom` setting names: config facts with its key,
   * in the setting's repo or the caller's, whose ConfigMap is the one named: a `cite.with` line
   * gives its name (the `metadata.name` line), a folder or file is named for it, or a deploy fact
   * in the file deploys it.
   */
  const refTargets = (
    s: Node & { fact: Config },
    owner: Node,
    seen: ReadonlySet<string>,
  ): (Node & { fact: Config })[] => {
    const ref = keyRefIn(s.fact.value ?? s.fact.source);
    if (!ref) return [];
    const name = factIdPart(ref.name);
    return configNodes.filter((t) => {
      if (t === s || seen.has(key(t.repo, t.fact.id))) return false;
      if (t.repo !== s.repo && t.repo !== owner.repo) return false;
      if (t.fact.key !== ref.key || keyRefIn(t.fact.value ?? t.fact.source)) return false;
      if ((t.fact.cite.with ?? []).some((w) => factIdPart(w.value) === name)) return true;
      if (t.fact.cite.file.split("/").some((x) => factIdPart(x.replace(/\.[^.]*$/, "")) === name))
        return true;
      return !!deploysIn.get(key(t.repo, t.fact.cite.file))?.has(name);
    });
  };
  /**
   * A value with its placeholders resolved, once per setting that sets it (one per environment,
   * say), each with the config facts it went through; a placeholder nothing sets takes its
   * Spring default. A value nothing resolves gives none; a ring of placeholders ends.
   */
  /**
   * Beta.28.1 (the review of field report 4, S1): the build or deploy token (`@name@`) a value
   * comes to through the settings its placeholders name for the owner, unset (resolve drops it):
   * `${forge.limits.url}` -> `forge.limits.url: "@forgeLimitsUrl@"`. Undefined when none does.
   */
  const tokenBehind = (raw: string | undefined, owner: Node, depth = 0): string | undefined => {
    const v = raw?.trim();
    if (!v) return undefined;
    if (WHOLE_HOST_TOKEN.test(v)) return v;
    const p = placeholderIn(v);
    if (!p || depth >= MAX_PLACEHOLDER_DEPTH) return undefined;
    for (const s of configsByName.get(settingNameKey(p.name)) ?? []) {
      if (!setsFor(s, owner)) continue;
      const t = tokenBehind(s.fact.value ?? s.fact.source, owner, depth + 1);
      if (t) return t;
    }
    return undefined;
  };
  const resolve = (
    raw: string | undefined,
    owner: Node,
    seen: ReadonlySet<string>,
    depth = 0,
    /**
     * Beta.27: only the settings for the owner itself (`setsFor`'s `cited`): no folder-name or
     * platform-setting guess. A gateway bundle's deploy token takes this.
     */
    own = false,
  ): Resolved[] => {
    const v = raw?.trim();
    if (!v) return [];
    const p = placeholderIn(v);
    if (!p) return SECRETISH.test(v) ? [] : [{ value: v, through: [], guesses: [] }];
    if (depth >= MAX_PLACEHOLDER_DEPTH) return [];
    if (placeholderIn(p.after)) {
      // Two or more in one value: each is resolved on its own, and kept only with one value.
      const head = resolve(v.slice(0, v.length - p.after.length), owner, seen, depth, own);
      const tail = resolve(p.after, owner, seen, depth, own);
      if (new Set(head.map((r) => r.value)).size !== 1) return [];
      if (new Set(tail.map((r) => r.value)).size !== 1) return [];
      return [
        {
          value: `${head[0]!.value}${tail[0]!.value}`,
          through: [...head, ...tail].flatMap((r) => r.through),
          guesses: guessList([...head, ...tail].flatMap((r) => r.guesses)),
        },
      ];
    }
    const want = settingNameKey(p.name);
    const out: Resolved[] = [];
    const named = (configsByName.get(want) ?? []).filter((s) => !seen.has(key(s.repo, s.fact.id)));
    const mine = named.flatMap((s) => {
      const how = setsFor(s, owner);
      if (own && how !== "cited") return [];
      const guess: JoinHostGuess[] = how === "folder" ? [JOINED_BY_FOLDER_NAME] : [];
      return how ? [{ s, guess }] : [];
    });
    const settings: { s: Node & { fact: Config }; guess: JoinHostGuess[] }[] =
      mine.length || own
        ? mine
        : named
            .filter((x) => setsForAll(x, owner))
            .map((s) => ({ s, guess: [JOINED_BY_PLATFORM_SETTING as JoinHostGuess] }));
    // A ConfigMap's entry a `valueFrom` here follows is read through it, not as a setting itself.
    const viaRef = new Set(
      settings.flatMap(({ s }) => refTargets(s, owner, seen).map((t) => key(t.repo, t.fact.id))),
    );
    for (const { s, guess } of settings.filter(({ s: x }) => !viaRef.has(key(x.repo, x.fact.id)))) {
      const k = key(s.repo, s.fact.id);
      const ref = keyRefIn(s.fact.value ?? s.fact.source);
      if (ref) {
        for (const t of refTargets(s, owner, seen)) {
          const tv = t.fact.value?.trim() ?? "";
          // A Secret's value is read only when it is a plain host; anything else is left alone.
          const rs = ref.secret
            ? PLAIN_HOST.test(tv)
              ? [{ value: tv, through: [], guesses: [] }]
              : []
            : resolve(
                t.fact.value,
                owner,
                new Set([...seen, k, key(t.repo, t.fact.id)]),
                depth + 1,
                own,
              );
          for (const r of rs)
            out.push({
              value: `${p.before}${r.value}${p.after}`,
              through: [s, t, ...r.through],
              guesses: guessList([...guess, ...r.guesses]),
            });
        }
        continue;
      }
      for (const r of resolve(
        s.fact.value ?? s.fact.source,
        owner,
        new Set([...seen, k]),
        depth + 1,
        own,
      ))
        out.push({
          value: `${p.before}${r.value}${p.after}`,
          through: [s, ...r.through],
          guesses: guessList([...guess, ...r.guesses]),
        });
    }
    if (out.length || !p.fallback) return out;
    return resolve(p.fallback, owner, seen, depth + 1, own).map((r) => ({
      ...r,
      value: `${p.before}${r.value}${p.after}`,
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
  const topicsOf = (n: Node, path: string): Resolved[] =>
    placeholderIn(path) ? resolve(path, n, new Set()) : [{ value: path, through: [], guesses: [] }];
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
    hosts: {
      pattern: string;
      by: Exposure[];
      listed?: true;
      /** J1: the exposures that gave it as a Service's short name, with the Service's namespace. */
      short?: Map<Exposure, string>;
    }[];
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
  const addHost = (g: Reached, pattern: string, by?: Exposure, shortIn?: string) => {
    let h = g.hosts.find((x) => x.pattern.toLowerCase() === pattern.toLowerCase());
    if (h) {
      if (by) h.by.push(by);
    } else {
      h = { pattern, by: by ? [by] : [], ...(by ? {} : { listed: true as const }) };
      g.hosts.push(h);
    }
    if (by && shortIn !== undefined) (h.short ??= new Map()).set(by, shortIn);
  };
  /** J1: the namespaces each caller's own Service is cited in (its in-cluster address). */
  const ownNamespaces: { repo: string; component: string | undefined; namespace: string }[] = [];
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
    // beta.10: `<repo>/<module>`, a module the manifest doesn't list, as the repo's facts name it.
    const inRepo = /^([^/]+)\/([^/]+)$/.exec(n.fact.exposes.trim());
    if (inRepo) {
      const repo = repoIds.get(factIdPart(inRepo[1]!)) ?? mainOf.get(factIdPart(inRepo[1]!));
      const mod = factIdPart(inRepo[2]!);
      const named = repo
        ? nodes.find(
            (x) =>
              x.repo === repo &&
              (x.component === mod || x.component === factIdPart(`${repo}-${mod}`)),
          )
        : undefined;
      return named ? own(named.repo, named.component) : undefined;
    }
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
  /** The exposures an open finding disputes: their host, and their base path (J1). */
  const hostDisputed = new Set<Exposure>();
  const pathDisputed = new Set<Exposure>();
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
    // beta.10: a Service's in-cluster address, by each name a call in the cluster reaches it by;
    // never a conflict with the manifest's hosts, which say where it is reached from outside.
    const inCluster =
      x.fact.host && /^service$/i.test(x.fact.resourceType ?? "")
        ? clusterServiceAddress(x.fact.host)
        : undefined;
    if (inCluster) {
      ownNamespaces.push({ ...owner, namespace: inCluster.namespace });
      for (const h of clusterServiceHosts(inCluster))
        addHost(g, h, x, isShortServiceHost(h) ? inCluster.namespace : undefined);
    } else if (x.fact.host) {
      const host = x.fact.host;
      if (g.manifestHosts.length && !g.manifestHosts.some((p) => hostMatches(p, host))) {
        hostDisputed.add(x);
        exposure.push({
          reason: "host-conflict",
          exposure: end(x),
          repo: owner.repo,
          component,
          fact: host,
          manifest: [...g.manifestHosts],
          message: `${component} is reached on ${host}${env} by ${where}, and repos.manifest.yaml lists ${g.manifestHosts.join(", ")} for ${holder}: both are joined; list the host in the manifest, or correct the one that is wrong`,
        });
      }
      addHost(g, host, x);
    }
    if (x.fact.basePath) {
      // J1, beta.10: a base path written as a regular expression is its plain prefix.
      const path = plainPathPrefix(x.fact.basePath);
      if (g.manifestBase && !sameSegments(pathSegments(g.manifestBase), pathSegments(path))) {
        pathDisputed.add(x);
        exposure.push({
          reason: "base-path-conflict",
          exposure: end(x),
          repo: owner.repo,
          component,
          fact: path,
          manifest: [g.manifestBase],
          message: `${component} is reached under ${path}${env} by ${where}, and repos.manifest.yaml gives ${g.manifestBase} for ${holder}: both are joined; set the manifest's basePath to it, or correct the one that is wrong`,
        });
      }
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
        // J1: a host or base path only an exposure an open finding disputes gives.
        disputed:
          (!h.listed && h.by.some((x) => hostDisputed.has(x))) ||
          (!p.listed && p.by.some((x) => pathDisputed.has(x))),
        // J1: a host only Services' short names give: the namespaces it resolves in.
        shortIn:
          !h.listed && h.by.length && h.by.every((x) => h.short?.has(x))
            ? [...new Set(h.by.map((x) => h.short!.get(x)!))]
            : undefined,
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
        disputed: () => false,
        byServiceName: () => false,
      };
    const owns = (d: (typeof declared)[number]) => (e: Node) =>
      d.component ? e.component === d.component : e.repo === d.repo;
    const targets = [...new Set(all.map((d) => d.component ?? d.repo))].sort();
    return {
      scope: (e: Node) => all.some((d) => owns(d)(e)),
      target: targets.join(", "),
      key: targets.join("|"),
      by: uniqueEnds(all.flatMap((d) => d.by)),
      /** Whether what joins the entry rests on a host or base path an open finding disputes. */
      disputed: (e: Node) => all.some((d) => d.disputed && owns(d)(e)),
      /**
       * J1: whether the entry is reached by a Service's short name the caller's own namespace,
       * as cited, doesn't resolve: none of the caller's Services is cited in the Service's.
       */
      byServiceName: (e: Node, caller: Node) => {
        const mine = new Set(
          ownNamespaces
            .filter((o) =>
              o.component ? caller.component === o.component : caller.repo === o.repo,
            )
            .map((o) => o.namespace),
        );
        return all.some((d) => !!d.shortIn && owns(d)(e) && !d.shortIn.some((ns) => mine.has(ns)));
      },
    };
  };

  const outside = new Set((input.outside ?? []).map(factIdPart));
  /**
   * The outside system the profile lists by a host, as the host or, beta.25 review, as the host
   * without its port (a system listed as `pay.northwind.example` takes `pay.northwind.example:8443`):
   * the name the profile gives it, or undefined.
   */
  const outsideByHost = (h: string): string | undefined => {
    if (outside.has(factIdPart(h))) return h;
    const bare = h.replace(/:\d+$/, "");
    return bare !== h && outside.has(factIdPart(bare)) ? bare : undefined;
  };
  const joins: FactJoin[] = [];
  const asks: FactJoinAsk[] = [];
  const misses: FactJoinMiss[] = [];
  const outsideCalls: FactJoinOutside[] = [];
  const left: FactJoinLeft[] = [];
  const leave = (c: Node, reason: JoinLeftReason) => {
    if (input.explain) left.push({ call: end(c), reason });
  };

  // ---- the entries by the shape of their path, so a call looks its candidates up (review of
  // beta.24: scanning every entry for every call made a 40-repo estate's join take minutes).
  // `routeScore` is above zero only for a served path with a catch-all, or for one with a literal
  // segment whose last literal is the called path's segment as far from its end: with the same
  // length every literal must match, and where one path ends the other, its tail is the same
  // (and holds a literal). So a served path is indexed by its last literal and how far from the
  // end it is, and a call looks up one bucket per literal segment of its own; `/` is its own.
  const entryOrder = new Map(entries.map((e, i) => [e, i] as const));
  const byLastLiteral = new Map<string, (Node & { fact: Entry })[]>();
  const withCatchAll: (Node & { fact: Entry })[] = [];
  const literal = (s: string) => s !== "{}" && s !== "**";
  const push = (k: string, e: Node & { fact: Entry }) => {
    const l = byLastLiteral.get(k);
    if (l) l.push(e);
    else byLastLiteral.set(k, [e]);
  };
  for (const e of entries) {
    const segs = segments(e.fact.path);
    if (!segs) continue;
    if (segs.includes("**")) {
      withCatchAll.push(e);
      continue;
    }
    if (!segs.length) {
      push("/", e);
      continue;
    }
    for (let k = 0; k < segs.length; k++)
      if (literal(segs[segs.length - 1 - k]!)) {
        push(`${k}\u0000${segs[segs.length - 1 - k]}`, e);
        break;
      }
  }
  /** The entries `routeScore` may score above zero for a called path, in `entries`' order. */
  const routeCandidates = (path: string): readonly (Node & { fact: Entry })[] => {
    const segs = segments(path);
    if (!segs) return [];
    const got: (Node & { fact: Entry })[] = [...withCatchAll];
    if (!segs.length) got.push(...(byLastLiteral.get("/") ?? []));
    for (let k = 0; k < segs.length; k++) {
      const s = segs[segs.length - 1 - k]!;
      if (literal(s)) got.push(...(byLastLiteral.get(`${k}\u0000${s}`) ?? []));
    }
    return got.sort((x, y) => entryOrder.get(x)! - entryOrder.get(y)!);
  };

  /** The entries of a scope that serve a call, best first: score and node. */
  const serving = (c: Node & { fact: Call }, inScope: (e: Node) => boolean, loose: boolean) => {
    const types = SERVES[c.fact.callType] ?? [];
    const scored: { e: Node & { fact: Entry }; score: number }[] = [];
    for (const e of NAMED.has(c.fact.callType) ? entries : routeCandidates(c.fact.path)) {
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

  /**
   * J0 for a call's path: a path written as a setting (`${forge-remote.uris.download-report}`,
   * `config.getUri("download-report")` read as its key) is the value the repo's settings give it,
   * when they give one. A whole URL gives the call its host too, in place of its base. Several
   * values, or none, leave the path as written, and the call is asked about as before.
   */
  const withPathResolved = (call: Node & { fact: Call }): Call => {
    const f = call.fact;
    if (!placeholderIn(f.path)) return f;
    const values = [...new Set(resolve(f.path, call, new Set()).map((r) => r.value.trim()))];
    if (values.length !== 1 || placeholderIn(values[0])) return f;
    const v = values[0]!;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
      const h = hostIn(v);
      if (!h) return f;
      const { base: _base, ...rest } = f;
      return {
        ...rest,
        host: v.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+).*$/i, "$1"),
        path: urlPathOf(v) ?? "/",
      };
    }
    return v.startsWith("/") ? { ...f, path: v } : f;
  };

  // ---- an Apigee proxy's forwarding call (A-gateway, the path suffix). Apigee sends the target
  // its own path with the request's path suffix after it (the part after the proxy's
  // `<BasePath>`), unless the proxy sets `target.copy.pathsuffix` false; a `<BasePath>/**`
  // pass-through sends everything under it. And a service serves its routes under a base path of
  // its own, which its entries may leave out. So a forwarding call whose own path no entry serves
  // as it is joins, per route of the proxy, the entry that serves the target's path and the
  // route's suffix, once the service's base path is taken off.
  const bundle = input.bundleFolders ? gatewayBundleTest(input.bundleFolders) : APIGEE_BUNDLE;
  /** The bundle a file is in: everything up to and including its `apiproxy/`. */
  const bundleRootOf = (file: string): string | undefined => {
    const m = bundle.exec(file);
    return m ? file.slice(0, m.index + m[0].length) : undefined;
  };
  /** The folder a bundle sits in: `wallets/` for `wallets/apiproxy/…`, `` for `apiproxy/…`. */
  const bundleHomeOf = (file: string): string | undefined => {
    const m = bundle.exec(file);
    return m ? file.slice(0, m.index + (m[1]?.length ?? 0)) : undefined;
  };
  const homesSeen = new Map<string, string[]>();
  /** The folders a repo's bundles sit in, as its facts cite them, sorted. */
  const bundleHomesOf = (repo: string): string[] => {
    let hs = homesSeen.get(repo);
    if (!hs) {
      hs = [
        ...new Set(
          (nodesByRepo.get(repo) ?? []).flatMap((n) => {
            const h = bundleHomeOf(n.fact.cite.file);
            return h === undefined ? [] : [h];
          }),
        ),
      ].sort(cmp);
      homesSeen.set(repo, hs);
    }
    return hs;
  };
  /** A path's segments as written (parameters kept), or none for `/`. */
  const rawSegs = (p: string) =>
    (p.trim().split(/[?#]/, 1)[0] ?? "").split("/").filter((s) => s.length > 0);
  const toPath = (segs: readonly string[]) => `/${segs.join("/")}`;
  /** A segment as compared: lower case, a parameter `{}`, a catch-all `**`. */
  const segKey = (s: string) => segments(`/${s}`)?.[0] ?? s;
  const startsWithSegs = (a: readonly string[], b: readonly string[]) =>
    b.length <= a.length && b.every((x, i) => sameSegment(segKey(x), segKey(a[i]!)));
  const endsWithSegs = (a: readonly string[], b: readonly string[]) =>
    startsWithSegs(a.slice(a.length - b.length), b) && b.length <= a.length;
  const isPassThrough = (e: Entry) => rawSegs(e.path).at(-1) === "**";
  /** A route's proxy base path: the `<BasePath>` its citation gives, else a pass-through's. */
  const proxyBaseOf = (
    r: Node & { fact: Entry },
    passes: readonly (Node & { fact: Entry })[],
  ): string[] | undefined => {
    const path = rawSegs(r.fact.path);
    const cited = basePathOf(r.fact);
    if (cited !== r.fact.path) return rawSegs(cited);
    for (const p of passes) {
      const base = rawSegs(p.fact.path).slice(0, -1);
      if (base.length < path.length && startsWithSegs(path, base)) return base;
    }
    return undefined;
  };
  /**
   * Whether the proxy keeps the suffix off (`target.copy.pathsuffix` false): a setting of that
   * name in its bundle or for it (`target`), or the forwarding call's own path set by a policy
   * that turns it off (a `cite.with` line naming it).
   */
  const copyOff = (
    c: Node & { fact: Call },
    root: string,
    routes: readonly (Node & { fact: Entry })[],
  ): { by?: Node } | undefined => {
    if ((c.fact.cite.with ?? []).some((w) => /copy\.pathsuffix$/i.test(w.value.trim()))) return {};
    const proxies = new Set(
      routes.flatMap((r) => (r.fact.handler ? [r.fact.handler.split("/")[0]!] : [])),
    );
    const by = (configsByRepo.get(c.repo) ?? []).find(
      (n) =>
        settingNameKey(n.fact.key).endsWith("COPYPATHSUFFIX") &&
        /^false$/i.test((n.fact.value ?? "").trim()) &&
        (bundleRootOf(n.fact.cite.file) === root ||
          (!!n.fact.target && proxies.has(n.fact.target))),
    );
    return by ? { by } : undefined;
  };
  type BaseCand = { from: JoinBase["from"]; segs: string[]; by: Node[] };
  const BASE_RANK: Record<JoinBase["from"], number> = {
    manifest: 1,
    deploy: 2,
    config: 3,
    url: 4,
    overlap: 4,
  };
  /** A Spring context path's and servlet path's settings, as `settingNameKey` reads them. */
  const CONTEXT_PATH_KEYS = new Set([
    "SERVERSERVLETCONTEXTPATH",
    "SERVERCONTEXTPATH",
    "SPRINGWEBFLUXBASEPATH",
  ]);
  const SERVLET_PATH_KEYS = new Set(["SPRINGMVCSERVLETPATH", "SERVERSERVLETPATH"]);
  const basesSeen = new Map<string, BaseCand[]>();
  /**
   * The base paths an entry's service may serve under, in the order they are taken: the
   * manifest's `basePath`, an exposure's (a Route's or an Ingress's path), then the service's
   * context path and servlet path settings, joined.
   */
  const basesOf = (e: Node & { fact: Entry }): BaseCand[] => {
    const k = key(e.repo, e.component);
    const was = basesSeen.get(k);
    if (was) return was;
    const mod = moduleOf.get(e.component) === e.repo ? e.component : undefined;
    const g = reached.get(`${e.repo}\u0000${mod ?? ""}`);
    const out: BaseCand[] = [];
    if (g?.manifestBase) out.push({ from: "manifest", segs: rawSegs(g.manifestBase), by: [] });
    for (const p of g?.paths ?? [])
      if (!p.listed && p.path && p.by.length)
        out.push({ from: "deploy", segs: rawSegs(p.path), by: [...p.by] });
    const valuesOf = (keys: ReadonlySet<string>) =>
      configNodes
        .filter((n) => keys.has(settingNameKey(n.fact.key)) && setsFor(n, e) === "cited")
        .flatMap((n) =>
          resolve(n.fact.value ?? n.fact.source, e, new Set([key(n.repo, n.fact.id)]))
            .filter((r) => r.value.startsWith("/") && !r.guesses.length)
            .map((r) => ({ segs: rawSegs(r.value), by: [n, ...r.through] as Node[] })),
        );
    const none = [{ segs: [] as string[], by: [] as Node[] }];
    const contexts = valuesOf(CONTEXT_PATH_KEYS);
    const servlets = valuesOf(SERVLET_PATH_KEYS);
    for (const c of contexts.length ? contexts : none)
      for (const s of servlets.length ? servlets : none) {
        const segs = [...c.segs, ...s.segs];
        if (segs.length) out.push({ from: "config", segs, by: [...c.by, ...s.by] });
      }
    basesSeen.set(k, out);
    return out;
  };
  interface SuffixHit {
    e: Node & { fact: Entry };
    route?: Node & { fact: Entry };
    base?: BaseCand;
    method?: string;
    /** The setting that keeps the suffix off (`target.copy.pathsuffix` false), when one does. */
    off?: Node;
  }
  /**
   * The entries an Apigee forwarding call reaches by the path suffix, one per route of its proxy
   * it carries (every entry under the target's path, at most `MAX_PASS_THROUGH_LINKS`, for a
   * pass-through). None when the call isn't in a bundle or no route's path is served.
   */
  const suffixHits = (c: Node & { fact: Call }, inScope: (e: Node) => boolean): SuffixHit[] => {
    const f = c.fact;
    if (f.callType !== "rest") return [];
    const root = bundleRootOf(f.cite.file);
    if (!root) return [];
    const bundled = (entriesByRepo.get(c.repo) ?? []).filter(
      (n) => bundleRootOf(n.fact.cite.file) === root,
    );
    const passes = bundled.filter((n) => isPassThrough(n.fact));
    const flows = bundled.filter((n) => !isPassThrough(n.fact));
    const from = f.from ? bundled.find((n) => n.fact.id === f.from) : undefined;
    const target = rawSegs(f.path);
    const passing = target.at(-1) === "**";
    const t = passing ? target.slice(0, -1) : target;
    const off = copyOff(c, root, bundled);
    // The routes whose requests the call forwards: the one it is from, else the proxy's flows,
    // else its pass-through.
    const routes = from ? [from] : flows.length ? flows : passes;
    const tried: {
      route?: Node & { fact: Entry };
      segs: string[];
      under: boolean;
      off?: true;
      /** How many of `segs`' first segments are the target's own path (not the route's suffix). */
      own: number;
    }[] = [];
    if (!routes.length) tried.push({ segs: t, under: passing, own: t.length });
    for (const r of routes) {
      if (isPassThrough(r.fact)) {
        tried.push({ route: r, segs: t, under: true, own: t.length });
        continue;
      }
      if (off) {
        tried.push({ route: r, segs: t, under: false, off: true, own: t.length });
        continue;
      }
      const base = proxyBaseOf(r, passes);
      if (!base) continue;
      const suffix = rawSegs(r.fact.path).slice(base.length);
      // A forwarding call written with the suffix already on (as the map prompt asks) keeps it.
      const carries = suffix.length > 0 && endsWithSegs(t, suffix);
      tried.push({
        route: r,
        segs: carries ? t : [...t, ...suffix],
        under: false,
        own: carries ? t.length - suffix.length : t.length,
      });
    }
    const out: SuffixHit[] = [];
    for (const x of tried) {
      const method = [f.method, x.route?.fact.method]
        .find((m) => !!m && m.toUpperCase() !== "ANY")
        ?.toUpperCase();
      const score = (segs: readonly string[], e: Entry) => {
        if (!x.under) {
          const s = routeScore(toPath(segs), e.path);
          return s >= 400 ? s : 0;
        }
        const es = rawSegs(e.path);
        return es.includes("**") || !startsWithSegs(es, segs) ? 0 : 1;
      };
      type Hit = SuffixHit & { rank: number; score: number; contradicted?: true };
      const hits: Hit[] = [];
      // Every way to match a route's path (as it is, a base taken off its front) keeps its end,
      // so the entries its whole path's shape looks up are all there are; under a pass-through,
      // any entry the target's path starts.
      for (const e of x.under ? entries : routeCandidates(toPath(x.segs))) {
        if (e.component === c.component || !SERVES.rest!.includes(e.fact.entryType)) continue;
        if (!inScope(e) || !sameMethod(method, e.fact.method) || isPassThrough(e.fact)) continue;
        let hit: Hit | undefined;
        const as = score(x.segs, e.fact);
        if (as) hit = { e, rank: 0, score: as };
        const declared = hit ? [] : basesOf(e);
        for (const b of declared) {
          if (!startsWithSegs(x.segs, b.segs)) continue;
          const s = score(x.segs.slice(b.segs.length), e.fact);
          if (s) {
            hit = { e, base: b, rank: BASE_RANK[b.from], score: s };
            break;
          }
        }
        // Nothing names the base: the longest run of the target's path that starts the entry's,
        // leaving at least one of the target's own segments in the path matched (never the
        // route's suffix alone). A base the service declares that doesn't fit rules out a match
        // by the URL: at most a guess.
        for (let d = 1; !hit && d < x.own; d++) {
          const s = score(x.segs.slice(d), e.fact);
          if (s)
            hit = {
              e,
              base: { from: "overlap", segs: x.segs.slice(0, d), by: [] },
              rank: BASE_RANK.overlap,
              score: s,
              ...(declared.length ? { contradicted: true as const } : {}),
            };
        }
        if (hit) hits.push({ ...hit, ...(x.route ? { route: x.route } : {}) });
      }
      const rank = Math.min(...hits.map((h) => h.rank));
      const ranked = hits.filter((h) => h.rank === rank);
      const best = Math.max(0, ...ranked.map((h) => h.score));
      const kept = x.under
        ? ranked
            .sort((a, b) => cmp(a.e.fact.path, b.e.fact.path) || cmp(a.e.fact.id, b.e.fact.id))
            .slice(0, MAX_PASS_THROUGH_LINKS)
        : ranked.filter((h) => h.score === best);
      // Two entries that serve one route's path as well as each other: no guess between them.
      if (!x.under && kept.length !== 1) continue;
      for (const h of kept)
        out.push({
          e: h.e,
          ...(h.route ? { route: h.route } : {}),
          // One route's whole URL that ends in exactly one entry's path is matched, not guessed.
          ...(h.base
            ? {
                base:
                  h.base.from === "overlap" && !x.under && !h.contradicted
                    ? { ...h.base, from: "url" }
                    : h.base,
              }
            : {}),
          ...(x.off && off?.by ? { off: off.by } : {}),
          ...(method || h.e.fact.method
            ? { method: (method ?? h.e.fact.method)!.toUpperCase() }
            : {}),
        });
    }
    return out;
  };
  const joinBaseOf = (b: BaseCand): JoinBase => ({
    path: toPath(b.segs),
    from: b.from,
    ...(b.by.length ? { by: uniqueEnds(b.by) } : {}),
  });

  /**
   * A setting that replaces, per environment, the element a call's URL is written in: a deploy
   * tool's token for one file of the repo, its `target` that file (by name, with or without its
   * extension) and its `key` the element's path in it (an XPath, `/TargetEndpoint/
   * HTTPTargetConnection/URL`, as the Apigee config plugin's `config.json` writes it). The file is
   * one the call cites (its line or a `cite.with` part) whose element the XPath's root is; the
   * value is the whole URL. One resolver
   * among the others (a placeholder's setting by its name, a base's keyed setting): whatever the
   * file is called, only what the facts say is read.
   */
  const replacedFor = (call: Node & { fact: Call }, token?: string): Resolved[] => {
    // Beta.27: a hostless forwarding call's token, as its `<URL>` part writes it (`forwardTokenOf`).
    const written = call.fact.host ?? call.fact.base ?? token;
    // Beta.25 review: a token is for the file that writes the call's URL: the cited line or part
    // that writes its host or base as the call gives it, when one does (a route's Condition line
    // in `proxies/default.xml` writes no URL), and that file's element is the XPath's root. A
    // bundle keeps each kind in its own folder (`targets/`, `proxies/`, `policies/`), so a
    // `/ProxyEndpoint/...` token for `default.xml` is never the target `default.xml`'s.
    const parts = [call.fact.cite, ...(call.fact.cite.with ?? [])];
    const urlText = (written ?? "").trim();
    const writing = urlText ? parts.filter((p) => p.value.trim() === urlText) : [];
    const cited = (writing.length ? writing : parts).map((p) => p.file);
    const rootFits = (file: string, xpath: string) => {
      const root = /^\/([A-Za-z]+)/.exec(xpath.trim())?.[1]?.toLowerCase();
      const folder = file.split("/").at(-2)?.toLowerCase();
      if (folder === "targets") return root === "targetendpoint";
      if (folder === "proxies") return root === "proxyendpoint";
      if (folder === "policies") return root !== "targetendpoint" && root !== "proxyendpoint";
      return true;
    };
    const forCited = (target: string, xpath: string) => {
      const t = target.trim().toLowerCase();
      return cited.some((file) => {
        const b = (file.split("/").pop() ?? file).toLowerCase();
        return (b === t || b.replace(/\.[^.]*$/, "") === t) && rootFits(file, xpath);
      });
    };
    // Review of beta.24: a bundle's tokens are its own. Two bundles in one repo may each have a
    // `targets/default.xml`; a token is the bundle's whose folder holds its file (the longest),
    // and one in no bundle's folder is the repo's one bundle's, else nobody's.
    const home = bundleHomeOf(call.fact.cite.file);
    const homes = home === undefined ? undefined : bundleHomesOf(call.repo);
    const ownedBy = (file: string) =>
      homes!.filter((h) => file.startsWith(h)).sort((a, b) => b.length - a.length)[0] ??
      (homes!.length === 1 ? homes![0] : undefined);
    // A token whose lines name the placeholder it replaces (`@targetUrl@`) is that one's only.
    const wanted = placeholderIn(written)?.name;
    const tokenNames = (n: Node & { fact: Config }) =>
      [n.fact.source, ...(n.fact.cite.with ?? []).map((w) => w.value)].flatMap((v) => {
        const p = v && /^\s*(@[^@\s]+@|\{\{[^}]+\}\})\s*$/.test(v) ? placeholderIn(v) : undefined;
        return p ? [p.name] : [];
      });
    return (configsByRepo.get(call.repo) ?? [])
      .filter(
        (n) =>
          !!n.fact.target &&
          forCited(n.fact.target, n.fact.key) &&
          n.fact.key.trim().startsWith("/") &&
          /^[a-z][a-z0-9+.-]*:\/\//i.test((n.fact.value ?? "").trim()) &&
          !!hostIn(n.fact.value) &&
          (home === undefined || ownedBy(n.fact.cite.file) === home) &&
          (() => {
            const said = tokenNames(n);
            return !said.length || (!!wanted && said.includes(wanted));
          })(),
      )
      .sort((x, y) => cmp(x.fact.id, y.fact.id))
      .map((n) => ({ value: n.fact.value!.trim(), through: [n], guesses: [] }));
  };
  /** Each host a forwarding call's settings give (one per environment), else its own, sorted. */
  const forwardHosts = (
    configs: readonly { value: string }[],
    host: { host: string; named?: number },
  ): string[] =>
    [
      ...new Set(
        (configs.length ? configs.map((x) => hostIn(x.value)!) : [host]).map((h) =>
          h.named ? `${h.host}:${h.named}` : h.host,
        ),
      ),
    ].sort(cmp);
  let estateDomains: Set<string> | undefined;
  /**
   * Whether a gateway's forwarding call is to a system outside the estate, said by nobody: every
   * host its settings give (one per environment) is a public name (`registrableDomain`) in a
   * registrable domain none of the estate's hosts (the manifest's, the exposures') is in, and no
   * entry of the estate could serve the whole path it sends (as it is, or under a base path its
   * service declares: `servedSomewhere`). A host the rule can't place (one
   * label, a Service and its namespace, a private or in-cluster name, an address) is asked about.
   */
  const outsideOfEstate = (
    call: Node & { fact: Call },
    configs: readonly { value: string }[],
    host: { host: string; named?: number },
    fullPath: string | undefined,
  ): boolean => {
    estateDomains ??= new Set(
      [...reached.values()].flatMap((g) =>
        g.hosts.flatMap((x) => {
          const d = registrableDomain(x.pattern);
          return d ? [d] : [];
        }),
      ),
    );
    const known = estateDomains;
    const hosts = forwardHosts(configs, host);
    if (
      !hosts.length ||
      !hosts.every((h) => {
        const d = registrableDomain(h);
        return !!d && !known.has(d);
      })
    )
      return false;
    if (!configs.length) {
      const p = fullPath ?? call.fact.path;
      return !(p && servedSomewhere(call, p));
    }
    // A service's declared base alone places nothing (beta.25 review: an unrelated service whose
    // context path is `/v1` never makes a vendor's `https://api.northwind.example/v1` the
    // estate's); an entry under it that serves a path the proxy sends to that URL does, and then
    // the URL is that service's for every route the proxy forwards there, served or not.
    const urls = [...new Set(configs.map((x) => x.value))].sort(cmp);
    // Beta.25 review, second round: a URL whose own path is the base a service of the estate
    // declares, one no unrelated service would share (`/ledger-api`, not `/v1` or `/api`), is
    // that service's, though none of its routes is one the proxy sends.
    if (
      urls.some((u) => {
        const p = urlPathOf(u);
        return !!p && isOwnBase(call.component, p);
      })
    )
      return false;
    const k = `${call.repo}\u0000${bundleRootOf(call.fact.cite.file) ?? ""}\u0000${call.fact.host ?? ""}\u0000${call.fact.base ?? ""}\u0000${urls.join("\u0000")}`;
    let served = targetServed.get(k);
    if (served === undefined) {
      const root = bundleRootOf(call.fact.cite.file);
      served = nodes.some(
        (n) =>
          n.fact.kind === "call" &&
          n.repo === call.repo &&
          n.fact.callType === "rest" &&
          (n.fact.host ?? "") === (call.fact.host ?? "") &&
          (n.fact.base ?? "") === (call.fact.base ?? "") &&
          bundleRootOf(n.fact.cite.file) === root &&
          urls.some((u) => {
            const p = joinPaths(urlPathOf(u), (n.fact as Call).path);
            return !!p && servedSomewhere(n as Node & { fact: Call }, p);
          }),
      );
      targetServed.set(k, served);
    }
    return !served;
  };
  /** Whether a forwarding target URL serves some call sent to it (`outsideOfEstate`), by key. */
  const targetServed = new Map<string, boolean>();
  /** A base any service may declare (`/`, `/v1`, `/v1.0`, `/api`, `/rest`, `/services`, `/api/v2`). */
  const genericBase = (segs: readonly string[]) =>
    segs.every((s) => /^(v\d+(\.\d+)*|api|rest|services)$/i.test(s));
  const ownBaseSeen = new Map<string, boolean>();
  /**
   * One node of each component of the estate, entries first (beta.25 review, third round): a
   * component that declares a base but has no entry read yet (its context path setting alone)
   * is asked about, never sent outside. `basesOf` reads a node's repo and component only.
   */
  let baseOwners: (Node & { fact: Entry })[] | undefined;
  const ownersOfBases = () => {
    if (baseOwners) return baseOwners;
    const seen = new Set<string>();
    baseOwners = [];
    for (const n of [...entries, ...nodes]) {
      const k = key(n.repo, n.component);
      if (seen.has(k)) continue;
      seen.add(k);
      baseOwners.push(n as Node & { fact: Entry });
    }
    return baseOwners;
  };
  /**
   * Whether a path is, whole, a base path another component of the estate declares (`basesOf`)
   * that is no common one (`genericBase`).
   */
  const isOwnBase = (component: string, p: string): boolean => {
    const segs = rawSegs(p);
    if (genericBase(segs)) return false;
    const k = `${component}\u0000${segs.join("/").toLowerCase()}`;
    const was = ownBaseSeen.get(k);
    if (was !== undefined) return was;
    const done = new Set<string>();
    let got = false;
    for (const e of ownersOfBases()) {
      if (e.component === component) continue;
      const ek = key(e.repo, e.component);
      if (done.has(ek)) continue;
      done.add(ek);
      if (basesOf(e).some((b) => b.segs.length === segs.length && startsWithSegs(segs, b.segs))) {
        got = true;
        break;
      }
    }
    ownBaseSeen.set(k, got);
    return got;
  };
  /**
   * Whether an entry of the estate could serve a whole path: as it is, or under a base path its
   * service declares (the manifest's `basePath`, a Route's or an Ingress's path, a context path
   * setting), as the path suffix reads them (beta.25 review: a token's URL may be an estate
   * service's own, its context path in front). A base nothing names is never taken off here.
   * Under its base a service's catch-all route (`GET /accounts/**`) serves what it starts; a
   * gateway's route serves only a path of its own shape, never by its pass-through.
   */
  const servedSomewhere = (call: Node & { fact: Call }, p: string): boolean => {
    if (serving({ ...call, fact: { ...call.fact, path: p } }, () => true, true).length) return true;
    if (call.fact.callType !== "rest") return false;
    const segs = rawSegs(p);
    return routeCandidates(p).some((e) => {
      if (
        e.component === call.component ||
        !SERVES.rest!.includes(e.fact.entryType) ||
        !sameMethod(call.fact.method, e.fact.method)
      )
        return false;
      const gatewayRoute = gatewayRepos.has(e.repo) || !!bundleRootOf(e.fact.cite.file);
      if (gatewayRoute && isPassThrough(e.fact)) return false;
      const least = gatewayRoute ? 400 : 100;
      return basesOf(e).some(
        (b) =>
          b.segs.length > 0 &&
          b.segs.length < segs.length &&
          startsWithSegs(segs, b.segs) &&
          routeScore(toPath(segs.slice(b.segs.length)), e.fact.path) >= least,
      );
    });
  };
  const gatewayRepos = new Set(repos.filter((r) => r.gateway).map((r) => r.repo));
  /** A gateway's forwarding call: a REST call in a gateway bundle, or of a repo the manifest types gateway. */
  const isForwarding = (c: Node & { fact: Call }) =>
    c.fact.callType === "rest" && (!!bundleRootOf(c.fact.cite.file) || gatewayRepos.has(c.repo));
  /**
   * Beta.27 (a user's estate): the target URL a gateway's forwarding call that names no host or
   * base goes to, when a line its citation names writes it as a token (the target's `<URL>` line
   * in `cite.with`, `@targetVendorUrl@` or `https://{{host}}/v1`). A read before beta.27 could
   * leave the token out of `host`; the call was then taken for a proxy chained to another and
   * joined to whichever entry served its path. One token, the same on every line, or none.
   */
  const forwardTokenOf = (c: Node & { fact: Call }): string | undefined => {
    if (c.fact.host || c.fact.base || !isForwarding(c)) return undefined;
    const said = new Set(
      [c.fact.cite.value, ...(c.fact.cite.with ?? []).map((w) => w.value)].flatMap((raw) => {
        const v = raw.trim();
        const p = placeholderIn(v);
        if (!p || hostIn(v)) return [];
        // The token is the URL, or its host: nothing but a scheme before it, a path or nothing after.
        const before = p.before.trim();
        if (before && !/^[a-z][a-z0-9+.-]*:\/\/$/i.test(before)) return [];
        return p.after === "" || /^[/:?]/.test(p.after) ? [v] : [];
      }),
    );
    return said.size === 1 ? [...said][0] : undefined;
  };
  /** A gateway route's proxy, as the routes of one proxy share it: its repo and bundle (or handler's proxy). */
  const proxyOf = (r: Node & { fact: Entry }) =>
    key(r.repo, bundleRootOf(r.fact.cite.file) ?? r.fact.handler?.split("/")[0] ?? "");
  type BaseRoute = { r: Node & { fact: Entry }; base: string[] };
  let baseRoutes: { byFirst: Map<string, BaseRoute[]>; all: BaseRoute[] } | undefined;
  /** The estate's gateway routes that cite a `<BasePath>`, by its first segment (`{}` for any). */
  const baseRoutesOf = () => {
    if (baseRoutes) return baseRoutes;
    const all: BaseRoute[] = [];
    const byFirst = new Map<string, BaseRoute[]>();
    for (const e of entries) {
      if (e.fact.entryType !== "rest") continue;
      if (!gatewayRepos.has(e.repo) && !bundleRootOf(e.fact.cite.file)) continue;
      const cited = basePathOf(e.fact);
      if (cited === e.fact.path) continue;
      const base = rawSegs(cited);
      if (!base.length) continue;
      const x = { r: e, base };
      all.push(x);
      const k = segKey(base[0]!);
      const l = byFirst.get(k);
      if (l) l.push(x);
      else byFirst.set(k, [x]);
    }
    baseRoutes = { byFirst, all };
    return baseRoutes;
  };
  /**
   * A call whose host the join can't read (or a gateway's forwarding call that names none, a
   * proxy chained to another), by the whole path it sends: the flows of the proxy whose
   * `<BasePath>` (cited on the route) is the longest that starts the path, as Apigee picks one,
   * each of the same method whose whole path is the call's shape; and the other entries of the
   * estate that serve the whole path as it is (none of a proxy whose BasePath starts it, which
   * the gateway never routes the path to). Undefined when no proxy's BasePath starts the path,
   * two proxies' of the same length do, or no flow under it serves it.
   */
  const byBasePath = (c: Node & { fact: Call }, path: string) => {
    const segs = rawSegs(path);
    if (!segs.length) return undefined;
    const { byFirst, all } = baseRoutesOf();
    const first = segKey(segs[0]!);
    const pool =
      first === "{}" ? all : [...(byFirst.get(first) ?? []), ...(byFirst.get("{}") ?? [])];
    // Beta.25: each proxy (bundle) owns its routes, so a proxy chains to a sibling of its own
    // repo (and component), never to itself.
    const ownBundle = bundleRootOf(c.fact.cite.file);
    const under = pool.filter(
      (x) =>
        (x.r.component !== c.component ||
          (!!ownBundle && proxyOf(x.r) !== key(c.repo, ownBundle))) &&
        x.base.length < segs.length &&
        startsWithSegs(segs, x.base),
    );
    if (!under.length) return undefined;
    const longest = Math.max(...under.map((x) => x.base.length));
    const top = under.filter((x) => x.base.length === longest).map((x) => x.r);
    if (new Set(top.map(proxyOf)).size !== 1) return undefined;
    const scored = top
      .filter((r) => sameMethod(c.fact.method, r.fact.method) && !isPassThrough(r.fact))
      .map((r) => ({ r, score: routeScore(path, r.fact.path) }))
      .filter((x) => x.score >= 400);
    if (!scored.length) return undefined;
    const best = Math.max(...scored.map((x) => x.score));
    const flows = scored
      .filter((x) => x.score === best)
      .map((x) => x.r)
      .sort((x, y) => cmp(x.repo, y.repo) || cmp(x.fact.id, y.fact.id));
    const routed = new Set(under.map((x) => x.r));
    const others = serving(
      { ...c, fact: { ...c.fact, path } },
      (e) => !routed.has(e as Node & { fact: Entry }),
      true,
    );
    return { flows, others };
  };

  for (const c of nodes) {
    if (c.fact.kind !== "call") continue;
    if (++read % JOIN_YIELD_EVERY === 0) yield;
    const raw = c as Node & { fact: Call };
    // The call as the join reads it: its path resolved when written as a setting (J0).
    const resolved = EVENTS.has(raw.fact.callType) ? raw.fact : withPathResolved(raw);
    const call = resolved === raw.fact ? raw : { ...raw, fact: resolved };
    const f = call.fact;
    if (EVENTS.has(f.callType)) {
      if (/^(subscribe|consume|listen)$/i.test(f.method ?? "")) continue;
      // J0: a topic either side gives as a placeholder is each value its settings give it.
      const sent = topicsOf(call, f.path);
      const before = joins.length;
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
        const guesses = guessList([
          ...both.filter((s) => s.value === path).flatMap((s) => s.guesses),
          ...heard.filter((h) => h.value === path).flatMap((h) => h.guesses),
        ]);
        joins.push({
          call: end(call),
          entry: end(e),
          ...(through.length ? { through } : {}),
          ...(entryThrough.length ? { entryThrough } : {}),
          ...(guesses.length ? { guesses } : {}),
          how: "topic",
          callType: f.callType,
          path,
          interface: interfaceId(call.component, e.component, undefined, path),
        });
      }
      if (joins.length === before) leave(call, sent.length ? "topic-unheard" : "topic-unresolved");
      continue;
    }
    if (!SERVES[f.callType]) {
      leave(call, "type-not-joined");
      continue;
    }

    // The config fact that gives the call's base URL ties it to a host; where its value is a
    // placeholder (J0), each value the settings for the caller's component give it does.
    const keyed = f.base
      ? (configsByRepo.get(call.repo) ?? []).filter((n) => n.fact.key === f.base)
      : [];
    type Cand = {
      value: string;
      tie?: Node & { fact: Config };
      through: Node[];
      guesses: JoinHostGuess[];
    };
    const cands: Cand[] = [];
    // Beta.27: a forwarding call's host as its lines write it, when only its `<URL>` part does.
    const token = forwardTokenOf(call);
    const fHost = f.host ?? token;
    // Beta.27: a deploy token in a gateway bundle (`@name@`, `{{name}}`) is set by the bundle's
    // own deploy file (its repo's settings, or one naming it), never by a namesake setting of
    // another repo for no one (a platform setting) or in a folder named like it (J0's guesses).
    const own =
      isForwarding(call) &&
      !!bundleRootOf(f.cite.file) &&
      TOKEN_FORMS.some((re) => re.test(fHost ?? f.base ?? ""));
    if (!hostIn(f.host)) {
      if (placeholderIn(fHost)) cands.push(...resolve(fHost, call, new Set(), 0, own));
      else if (keyed.length)
        for (const t of keyed)
          for (const r of resolve(
            t.fact.value ?? t.fact.source,
            call,
            new Set([key(t.repo, t.fact.id)]),
          ))
            cands.push({ ...r, tie: t });
      else if (placeholderIn(f.base)) cands.push(...resolve(f.base, call, new Set(), 0, own));
      // Nothing by its name: a setting that replaces the element the URL is written in, per
      // environment (one resolver among the placeholders' and the keyed base's).
      if (!cands.some((x) => !!hostIn(x.value))) cands.push(...replacedFor(call, token));
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
    // Beta.25 review: with no host resolved, the path a base still writes around its host's
    // placeholder (`https://${GATEWAY_HOST}/northwind-wallets/1.0`, `${GATEWAY_URL}/v1`): the
    // keyed settings' as written when they agree, so a proxy's BasePath can join the call.
    const unresolvedBase = () => {
      if (host) return undefined;
      if (!keyed.length) return pathAroundPlaceholder(fHost) ?? pathAroundPlaceholder(f.base);
      const ps = new Set(keyed.map((t) => pathAroundPlaceholder(t.fact.value ?? t.fact.source)));
      return ps.size === 1 ? [...ps][0] : undefined;
    };
    const fullPath = joinPaths(
      urlPathOf(f.host) ??
        (used[0] ? urlPathOf(used[0].value) : undefined) ??
        (keyed.length ? undefined : urlPathOf(f.base)) ??
        unresolvedBase(),
      f.path,
    );

    // G1 (ADR 0174): a person's pairing outranks every other way: the entry it names, found by
    // id, else by method and path (a read that gave it another id); none is a miss, said.
    const answer = input.targets?.[call.repo]?.[f.id];
    const aiAnswer = answer ? input.aiTargets?.[call.repo]?.[f.id] : undefined;
    const onFile = input.pairs?.[call.repo]?.[f.id];
    // Review round 48: a person's word stands over the AI's. A person's answer (a "None of these"
    // too) outranks an AI pairing, and a person's "none" on the canvas outranks an AI answer.
    if (onFile?.none && !onFile.ai && aiAnswer) {
      leave(call, "answered-none");
      continue;
    }
    const pair = onFile && !onFile.none && !(onFile.ai && answer && !aiAnswer) ? onFile : undefined;
    if (pair) {
      if (pair.system) {
        // The call's fact carries the person's word (by: person, ADR 0174), from its corrections.
        outsideCalls.push({ call: end(call), target: pair.system });
        continue;
      }
      const m = (x?: string) => (x ?? "").toUpperCase();
      const hit =
        entries.find((e) => e.repo === pair.repo && e.fact.id === pair.entry) ??
        entries.find(
          (e) =>
            e.repo === pair.repo &&
            (!pair.method || !e.fact.method || m(e.fact.method) === m(pair.method)) &&
            normalizePath(e.fact.path) === normalizePath(pair.path),
        );
      if (hit) {
        joins.push({
          call: end(call),
          entry: end(hit),
          ...tie,
          how: "answer",
          paired: {
            by: pair.by,
            ...(pair.ai ? { ai: { runtime: pair.ai.runtime, run: pair.ai.run } } : {}),
          },
          callType: f.callType,
          ...(f.method || hit.fact.method
            ? { method: (f.method ?? hit.fact.method)!.toUpperCase() }
            : {}),
          path: hit.fact.path,
          interface: interfaceOf(call, hit),
        });
      } else {
        const what = [pair.method?.toUpperCase(), pair.path].filter(Boolean).join(" ");
        misses.push({
          call: end(call),
          target: pair.repo ?? "",
          // A repo the join doesn't read (its facts aren't all verified, or not read) isn't one
          // whose entries changed: say what to do, not that the pairing broke.
          message: input.repos.some((r) => r.repo === pair.repo)
            ? `${pair.by} paired ${call.component}'s call with ${what} on ${pair.repo}, and no entry of ${pair.repo} the facts name serves it now`
            : `${pair.by} paired ${call.component}'s call with ${what} on ${pair.repo}, whose facts the join doesn't read yet (not read, or not all verified: atticus verify ${pair.repo}); it joins once they are`,
        });
        leave(call, "target-no-route");
      }
      continue;
    }
    const named = (name: string) => {
      const slug = factIdPart(name);
      // A repo's name covers all its components; a component's, only that one.
      const repo = repoIds.get(slug);
      if (repo) return { scope: (e: Node) => e.repo === repo, target: repo, repo: true };
      if (components.has(slug)) return { scope: (e: Node) => e.component === slug, target: slug };
      return undefined;
    };
    if (answer === NO_TARGET) {
      leave(call, "answered-none");
      continue;
    }
    // C2 (ADR 0135): a target a person set (a correction from the Map) outranks every rule
    // after an answer, the questions included: one naming nothing in the estate is outside it,
    // never asked about, nor joined by its host, a host's label or its path.
    if (!answer && f.by === "person" && f.to && !named(f.to)) {
      if (f.to !== NO_TARGET) outsideCalls.push({ call: end(call), target: f.to });
      else leave(call, "answered-none");
      continue;
    }
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
    let disputed: ((e: Node) => boolean) | undefined;
    let byServiceName: ((e: Node, caller: Node) => boolean) | undefined;
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
      disputed = d.disputed;
      byServiceName = d.byServiceName;
    } else if (host && outsideByHost(host.named ? `${host.host}:${host.named}` : host.host)) {
      // O1: an outside system the profile names by this host takes the call (J0: listed, so a
      // host only a placeholder's setting gives is said outside too).
      outsideCalls.push({
        call: end(call),
        target: outsideByHost(host.named ? `${host.host}:${host.named}` : host.host)!,
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
    } else if (
      host &&
      isForwarding(call) &&
      (forwardHosts(configs, host).some((h) => !!outsideByHost(h)) ||
        outsideOfEstate(call, configs, host, fullPath))
    ) {
      // A gateway's forwarding call to a host no repo or component of the estate lists: outside
      // the estate when the profile lists one of its environments' hosts as an outside system's,
      // or when every one is a public name in a registrable domain none of the estate's hosts is
      // in and no entry of the estate serves the whole path as it is. The gateway then fronts a
      // system outside the estate, never one of the estate's services that happens to serve the
      // same paths. An outside system the profile lists by one of them names it, else the host
      // does. Anything else is asked about, below: a repo whose manifest entry lists no host yet
      // may answer on it, and a private or in-cluster name is no domain to tell apart.
      const hosts = forwardHosts(configs, host);
      outsideCalls.push({
        call: end(call),
        target: hosts.map(outsideByHost).find((h) => !!h) ?? hosts[0]!,
      });
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
      if (GENERIC.test(f.path)) {
        leave(call, "generic-path");
        continue;
      }
      const forwarding = isForwarding(call);
      const namesHost = !!(f.host || f.base || token);
      // Beta.28.1 (field report 4): a host written as a build or deploy token (`@name@`, set by
      // Maven filtering or a gateway's deploy step) that nothing sets is asked about too, in any
      // repo: no file the join reads says where it goes, so a path guess would be an arrow no
      // line cites (the owner's direction: arrows come from a cited line or a person).
      // The review (S1): written on the call's host or base, or as the value of the setting its
      // base names (`forge.limits.url: "@forgeLimitsUrl@"` in a Spring yml), however reached.
      const deployToken = [
        f.host,
        f.base,
        ...keyed.map((t) => t.fact.value ?? t.fact.source),
        ...cands.map((x) => x.value),
        tokenBehind(f.base, call),
      ].find((v): v is string => !!v && WHOLE_HOST_TOKEN.test(v));
      if (namesHost && (forwarding || deployToken)) {
        // A gateway forwards to the host its target names, never to whichever service serves the
        // path: a host nothing resolves is asked about (beta.27: a token only its `<URL>` part
        // writes too; it was joined by its path before, a guess, and nothing was asked).
        const named = forwarding ? (f.host ?? f.base ?? token)! : (f.host ?? deployToken!);
        asks.push({
          call: end(call),
          reason: "unknown-host",
          host: named,
          question: forwardHostQuestion(named, call.repo),
          candidates: [],
        });
        continue;
      }
      // A host or base the call names that nothing resolves, or a gateway's forwarding call that
      // names none (a proxy chained to another, Apigee's LocalTargetConnection `<Path>`): the
      // whole path it sends may start with a gateway proxy's BasePath, whose flow it then reaches
      // (code at both ends). Only when no other entry of the estate serves that whole path as it
      // is; else which is meant is asked. Failing that, a forwarding call is joined by its path,
      // or asked, as before beta.24: never dropped.
      const found = namesHost || forwarding ? byBasePath(call, fullPath ?? f.path) : undefined;
      const viaBase = found && !found.others.length ? found.flows : undefined;
      if (found && found.others.length) {
        asks.push({
          call: end(call),
          reason: "ambiguous",
          question: callTargetQuestion(f, call.component),
          candidates: [...found.flows, ...found.others]
            .map(end)
            .sort((x, y) => cmp(x.repo, y.repo) || cmp(x.fact, y.fact)),
        });
        continue;
      }
      if (viaBase?.length === 1) {
        const e = viaBase[0]!;
        joins.push({
          call: end(call),
          entry: end(e),
          ...tie,
          how: "base-path",
          // Beta.25 review: never verified on a guess. A gateway's forwarding call that names no
          // host goes to its own gateway (a proxy chained to another), so the BasePath is all it
          // takes; a call whose host nothing resolves may go to any host that serves the path,
          // so the join is kept as a guess (by its path), shown so and correctable.
          ...(namesHost ? { inferred: { within: "estate" as const } } : {}),
          callType: f.callType,
          ...(f.method || e.fact.method
            ? { method: (f.method ?? e.fact.method)!.toUpperCase() }
            : {}),
          path: e.fact.path,
          interface: interfaceOf(call, e),
        });
        continue;
      }
      if (viaBase && viaBase.length > 1) {
        asks.push({
          call: end(call),
          reason: "ambiguous",
          question: callTargetQuestion(f, call.component),
          candidates: viaBase.map(end).sort((x, y) => cmp(x.repo, y.repo) || cmp(x.fact, y.fact)),
        });
        continue;
      }
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
    } else {
      hits = serving(call, scope?.scope ?? (() => true), false);
      // An Apigee forwarding call no entry serves as it is (the same shape, not only its end):
      // what the target receives is its path and each route's suffix (the path suffix).
      const asIs =
        hits.length > 0 &&
        (NAMED.has(f.callType) || hits.every((e) => routeScore(f.path, e.fact.path) >= 400));
      const viaSuffix = !asIs && scope ? suffixHits(call, scope.scope) : [];
      if (viaSuffix.length) {
        for (const h of viaSuffix) {
          const e = h.e;
          const guesses =
            how === "host" && !byLabel
              ? guessList([
                  ...used.flatMap((x) => x.guesses),
                  ...(disputed?.(e) ? [JOINED_DESPITE_CONFLICT as JoinHostGuess] : []),
                  ...(byServiceName?.(e, call) ? [JOINED_BY_SERVICE_NAME as JoinHostGuess] : []),
                ])
              : [];
          // A base a Route or an Ingress gives is an exposure the link rests on, as a host is.
          const exposed = [
            ...exposedBy,
            ...(h.base?.from === "deploy" ? uniqueEnds(h.base.by) : []),
          ].filter(
            (x, i, all) => all.findIndex((y) => y.repo === x.repo && y.fact === x.fact) === i,
          );
          joins.push({
            call: end(call),
            entry: end(e),
            ...tie,
            how,
            ...(how === "answer" && aiAnswer ? { aiAnswer: { ...aiAnswer } } : {}),
            ...(byLabel ? { byLabel: true as const } : {}),
            ...(guesses.length ? { guesses } : {}),
            ...(exposed.length ? { exposedBy: exposed } : {}),
            ...(h.route ? { forRoute: end(h.route) } : {}),
            ...(h.base ? { base: joinBaseOf(h.base) } : {}),
            ...(h.off ? { suffixOff: end(h.off) } : {}),
            callType: f.callType,
            ...(h.method ? { method: h.method } : {}),
            path: e.fact.path,
            interface: interfaceId(call.component, e.component, h.method, servedPath(e.fact)),
          });
        }
        continue;
      }
      // An Apigee forwarding call the path suffix joins nowhere is never joined by its path's end
      // alone (the target's whole URL is what the backend receives): it stays a miss.
      if (!asIs && scope && f.callType === "rest" && bundleRootOf(f.cite.file)) hits = [];
    }
    if (hits.length === 1) {
      const e = hits[0]!;
      // J0, J1: the guesses the host rests on, when the host is what joined it.
      const guesses =
        how === "host" && !byLabel
          ? guessList([
              ...used.flatMap((x) => x.guesses),
              ...(disputed?.(e) ? [JOINED_DESPITE_CONFLICT as JoinHostGuess] : []),
              ...(byServiceName?.(e, call) ? [JOINED_BY_SERVICE_NAME as JoinHostGuess] : []),
            ])
          : [];
      joins.push({
        call: end(call),
        entry: end(e),
        ...tie,
        how,
        // ADR 0181: an answer the AI decided is the AI's, never a person's.
        ...(how === "answer" && aiAnswer ? { aiAnswer: { ...aiAnswer } } : {}),
        ...(within ? { inferred: { within, ...(f.to ? { named: f.to } : {}) } } : {}),
        ...(byLabel ? { byLabel: true as const } : {}),
        ...(guesses.length ? { guesses } : {}),
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
      leave(
        call,
        how === "host" ? (byLabel ? "label-no-route" : "host-no-route") : "target-no-route",
      );
    } else if (how === "path")
      // The fallback found no entry: a host or base the code names that nothing resolved, or none.
      leave(call, f.host || f.base ? "unresolved-placeholder" : "no-host");
  }

  // One service serves under one base: where matches by the URL give one service two, neither is
  // read from code, so each stays a guess (`overlap`).
  const urlBases = new Map<string, Set<string>>();
  for (const j of joins)
    if (j.base?.from === "url") {
      const k = key(j.entry.repo, j.entry.component);
      urlBases.set(k, (urlBases.get(k) ?? new Set()).add(j.base.path));
    }
  for (const [i, j] of joins.entries())
    if (j.base?.from === "url" && urlBases.get(key(j.entry.repo, j.entry.component))!.size > 1)
      joins[i] = { ...j, base: { ...j.base, from: "overlap" } };

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
    return (configsByRepo.get(route.repo) ?? [])
      .filter((n) => /^virtualhost$/i.test(n.fact.key) && n.fact.target === proxy)
      .sort((x, y) => cmp(x.fact.id, y.fact.id))[0]?.fact.value;
  };
  const isRoute = (n: Node) =>
    n.fact.kind === "entry" && (gateways.has(n.repo) || bundle.test(n.fact.cite.file));
  const joinsOf = new Map<string, FactJoin[]>();
  const joinsByRoute = new Map<string, FactJoin[]>();
  for (const j of joins) {
    const k = key(j.call.repo, j.call.fact);
    joinsOf.set(k, [...(joinsOf.get(k) ?? []), j]);
    if (!j.forRoute) continue;
    const r = key(j.forRoute.repo, j.forRoute.fact);
    joinsByRoute.set(r, [...(joinsByRoute.get(r) ?? []), j]);
  }
  /**
   * Where the route a join lands on forwards to, when the facts say it exactly: every forwarding
   * call joined, and all to the same entry. Else undefined: the call stays at the gateway.
   */
  const forwardedTo = (route: Node & { fact: Entry }): FactJoin | undefined => {
    const forwards = (callsFrom.get(key(route.repo, route.fact.id)) ?? []).filter(
      (n) => !EVENTS.has(n.fact.callType),
    );
    const mine = (j: FactJoin) =>
      !j.forRoute || (j.forRoute.repo === route.repo && j.forRoute.fact === route.fact.id);
    // The path suffix: the proxy's target call joined for this route, though not `from` it.
    const bySuffix = (joinsByRoute.get(key(route.repo, route.fact.id)) ?? []).filter(
      (j) =>
        byKey.get(key(j.call.repo, j.call.fact))?.fact.kind === "call" &&
        (byKey.get(key(j.call.repo, j.call.fact))!.fact as Call).from !== route.fact.id,
    );
    // A forwarding call that names no host, base or target only says the route forwards, when
    // the proxy's target call says where (joined for this route): it is left out, not a miss.
    const says = (n: Node & { fact: Call }) => !!(n.fact.host || n.fact.base || n.fact.to);
    const got = forwards
      .map((n) => ({ n, js: (joinsOf.get(key(n.repo, n.fact.id)) ?? []).filter(mine) }))
      .filter((x) => x.js.length || !bySuffix.length || says(x.n))
      .map((x) => x.js);
    got.push(...bySuffix.map((j) => [j]));
    if (!got.length || got.some((h) => h.length !== 1)) return undefined;
    const lands = got.map((h) => h[0]!);
    const first = lands[0]!;
    return lands.some((l) => l.entry.repo !== first.entry.repo || l.entry.fact !== first.entry.fact)
      ? undefined
      : first;
  };
  const cycles: FactJoinAsk[] = [];
  for (const [i, j] of joins.entries()) {
    if (j.how === "topic" || input.walkGateways === false) continue;
    let route = byKey.get(key(j.entry.repo, j.entry.fact))!;
    if (!isRoute(route)) continue;
    const caller = byKey.get(key(j.call.repo, j.call.fact))! as Node & { fact: Call };
    const hops: GatewayHop[] = [];
    const walked: FactJoin[] = [];
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
        ...(next.base ? { base: next.base } : {}),
      });
      landed = next;
      walked.push(next);
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
    // The path suffix: a forwarding call that carries routes of several methods takes the route's.
    const forwardMethod = landed.forRoute ? landed.method : forward.method;
    const method = (forwardMethod ?? caller.fact.method ?? callee.fact.method)?.toUpperCase();
    const scopes = [...new Set(hops.flatMap((h) => h.scopes ?? []))];
    // A hop that guessed (by path, by a host's first label, J0, J1) makes the whole link a guess:
    // the walked link is never more certain than its least certain hop (final review).
    const hopGuesses = guessList([...(j.guesses ?? []), ...walked.flatMap((h) => h.guesses ?? [])]);
    const inferred = j.inferred ?? walked.find((h) => h.inferred)?.inferred;
    const byLabel = j.byLabel ?? walked.find((h) => h.byLabel)?.byLabel;
    // A hop a person paired makes the link that person's pairing, citing the hop's call; the
    // caller's own pairing or answer, or the AI's, comes first.
    const hopPaired =
      j.paired || aiOfJoin(j)
        ? undefined
        : walked.flatMap((h) =>
            h.paired && !h.paired.ai ? [{ by: h.paired.by, call: h.paired.call ?? h.call }] : [],
          )[0];
    const paired = j.paired ?? hopPaired;
    // ADR 0181 (ninth UX walk): the caller's own pairing or answer goes on with the walked link,
    // and a hop the AI joined makes the whole link the AI's, never a person's or the code's.
    const hopAi = aiOfJoin(j)
      ? undefined
      : walked.flatMap((h) => {
          const ai = aiOfJoin(h);
          return ai ? [{ ...ai, call: h.call }] : [];
        })[0];
    joins[i] = {
      call: j.call,
      entry: landed.entry,
      ...(j.tie ? { tie: j.tie } : {}),
      ...(j.through ? { through: j.through } : {}),
      how: j.how,
      ...(paired ? { paired } : {}),
      ...(j.aiAnswer ? { aiAnswer: j.aiAnswer } : {}),
      ...(hopAi ? { aiHop: hopAi } : {}),
      ...(inferred ? { inferred } : {}),
      ...(byLabel ? { byLabel } : {}),
      ...(hopGuesses.length ? { guesses: hopGuesses } : {}),
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
  /** Each owner's fields, and each repo's stores that write under an entry: looked up. */
  const fieldsByOwner = new Map<string, (Node & { fact: Field })[]>();
  const writesUnder = new Map<string, (Node & { fact: Store })[]>();
  for (const n of nodes) {
    if (n.fact.kind === "field") {
      const k = key(n.repo, n.fact.owner);
      const l = fieldsByOwner.get(k);
      if (l) l.push(n as Node & { fact: Field });
      else fieldsByOwner.set(k, [n as Node & { fact: Field }]);
    } else if (n.fact.kind === "store" && n.fact.op === "write" && n.fact.under) {
      const k = key(n.repo, n.fact.under);
      const l = writesUnder.get(k);
      if (l) l.push(n as Node & { fact: Store });
      else writesUnder.set(k, [n as Node & { fact: Store }]);
    }
  }
  const fieldsOf = (repo: string, owner: string) => fieldsByOwner.get(key(repo, owner)) ?? [];
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
    for (const n of writesUnder.get(key(repo, entry)) ?? []) {
      const s = n.fact;
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
    ...(input.explain ? { left: left.sort(byEnds) } : {}),
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
 * What a join guessed, as flags in `JOIN_GUESS_FLAGS`' order: by path, by a host's first label
 * (F2), by a platform-wide setting or a setting's folder name (J0), despite an open finding or
 * by a Service's short name (J1). Empty for a join nobody had to guess.
 */
export function joinGuessesOf(
  j: Pick<FactJoin, "inferred" | "byLabel" | "guesses">,
): JoinGuessFlag[] {
  const out: JoinGuessFlag[] = [];
  if (j.inferred) out.push(JOINED_BY_PATH);
  if (j.byLabel) out.push(JOINED_BY_LABEL);
  return [...out, ...guessList(j.guesses ?? [])];
}

/**
 * Whether an Apigee forwarding call on the way matched its entry only by a guessed base path
 * (`joined-by-path-overlap`): the join's own, or a gateway hop's.
 */
export const isOverlapJoin = (j: {
  base?: JoinBase | undefined;
  gateway?: readonly { base?: JoinBase | undefined }[] | undefined;
}): boolean =>
  j.base?.from === "overlap" || (j.gateway ?? []).some((h) => h.base?.from === "overlap");

/** Whether a join guessed its callee anywhere on the way (`joinGuessesOf` gives how). */
export const isGuessedJoin = (
  j: Pick<FactJoin, "inferred" | "byLabel" | "guesses"> & {
    base?: JoinBase | undefined;
    gateway?: readonly { base?: JoinBase | undefined }[] | undefined;
  },
): boolean => joinGuessesOf(j).length > 0 || isOverlapJoin(j);

/**
 * How a join found its callee, as its Interface's flags (C1, ADR 0135): a guess by its own F2
 * flags alone (`JOIN_GUESS_FLAGS`: by path or label, F2; by a platform setting or a folder name,
 * J0; despite a conflict or by a Service's short name, J1), any other by how it was made
 * (`joined-by-answer`, `-name`, `-repo`, `-host`); a publish joined to its listener has none.
 */
/** ADR 0181: the AI run behind a join's own pairing or target answer, if the AI made it. */
export const aiOfJoin = (
  j: Pick<FactJoin, "how" | "paired"> & { aiAnswer?: JoinAi | undefined },
): JoinAi | undefined => j.paired?.ai ?? (j.how === "answer" ? j.aiAnswer : undefined);

export function joinFlagsOf(
  j: Pick<FactJoin, "how" | "inferred" | "byLabel" | "guesses" | "paired"> & {
    aiAnswer?: JoinAi | undefined;
    aiHop?: JoinAi | undefined;
    base?: JoinBase | undefined;
    gateway?: readonly { base?: JoinBase | undefined }[] | undefined;
  },
): string[] {
  // ADR 0181: the AI's pairing or answer is the AI's, never `joined-by-person` or `-answer`; so
  // is a link through a gateway hop the AI joined.
  if (aiOfJoin(j) || j.aiHop) return [JOINED_BY_AI];
  if (j.paired) return [JOINED_BY_PERSON];
  // The path suffix: a base path guessed by the overlap comes first, then how it was found.
  const overlap = isOverlapJoin(j) ? [JOINED_BY_PATH_OVERLAP] : [];
  const guessed = joinGuessesOf(j);
  // Beta.25 review: a join by a BasePath whose caller's host is unknown is found by the BasePath
  // (said first, so its how reads so) and a guess for the host (`joined-by-path`, after it).
  if (guessed.length)
    return j.how === "base-path"
      ? [JOINED_BY_BASE_PATH, ...guessed, ...overlap]
      : [...guessed, ...overlap];
  const HOW: Partial<Record<JoinHow, string>> = {
    answer: JOINED_BY_ANSWER,
    named: JOINED_BY_NAME,
    repo: JOINED_BY_REPO,
    host: JOINED_BY_HOST,
    "base-path": JOINED_BY_BASE_PATH,
  };
  return [...overlap, ...(HOW[j.how] ? [HOW[j.how]!] : [])];
}

type SharedLink = CatalogRecord & {
  kind: "Interface";
  confidence: string;
  flags?: string[];
  evidence: EvidenceT[];
};

/**
 * How a join nobody guessed found its callee, in the order a shared link lists them: the ways
 * code at both ends (and a person's answer naming the target) verify first, then a pairing's,
 * which is a person's or the AI's word and never verifies a link (beta.25 review: a verified link
 * that merged a pairing says first how its verified call was found).
 */
const HOW_FLAG_ORDER: readonly string[] = [
  JOINED_BY_ANSWER,
  JOINED_BY_NAME,
  JOINED_BY_REPO,
  JOINED_BY_HOST,
  JOINED_BY_BASE_PATH,
  JOINED_BY_PERSON,
  JOINED_BY_AI,
];

/**
 * A shared link's flags (ADR 0135, section 5): each once, the union of its joins'. A verified link
 * lists how its cited joins were made first, then the guesses its other calls rest on; an
 * inferred one its guesses first, so the first flag says what the link rests on either way.
 */
export function sharedLinkFlags(flags: readonly string[], confidence: string): string[] {
  const all = new Set(flags);
  const guesses = GUESS_ORDER.filter((f) => all.has(f));
  const hows = HOW_FLAG_ORDER.filter((f) => all.has(f));
  const rest = [...all].filter((f) => !guesses.includes(f) && !hows.includes(f)).sort(cmp);
  if (confidence === "verified") return [...hows, ...guesses, ...rest];
  // Beta.25 review: a link joined by a proxy's BasePath whose only guess is the caller's unknown
  // host (`joined-by-path`) says the BasePath first: that is how it was found.
  if (all.has(JOINED_BY_BASE_PATH) && guesses.length === 1 && guesses[0] === JOINED_BY_PATH)
    return [
      JOINED_BY_BASE_PATH,
      ...guesses,
      ...hows.filter((f) => f !== JOINED_BY_BASE_PATH),
      ...rest,
    ];
  return [...guesses, ...hows, ...rest];
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
  /**
   * A link several calls share (ADR 0135, section 5): the Interface every join of it writes, as
   * one. Its evidence is every join's, its flags their union (`sharedLinkFlags`), and it is
   * verified when one join is: a cited link exists, whatever the other calls guessed.
   */
  const putLink = (r: CatalogRecord) => {
    const was = out.get(r.id) as SharedLink | undefined;
    if (!was || was.kind !== "Interface") {
      out.set(r.id, r);
      return;
    }
    const now = r as SharedLink;
    const confidence =
      was.confidence === "verified" || now.confidence === "verified" ? "verified" : "inferred";
    const flags = sharedLinkFlags([...(was.flags ?? []), ...(now.flags ?? [])], confidence);
    const { flags: _f, ...rest } = was;
    out.set(r.id, {
      ...rest,
      confidence,
      ...(flags.length ? { flags } : {}),
      evidence: once([...was.evidence, ...now.evidence]),
    } as CatalogRecord);
  };
  const flagsOf = joinFlagsOf;
  /** The path suffix: a service's context path settings, cited at its end (a Route's is exposure). */
  const baseLines = (b: JoinBase | undefined): EvidenceT[] =>
    b?.from === "config" ? (b.by ?? []).flatMap((t) => ev(t, "config", "callee")) : [];
  // F2, J0, J1: a guess (by path, a host's first label, a platform setting, a folder name, or
  // despite a conflict) is inferred, however declared its ends are.
  // G1 (ADR 0174): a person's pairing is their word, not code: inferred, with their evidence.
  // ADR 0181: the AI's pairing or answer is no more than the AI's: inferred, with its run.
  const guessed = (j: FactJoin) =>
    isGuessedJoin(j) || !!j.paired || (j.how === "answer" && !!j.aiAnswer) || !!j.aiHop;
  const byPerson = (j: FactJoin): EvidenceT[] => {
    const own = aiOfJoin(j);
    const ai = own ?? j.aiHop;
    // A hop's AI decision cites the hop's forwarding call, where the AI's answer joined it.
    // So does a hop's pairing: the person paired the hop's forwarding call.
    const at = !own && j.aiHop ? j.aiHop.call : !ai && j.paired?.call ? j.paired.call : j.call;
    const call = j.paired || ai ? fact(at) : undefined;
    if (!call) return [];
    if (ai)
      return [
        {
          source: "ai",
          repo: at.repo,
          path: call.cite.file,
          line: call.cite.line,
          side: "caller",
          by: ai.runtime,
          run: ai.run,
        },
      ];
    return [
      {
        source: "manual",
        repo: at.repo,
        path: call.cite.file,
        line: call.cite.line,
        side: "caller",
        by: j.paired!.by,
      },
    ];
  };
  for (const j of result.joins) {
    if (j.how === "topic") {
      // As the merge pairs a publish with a listener: via the bus, async, at the topic.
      const call = fact(j.call) as Call;
      const entry = fact(j.entry) as Entry;
      putLink({
        kind: "Interface",
        schemaVersion: 2,
        id: j.interface,
        status: "current",
        confidence:
          call.conf === "declared" && entry.conf === "declared" && !guessed(j)
            ? "verified"
            : "inferred",
        // A publish carries no flag of how; a topic a guessed setting gave carries the guess (J0).
        ...(flagsOf(j).length ? { flags: flagsOf(j) } : {}),
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
          ...byPerson(j),
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
        ...j.gateway.flatMap((h) => [
          fact(h.entry),
          fact(h.call),
          ...(h.base?.by ?? []).map((b) => fact(b)),
        ]),
      ].every((f) => f?.conf === "declared");
      const confidence = declared && !guessed(j) ? "verified" : "inferred";
      const auth = catalogAuth(route) ?? catalogAuth(entry);
      putLink({
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
          // The path suffix: the service's context path setting the hop's path was matched under.
          ...j.gateway.flatMap((h) => baseLines(h.base)),
          ...byPerson(j),
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
    // The path suffix: the proxy's route and the settings the service's base path came from are
    // cited ends of the link too.
    const declared = [
      call,
      entry,
      ...(j.forRoute ? [fact(j.forRoute)] : []),
      ...(j.suffixOff ? [fact(j.suffixOff)] : []),
      ...(j.base?.by ?? []).map((b) => fact(b)),
    ].every((f) => f?.conf === "declared");
    const method = (j.forRoute ? j.method : (call.method ?? entry.method))?.toUpperCase();
    putLink({
      kind: "Interface",
      schemaVersion: 2,
      id: j.interface,
      status: "current",
      confidence: declared && !guessed(j) ? "verified" : "inferred",
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
        // The path suffix: the proxy's route whose suffix the target receives.
        ...(j.forRoute ? ev(j.forRoute, "gateway", "caller") : []),
        ...(j.suffixOff ? ev(j.suffixOff, "config", "caller") : []),
        ...(j.tie ? ev(j.tie, "config", "caller") : []),
        ...(j.through ?? []).flatMap((t) => ev(t, "config", "caller")),
        ...ev(j.entry, "code", "callee"),
        ...baseLines(j.base),
        ...byPerson(j),
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
