import type { FactsJoinResult, PersonPair } from "./facts-join.js";
import { normalizePath } from "./identity.js";
import type { Fact } from "./schema/facts.js";

/**
 * G1 (ADR 0174): connect two boxes call by call. Box A's calls that join nothing (asked,
 * unresolved, missed, left), box B's APIs (a service's entries, a proxy's routes, an outside
 * system's operations from its intaken spec), and for each call the API it most likely is.
 * Pure: the caller reads the facts, the join and the spec.
 */

export type LooseStatus =
  | "asked"
  | "missed"
  | "left"
  | "outside"
  | "unresolved"
  /** Already paired by a person with an API of this box. */
  | "paired"
  /**
   * Beta.28.1: the join ties it to another box (or this one) and an arrow is drawn for it:
   * listed so it can be moved here from the same panel, never ticked unseen.
   */
  | "joined"
  /**
   * Beta.28.1: the join ties it to something, and no arrow is drawn for it (its own component,
   * or no Interface of it on the canvas): as loose as a call that joins nothing.
   */
  | "undrawn";

export interface CandidateApi {
  /** The entry's fact id, or the operation's id in the spec. */
  id: string;
  kind: "entry" | "route" | "operation";
  method?: string;
  path: string;
  /** file:line, for an entry. */
  at?: string;
  /** Words that name it besides its path: a spec operation's operationId, a route's name. */
  words?: string;
  /** A gateway route: the path it forwards to (what the service behind it serves). */
  forwards?: string;
}

export interface CandidateCall {
  fact: string;
  callType: string;
  method?: string;
  path: string;
  at: string;
  status: LooseStatus;
  /** What the join said: the reason it left it, the target it missed, the host it asked about. */
  why?: string;
  /** For paired: the API it is paired with. */
  paired?: string;
  /**
   * Beta.28.1: the box the join ties it to now (a repo, or an outside target), for a call that
   * is joined, undrawn or outside: where it goes, or would go, before it is moved.
   */
  joins?: string;
  suggestion?: { api: string; score: number; why: SuggestWhy };
  /** The APIs it most likely is, best first (at most three); the first is `suggestion`. */
  suggestions?: { api: string; score: number; why: SuggestWhy }[];
  /** The best is well ahead of the rest and scores high: safe to pair without a look. */
  confident?: boolean;
}

export type SuggestWhy =
  | "same-path"
  | "prefix"
  | "parameter"
  | "names-alike"
  /** The call's path, with its settings resolved, is the API's. */
  | "setting"
  /** The call's words match the operation's name (operationId) or the route's. */
  | "operation-words"
  /** The call's path is what the gateway's route forwards to. */
  | "forwarded-path";

export interface LinkCandidates {
  calls: CandidateCall[];
  apis: CandidateApi[];
}

const JOINABLE = new Set(["rest", "soap", "grpc", "graphql"]);

const PLACEHOLDER = /^(\$\{[^}]*\}|@[^@]+@|\{[^}]*\}|:[a-z_]\w*|\*\*?)$/i;

/** A call's path with the settings it names filled in (`${api.base}/x` → `/v2/x`). */
export function resolvePath(p: string, settings: Readonly<Record<string, string>> | undefined) {
  if (!settings) return { path: p, resolved: false };
  let resolved = false;
  const out = p.replace(/\$\{([^}:]*)(?::[^}]*)?\}/g, (m, key: string) => {
    const v = settings[key.trim()];
    if (v === undefined) return m;
    resolved = true;
    // A URL in a setting: only its path matters here.
    return v.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  });
  return { path: out, resolved };
}

const segs = (p: string) =>
  normalizePath(p.replace(/\$\{[^}]*\}/g, "{}"))
    .toLowerCase()
    .split("/")
    .filter(Boolean)
    // A version prefix (`/v1`, `/v2`) names the API's age, not its shape.
    .filter((x, i) => !(i === 0 && /^v\d+$/.test(x)));

const STOP = new Set(["path", "url", "uri", "endpoint", "api", "v1", "v2", "v3", "the"]);

/** The words of a path or of a name that holds one (`requestRefundPath`), lower case. */
export function wordsOf(p: string): Set<string> {
  return new Set(
    p
      .replace(/\$\{([^}]*)\}/g, " $1 ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w))
      .map((w) => (w.endsWith("s") && w.length > 3 ? w.slice(0, -1) : w)),
  );
}

const isWild = (s: string) => s === "{}" || PLACEHOLDER.test(s);

/**
 * How likely a call is the API: 0 to 1, and why. The best of: the paths as written, the call's
 * path with its settings resolved, the path the API's route forwards to, and the words.
 */
