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
  | "paired";

export interface CandidateApi {
  /** The entry's fact id, or the operation's id in the spec. */
  id: string;
  kind: "entry" | "route" | "operation";
  method?: string;
  path: string;
  /** file:line, for an entry. */
  at?: string;
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
  suggestion?: { api: string; score: number; why: SuggestWhy };
}

export type SuggestWhy = "same-path" | "prefix" | "parameter" | "names-alike";

export interface LinkCandidates {
  calls: CandidateCall[];
  apis: CandidateApi[];
}

const JOINABLE = new Set(["rest", "soap", "grpc", "graphql"]);

const PLACEHOLDER = /^(\$\{[^}]*\}|@[^@]+@|\{[^}]*\}|:[a-z_]\w*|\*\*?)$/i;

const segs = (p: string) =>
  normalizePath(p.replace(/\$\{[^}]*\}/g, "{}"))
    .toLowerCase()
    .split("/")
    .filter(Boolean);

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

/** How likely a call is the API: 0 to 1, and why. */
export function pairScore(
  call: { method?: string; path: string },
  api: { method?: string; path: string },
): { score: number; why: SuggestWhy } | undefined {
  const methodOff =
    !!call.method && !!api.method && call.method.toUpperCase() !== api.method.toUpperCase();
  const k = methodOff ? 0.5 : 1;
  const a = segs(call.path);
  const b = segs(api.path);
  const eq = (x: string, y: string) => x === y || isWild(x) || isWild(y);
  // A path that is only a setting (`${forge.uris.cancel}`) has no shape to compare: its words do.
  const shaped = a.some((x) => !isWild(x)) && b.some((x) => !isWild(x));
  if (a.length && a.join("/") === b.join("/")) return { score: k, why: "same-path" };
  if (shaped && a.length === b.length && a.every((x, i) => eq(x, b[i]!)))
    return { score: 0.75 * k, why: "parameter" };
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

export function linkCandidates(o: {
  from: string;
  facts: readonly Fact[];
  join: Pick<FactsJoinResult, "joins" | "asks" | "misses" | "outside" | "left">;
  apis: readonly CandidateApi[];
  /** The pairings of `from` already on file, and the box they are with. */
  pairs?: Readonly<Record<string, PersonPair>>;
  /** The box B: a repo or an outside system id. */
  to: { repo?: string; system?: string };
}): LinkCandidates {
  const joined = new Set(
    o.join.joins.filter((j) => j.call.repo === o.from).map((j) => j.call.fact),
  );
  const status = new Map<string, { status: LooseStatus; why?: string }>();
  for (const a of o.join.asks)
    if (a.call.repo === o.from)
      status.set(a.call.fact, { status: "asked", why: a.host ?? a.reason });
  for (const m of o.join.misses)
    if (m.call.repo === o.from) status.set(m.call.fact, { status: "missed", why: m.target });
  for (const l of o.join.left ?? [])
    if (l.call.repo === o.from && !status.has(l.call.fact))
      status.set(l.call.fact, { status: "left", why: l.reason });
  for (const x of o.join.outside ?? [])
    if (x.call.repo === o.from) status.set(x.call.fact, { status: "outside", why: x.target });
  const pairedHere = (id: string) => {
    const p = o.pairs?.[id];
    if (!p) return undefined;
    if (o.to.repo ? p.repo === o.to.repo : p.system === o.to.system) return p;
    return undefined;
  };
  const calls: CandidateCall[] = [];
  for (const f of o.facts) {
    if (f.kind !== "call" || !JOINABLE.has(f.callType)) continue;
    const p = pairedHere(f.id);
    // A call another box joins is not loose; one paired with this box is listed, to undo.
    if (joined.has(f.id) && !p) continue;
    // A call left to another outside system by name stays as it is, unless this is that system.
    const s = status.get(f.id);
    if (!p && s?.status === "outside" && s.why !== o.to.system) continue;
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
    const scored = o.apis
      .map((a) => ({ a, s: pairScore(f, a) }))
      .filter(
        (x): x is { a: CandidateApi; s: NonNullable<typeof x.s> } =>
          !!x.s && x.s.score >= SUGGEST_AT,
      )
      .sort((x, y) => y.s.score - x.s.score || (x.a.id < y.a.id ? -1 : 1));
    // Two APIs as likely as each other is no suggestion: the person picks.
    const best = scored[0] && scored[1]?.s.score !== scored[0].s.score ? scored[0] : undefined;
    calls.push({
      ...base,
      status: s?.status ?? "unresolved",
      ...(s?.why ? { why: s.why } : {}),
      ...(best
        ? {
            suggestion: {
              api: best.a.id,
              score: Math.round(best.s.score * 100) / 100,
              why: best.s.why,
            },
          }
        : {}),
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