export function pairScore(
  call: { method?: string; path: string },
  api: { method?: string; path: string; words?: string; forwards?: string },
  settings?: Readonly<Record<string, string>>,
): { score: number; why: SuggestWhy } | undefined {
  const tries: ({ score: number; why: SuggestWhy } | undefined)[] = [pathScore(call, api)];
  const r = resolvePath(call.path, settings);
  if (r.resolved) {
    const s = pathScore({ ...call, path: r.path }, api);
    if (s) tries.push({ ...s, why: s.why === "names-alike" ? s.why : "setting" });
  }
  if (api.forwards) {
    const s = pathScore(call, { ...api, path: api.forwards });
    if (s && s.why !== "names-alike") tries.push({ score: s.score * 0.95, why: "forwarded-path" });
  }
  if (api.words) {
    const wa = wordsOf(call.path);
    const wb = wordsOf(api.words);
    if (wa.size && wb.size) {
      const shared = [...wa].filter((w) => wb.has(w)).length;
      const j = shared / new Set([...wa, ...wb]).size;
      const k = methodFactor(call, api);
      if (j >= 0.5) tries.push({ score: (0.4 + 0.45 * j) * k, why: "operation-words" });
    }
  }
  return tries
    .filter((x): x is { score: number; why: SuggestWhy } => !!x)
    .sort((x, y) => y.score - x.score)[0];
}

const methodFactor = (call: { method?: string }, api: { method?: string }) =>
  !!call.method && !!api.method && call.method.toUpperCase() !== api.method.toUpperCase() ? 0.5 : 1;

/** The paths alone: the same, the same but for parameters, one the other's tail, or alike words. */
function pathScore(
  call: { method?: string; path: string },
  api: { method?: string; path: string },
): { score: number; why: SuggestWhy } | undefined {
  const k = methodFactor(call, api);
  const a = segs(call.path);
  const b = segs(api.path);
  const eq = (x: string, y: string) => x === y || isWild(x) || isWild(y);
  // A path that is only a setting (`${forge.uris.cancel}`) has no shape to compare: its words do.
  const shaped = a.some((x) => !isWild(x)) && b.some((x) => !isWild(x));
  if (a.length && a.join("/") === b.join("/")) return { score: k, why: "same-path" };
  if (shaped && a.length === b.length && a.every((x, i) => eq(x, b[i]!))) {
    // Beta.28.1: an API whose path starts with variables (Spring's `/{moduleName:.+}/{v:.+}/…`,
    // a module's name and version taken from the path) is the call when the rest is the same,
    // segment for segment, literal for literal and variable for variable: its tail.
    const lead = b.findIndex((x) => !isWild(x));
    if (
      lead > 0 &&
      a.slice(0, lead).every((x) => !isWild(x)) &&
      a.slice(lead).every((x, i) => isWild(x) === isWild(b[lead + i]!))
    )
      return { score: 0.9 * k, why: "prefix" };
    // The same shape: the more of the call's literals the API writes too, the likelier it is
    // (`/instruments/ping` over `/instruments/{id}`); every one the same is as before.
    const lits = a.filter((x) => !isWild(x)).length;
    const same = a.filter((x, i) => !isWild(x) && x === b[i]).length;
    return { score: (0.55 + 0.2 * (lits ? same / lits : 1)) * k, why: "parameter" };
  }
  const tail = (long: string[], short: string[]) =>
    short.length > 0 &&
    long.length > short.length &&
    short.every((x, i) => eq(x, long[long.length - short.length + i]!));
  if (shaped && (tail(b, a) || tail(a, b))) return { score: 0.85 * k, why: "prefix" };
  const wa = wordsOf(call.path);
  const wb = wordsOf(api.path);
  if (!wa.size || !wb.size) return undefined;
  const shared = [...wa].filter((w) => wb.has(w)).length;
  const j = shared / new Set([...wa, ...wb]).size;
  if (j >= 0.34) return { score: (0.3 + 0.4 * j) * k, why: "names-alike" };
  return undefined;
}

/** The suggestion threshold: below it, a call gets none. */
export const SUGGEST_AT = 0.35;
/** A suggestion this sure, and this far ahead of the next, is confident: safe to pair unseen. */
export const CONFIDENT_AT = 0.85;
export const CONFIDENT_LEAD = 0.2;

export function linkCandidates(o: {
  from: string;
  facts: readonly Fact[];
  join: Pick<FactsJoinResult, "joins" | "asks" | "misses" | "outside" | "left">;
  apis: readonly CandidateApi[];
  /** The pairings of `from` already on file, and the box they are with. */
  pairs?: Readonly<Record<string, PersonPair>>;
  /** The box B: a repo or an outside system id. */
  to: { repo?: string; system?: string };
  /** A's settings by key (its config facts with a value), to fill a call's `${key}` in. */
  settings?: Readonly<Record<string, string>>;
  /**
   * Beta.28.1: whether the canvas draws a join's arrow (its Interface is in the catalog). A join
   * of a call to its own component is never drawn, whatever this says. Default: every other is.
   */
  drawn?: (j: FactsJoinResult["joins"][number]) => boolean;
  /**
   * Beta.28.1: whether the canvas draws a call placed outside the estate to this target (an
   * outside system of the profile takes it). Default: none is, so the call is listed loose.
   */
  drawnOutside?: (target: string) => boolean;
}): LinkCandidates {
  const isDrawn = (j: FactsJoinResult["joins"][number]) =>
    j.entry.component !== j.call.component && (o.drawn ? o.drawn(j) : true);
  // Each of A's joined calls: the box it goes to, and whether any of its arrows is drawn.
  const joined = new Map<string, { to: string; drawn: boolean }>();
  for (const j of o.join.joins) {
    if (j.call.repo !== o.from) continue;
    const was = joined.get(j.call.fact);
    const d = isDrawn(j);
    if (!was || (d && !was.drawn)) joined.set(j.call.fact, { to: j.entry.repo, drawn: d });
  }
  const status = new Map<string, { status: LooseStatus; why?: string }>();
  for (const a of o.join.asks)
    if (a.call.repo === o.from)
      status.set(a.call.fact, { status: "asked", why: a.host ?? a.reason });
  for (const m of o.join.misses)
    if (m.call.repo === o.from) status.set(m.call.fact, { status: "missed", why: m.target });
  for (const l of o.join.left ?? [])
    if (l.call.repo === o.from && !status.has(l.call.fact))
      status.set(l.call.fact, { status: "left", why: l.reason });
  const outsideTo = new Map<string, string>();
  for (const x of o.join.outside ?? [])
    if (x.call.repo === o.from) {
      status.set(x.call.fact, { status: "outside", why: x.target });
      outsideTo.set(x.call.fact, x.target);
    }
  const pairedHere = (id: string) => {
    const p = o.pairs?.[id];
    // Round 48: a person's "none" is no pairing.
    if (!p || p.none) return undefined;
    if (o.to.repo ? p.repo === o.to.repo : p.system === o.to.system) return p;
    return undefined;
  };
  const calls: CandidateCall[] = [];
  for (const f of o.facts) {
    if (f.kind !== "call" || !JOINABLE.has(f.callType)) continue;
    const p = pairedHere(f.id);
    const base = {
      fact: f.id,
      callType: f.callType,
      ...(f.method ? { method: f.method.toUpperCase() } : {}),
      path: f.path,
      at: `${f.cite.file}:${f.cite.line}`,
    };
    if (p) {
      const api =
        o.apis.find((x) => x.id === p.entry) ??
        o.apis.find(
          (x) =>
            normalizePath(x.path) === normalizePath(p.path) &&
            (!p.method || !x.method || x.method.toUpperCase() === p.method.toUpperCase()),
        );
      calls.push({ ...base, status: "paired", ...(api ? { paired: api.id } : {}) });
      continue;
    }
    // Beta.28.1 (field report 4): no call is hidden. One the join ties to something is listed
    // as movable when its arrow is drawn, and as loose when it isn't; one placed outside to a
    // target no box draws is loose too (it was left out, and Connect said nothing was loose).
    const j = joined.get(f.id);
    const out = outsideTo.get(f.id);
    const s: { status: LooseStatus; why?: string } | undefined = j
      ? j.drawn
        ? { status: "joined" }
        : { status: "undrawn", why: j.to }
      : out !== undefined && out !== o.to.system && o.drawnOutside?.(out)
        ? { status: "joined" }
        : status.get(f.id);
    const now = j?.to ?? out;
    const movable = s?.status === "joined";
    const scored = o.apis
      .map((a) => ({ a, s: pairScore(f, a, o.settings) }))
      .filter(
        (x): x is { a: CandidateApi; s: NonNullable<typeof x.s> } =>
          !!x.s && x.s.score >= SUGGEST_AT,
      )
      .sort((x, y) => y.s.score - x.s.score || (x.a.id < y.a.id ? -1 : 1));
    // Two APIs as likely as each other is no suggestion: the person picks (from the top three).
    const best = scored[0] && scored[1]?.s.score !== scored[0].s.score ? scored[0] : undefined;
    const top = scored.slice(0, 3).map((x) => ({
      api: x.a.id,
      score: Math.round(x.s.score * 100) / 100,
      why: x.s.why,
    }));
    // A call with an arrow already is moved only by a person's look: never confident.
    const confident =
      !movable &&
      !!best &&
      best.s.score >= CONFIDENT_AT &&
      (scored[1] === undefined || best.s.score - scored[1].s.score >= CONFIDENT_LEAD);
    calls.push({
      ...base,
      status: s?.status ?? "unresolved",
      ...(s?.why ? { why: s.why } : {}),
      ...(now !== undefined ? { joins: now } : {}),
      ...(best ? { suggestion: top[0]! } : {}),
      ...(top.length ? { suggestions: top } : {}),
      ...(confident ? { confident: true } : {}),
    });
  }
  calls.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  return {
    calls,
    apis: [...o.apis].sort((x, y) =>
      x.path < y.path ? -1 : x.path > y.path ? 1 : (x.method ?? "") < (y.method ?? "") ? -1 : 1,
    ),
  };
}
