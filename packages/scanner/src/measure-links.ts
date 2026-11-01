import { parse } from "yaml";
import {
  callHostOf,
  factIdPart,
  joinFacts,
  JOINED_BY_LABEL,
  JOINED_BY_PATH,
  NO_TARGET,
  type Fact,
  type FactJoin,
  type FactJoinAsk,
  type FactOf,
  type OrgPack,
} from "@maycombhq/core";
import { componentRenames, joinReposOf, outsideSystems } from "./facts-catalog.js";
import { estateRepos, isPrototypeRepo } from "./merge-input.js";

/**
 * Measuring the links the estate join makes (plan items P1 and R5). A reference, written by hand,
 * lists for some repos the entries they serve and the calls they make, each call with the repo of
 * the estate it should reach (after any gateway that forwards it), the outside system it should
 * reach, or none. The measure runs the estate join over the repos' facts, exactly as
 * `verify --write` does (the manifest's hosts and base paths, the outside systems, the targets
 * people named), and compares:
 *
 * - reading: how many of the listed entries and calls the facts have;
 * - links: precision (of the listed calls the join linked to a repo, how many are right) and
 *   recall (of the listed calls that should reach a repo, how many it reached), with the calls
 *   it asked about, the guesses (inferred: joined by path or by a host's first label) and the
 *   outside systems counted on their own.
 *
 * Pure: it reads only what it is given and writes nothing. The reference stays wherever its
 * author keeps it (a person's own metarepo for R5), so none of an estate's data comes here.
 */

const METHODS = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|ANY)\s+(\S.*)$/i;
/** How far from the cited line a reference's `at` may be and still find the fact. */
const NEAR = 3;

/** What a reference call should reach. */
export type LinkWant = { repo: string } | { outside: string } | { none: true };

export interface RefEntry {
  entry?: string;
  at?: string;
  fact?: string;
}

export interface RefCall {
  call?: string;
  at?: string;
  fact?: string;
  want: LinkWant;
}

export interface LinkReference {
  estate?: string;
  repos: { repo: string; entries: RefEntry[]; calls: RefCall[] }[];
}

const AT = /^.+:\d+$/;
const AT_HELP = "at is file:line, e.g. src/main/java/Client.java:16";
const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const text = (x: unknown): string | undefined =>
  typeof x === "string" && x.trim() ? x.trim() : typeof x === "number" ? String(x) : undefined;

/** Read a reference file (YAML): the reference, or every issue with where it is. */
export function parseLinkReference(
  source: string,
): { ok: true; reference: LinkReference } | { ok: false; issues: string[] } {
  let raw: unknown;
  try {
    raw = parse(source);
  } catch (e) {
    return { ok: false, issues: [`the file isn't YAML: ${(e as Error).message}`] };
  }
  const issues: string[] = [];
  const say = (where: string, message: string) => issues.push(`${where}: ${message}`);
  /** Keys a part may have; any other is a typing mistake, said. */
  const only = (where: string, o: Record<string, unknown>, keys: readonly string[]) => {
    for (const k of Object.keys(o)) if (!keys.includes(k)) say(where, `unknown key ${k}`);
  };
  if (!isObj(raw) || !Array.isArray(raw.repos))
    return { ok: false, issues: ["repos: list the repos, each with its entries and calls"] };
  only("(top)", raw, ["estate", "repos"]);
  const repos: LinkReference["repos"] = [];
  raw.repos.forEach((r: unknown, i: number) => {
    const w = `repos.${i}`;
    if (!isObj(r) || !text(r.repo)) return say(w, "each repo needs repo: <its id>");
    only(w, r, ["repo", "entries", "calls"]);
    const entries: RefEntry[] = [];
    const calls: RefCall[] = [];
    const list = (x: unknown, name: string) => {
      if (x === undefined || x === null) return [];
      if (Array.isArray(x)) return x as unknown[];
      say(`${w}.${name}`, `${name} is a list`);
      return [];
    };
    list(r.entries, "entries").forEach((e, j) => {
      const we = `${w}.entries.${j}`;
      if (text(e)) return entries.push({ entry: text(e)! });
      if (!isObj(e)) return say(we, "an entry is METHOD /path, or { entry, at, fact }");
      only(we, e, ["entry", "at", "fact"]);
      const at = text(e.at);
      if (at && !AT.test(at)) return say(`${we}.at`, AT_HELP);
      if (!text(e.entry) && !at && !text(e.fact))
        return say(we, "give the entry (METHOD /path), its line (at: file:line) or its fact id");
      entries.push(stripped({ entry: text(e.entry), at, fact: text(e.fact) }) as RefEntry);
    });
    list(r.calls, "calls").forEach((c, j) => {
      const wc = `${w}.calls.${j}`;
      if (!isObj(c)) return say(wc, "a call is { call, at, reaches } or { call, at, outside }");
      only(wc, c, ["call", "at", "fact", "reaches", "outside", "note"]);
      const reaches = text(c.reaches);
      const outside = text(c.outside);
      const at = text(c.at);
      let bad = false;
      if (reaches && outside) {
        say(wc, "give one of reaches (a repo, or none) and outside (a system), not both");
        bad = true;
      } else if (!reaches && !outside) {
        say(wc, "give one of reaches (a repo, or none) and outside (a system)");
        bad = true;
      }
      if (!text(c.call) && !at && !text(c.fact)) {
        say(wc, "give the call (METHOD /path), its line (at: file:line) or its fact id");
        bad = true;
      }
      if (at && !AT.test(at)) {
        say(`${wc}.at`, AT_HELP);
        bad = true;
      }
      if (bad) return;
      const want: LinkWant = outside
        ? { outside }
        : reaches!.toLowerCase() === "none"
          ? { none: true }
          : { repo: reaches! };
      calls.push({
        ...(stripped({ call: text(c.call), at, fact: text(c.fact) }) as RefCall),
        want,
      });
    });
    repos.push({ repo: text(r.repo)!, entries, calls });
  });
  if (issues.length) return { ok: false, issues };
  const estate = text(raw.estate);
  return { ok: true, reference: { ...(estate ? { estate } : {}), repos } };
}

const stripped = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** What the join did with a listed call. */
export type LinkGot =
  | {
      kind: "joined";
      /** The repo and component of the entry it reached, after the gateways. */
      repo: string;
      component: string;
      entry: string;
      /** The gateway repos it went through, in order. */
      via?: string[];
      /** A guess: joined by path, or by a host's first label. */
      inferred?: typeof JOINED_BY_PATH | typeof JOINED_BY_LABEL;
    }
  | { kind: "outside"; system: string }
  | { kind: "asked"; reason: FactJoinAsk["reason"] }
  | { kind: "missed"; target: string }
  | { kind: "unlinked" }
  | { kind: "not-read" };

export interface LinkRow {
  repo: string;
  /** The call as the reference writes it, else as the fact does. */
  call: string;
  at?: string;
  /** The fact the reference's call was found as. */
  fact?: string;
  want: LinkWant;
  got: LinkGot;
  right: boolean;
}

export interface MeasureLinksResult {
  estate?: string;
  reading: {
    entries: { want: number; found: number };
    calls: { want: number; found: number };
    /** "<repo> entry|call <what>" for each listed one the facts don't have. */
    missed: string[];
  };
  links: {
    /** Listed calls that should reach a repo of the estate. */
    want: number;
    /** Listed calls the join linked to a repo of the estate. */
    joined: number;
    /** Of those, the ones that reached the repo the reference names. */
    right: number;
    /** right / joined, to three places; null when nothing joined. */
    precision: number | null;
    /** right / want, to three places; null when nothing should reach a repo. */
    recall: number | null;
    asked: number;
    /** A named target with no entry serving the call. */
    missed: number;
    /** Not joined, asked or taken by an outside system. */
    unlinked: number;
    /** Listed calls the facts don't have. */
    notRead: number;
    inferred: { joined: number; right: number };
    outside: { want: number; got: number; right: number };
    none: { want: number; right: number };
  };
  calls: LinkRow[];
  notes: string[];
}

export interface MeasureLinksInput {
  op: OrgPack;
  /** Every repo's verified facts (the whole estate, so the join is the one verify --write makes). */
  repos: readonly { repo: string; facts: readonly Fact[] }[];
  /** The targets people named (answers to targets questions): repo → call fact id → name. */
  targets?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  reference: LinkReference;
}

type Call = FactOf<"call">;
type Entry = FactOf<"entry">;

/** Path segments as compared: lower case, `{x}`, `:x` and `*` all a parameter. */
function segs(path: string): string[] {
  return path
    .split(/[?#]/)[0]!
    .split("/")
    .filter(Boolean)
    .map((s) => (/^(\{[^}]*\}|:\w+|\*)$/.test(s) ? "{}" : s.toLowerCase()));
}

/** 2 the same path, 1 one ends the other (a base in front on one side), 0 neither. */
function pathMatch(a: string, b: string): number {
  const x = segs(a);
  const y = segs(b);
  if (x.length === y.length && x.every((s, i) => s === y[i])) return 2;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  if (!short.length) return 0;
  const off = long.length - short.length;
  return short.every((s, i) => s === long[off + i]) ? 1 : 0;
}

function parseWhat(what: string | undefined): { method?: string; path?: string } {
  if (!what) return {};
  const m = METHODS.exec(what.trim());
  return m ? { method: m[1]!.toUpperCase(), path: m[2]!.trim() } : { path: what.trim() };
}

function parseAt(at: string | undefined): { file: string; line: number } | undefined {
  if (!at) return undefined;
  const i = at.lastIndexOf(":");
  return { file: at.slice(0, i).replace(/^\.\//, ""), line: Number(at.slice(i + 1)) };
}

/**
 * The fact a listed entry or call is: by fact id; else by its line (the same file, within 3
 * lines) and its method and path where given. The best first: the same path over one ending the
 * other, then the nearest line. Each fact is found once.
 */
function finder<F extends Entry | Call>(facts: readonly F[]) {
  const used = new Set<string>();
  return (ref: { what?: string; at?: string; fact?: string }): F | undefined => {
    const { method, path } = parseWhat(ref.what);
    const at = parseAt(ref.at);
    let best: { f: F; score: number } | undefined;
    for (const f of facts) {
      if (used.has(f.id)) continue;
      if (ref.fact) {
        if (f.id === ref.fact) best = { f, score: 1e6 };
        continue;
      }
      let score = 0;
      if (at) {
        const d = Math.abs(f.cite.line - at.line);
        if (f.cite.file !== at.file || d > NEAR) continue;
        score += 10 * (NEAR + 1 - d);
      }
      if (method && f.method && f.method.toUpperCase() !== method && method !== "ANY") continue;
      if (path) {
        const p = pathMatch(path, f.path);
        if (!p) continue;
        score += 100 * p;
      }
      if (!best || score > best.score) best = { f, score };
    }
    if (best) used.add(best.f.id);
    return best?.f;
  };
}

const round = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : null);
const what = (f: Call | Entry) => [f.method?.toUpperCase(), f.path].filter(Boolean).join(" ");

/** The estate join of the repos' facts, measured against the reference (P1, R5). */
export function measureLinks(input: MeasureLinksInput): MeasureLinksResult {
  const { op } = input;
  const repos = input.repos.filter((x) => !isPrototypeRepo(op, x.repo));
  const renames = componentRenames(repos, op);
  const join = joinFacts({
    repos: joinReposOf(op, repos, renames),
    ...(input.targets ? { targets: input.targets } : {}),
    outside: outsideSystems(op),
  });
  const key = (repo: string, fact: string) => `${repo}\u0000${fact}`;
  const joins = new Map<string, FactJoin[]>();
  for (const j of join.joins) {
    const k = key(j.call.repo, j.call.fact);
    joins.set(k, [...(joins.get(k) ?? []), j]);
  }
  const asks = new Map(join.asks.map((a) => [key(a.call.repo, a.call.fact), a] as const));
  const misses = new Map(join.misses.map((m) => [key(m.call.repo, m.call.fact), m] as const));
  const outsideOf = new Map(
    (join.outside ?? []).map((o) => [key(o.call.repo, o.call.fact), o] as const),
  );

  // The outside systems by every name they go by (id, name, aliases), to their id.
  const own = new Set(estateRepos(op).flatMap((r) => (r.system ? [r.system] : [])));
  const systemOf = new Map<string, string>();
  for (const s of op.profiles.flatMap((p) => p.profile?.systems ?? []))
    if (s.boundary === "vendor" || !own.has(s.id))
      for (const n of [s.id, s.name, ...s.aliases]) systemOf.set(factIdPart(n), s.id);
  const outsideName = (n: string | undefined) => (n ? systemOf.get(factIdPart(n)) : undefined);

  // A reference's repo may be written as a repo or a component of the estate.
  const manifests = estateRepos(op);
  const repoOf = (name: string): string => {
    const slug = factIdPart(name);
    const m =
      manifests.find((r) => r.id === name || factIdPart(r.id) === slug) ??
      manifests.find((r) => r.component && factIdPart(r.component) === slug);
    return m?.id ?? name;
  };

  const factsOf = new Map(repos.map((r) => [r.repo, r.facts] as const));
  const notes: string[] = [];
  const reading = {
    entries: { want: 0, found: 0 },
    calls: { want: 0, found: 0 },
    missed: [] as string[],
  };
  const rows: LinkRow[] = [];

  for (const r of input.reference.repos) {
    const facts = factsOf.get(r.repo);
    if (!facts)
      notes.push(
        `${r.repo}: no verified facts in the estate, so nothing of it is found (atticus map ${r.repo}, then atticus verify ${r.repo}).`,
      );
    const all = facts ?? [];
    const findEntry = finder(all.filter((f): f is Entry => f.kind === "entry"));
    for (const e of r.entries) {
      reading.entries.want++;
      if (findEntry({ what: e.entry, at: e.at, fact: e.fact })) reading.entries.found++;
      else reading.missed.push(`${r.repo} entry ${e.entry ?? e.fact ?? e.at}`);
    }
    const findCall = finder(all.filter((f): f is Call => f.kind === "call"));
    for (const c of r.calls) {
      reading.calls.want++;
      const f = findCall({ what: c.call, at: c.at, fact: c.fact });
      const label = c.call ?? (f ? what(f) : (c.fact ?? c.at!));
      const base = { repo: r.repo, call: label, ...(c.at ? { at: c.at } : {}) };
      if (!f) {
        reading.missed.push(`${r.repo} call ${label}`);
        rows.push({ ...base, want: c.want, got: { kind: "not-read" }, right: false });
        continue;
      }
      reading.calls.found++;
      const got = gotOf(r.repo, f, all);
      rows.push({ ...base, fact: f.id, want: c.want, got, right: isRight(c.want, got) });
    }
  }

  function gotOf(repo: string, f: Call, facts: readonly Fact[]): LinkGot {
    const k = key(repo, f.id);
    const j = joins.get(k)?.[0];
    if (j) {
      const via = (j.gateway ?? []).map((h) => h.entry.repo);
      const inferred = j.byLabel ? JOINED_BY_LABEL : j.inferred ? JOINED_BY_PATH : undefined;
      return {
        kind: "joined",
        repo: j.entry.repo,
        component: j.entry.component,
        entry: [j.method, j.path].filter(Boolean).join(" "),
        ...(via.length ? { via } : {}),
        ...(inferred ? { inferred } : {}),
      };
    }
    const ask = asks.get(k);
    if (ask) return { kind: "asked", reason: ask.reason };
    const miss = misses.get(k);
    if (miss) return { kind: "missed", target: miss.target };
    // Not joined, asked or missed: an outside system took it, or nothing did.
    const answer = input.targets?.[repo]?.[f.id];
    if (answer === NO_TARGET) return { kind: "unlinked" };
    const host = callHostOf(f, facts);
    // The join's own word first: it sees the host a placeholder's setting gives (J0).
    const system =
      outsideName(answer) ??
      outsideName(outsideOf.get(k)?.target) ??
      outsideName(f.to) ??
      outsideName(host);
    if (system) return { kind: "outside", system };
    if (f.to && host) return { kind: "outside", system: f.to };
    return { kind: "unlinked" };
  }

  function isRight(want: LinkWant, got: LinkGot): boolean {
    if ("repo" in want) {
      if (got.kind !== "joined") return false;
      const w = repoOf(want.repo);
      return got.repo === w || got.component === factIdPart(want.repo);
    }
    if ("outside" in want) {
      if (got.kind !== "outside") return false;
      const w = outsideName(want.outside) ?? factIdPart(want.outside);
      return got.system === w || factIdPart(got.system) === factIdPart(want.outside);
    }
    return got.kind === "unlinked" || got.kind === "missed";
  }

  const toRepo = rows.filter((x) => "repo" in x.want);
  const joined = rows.filter((x) => x.got.kind === "joined");
  const right = joined.filter((x) => x.right).length;
  const inferred = joined.filter((x) => x.got.kind === "joined" && x.got.inferred);
  const outsideWant = rows.filter((x) => "outside" in x.want);
  const noneWant = rows.filter((x) => "none" in x.want);
  return {
    ...(input.reference.estate ? { estate: input.reference.estate } : {}),
    reading,
    links: {
      want: toRepo.length,
      joined: joined.length,
      right,
      precision: round(right, joined.length),
      recall: round(toRepo.filter((x) => x.right).length, toRepo.length),
      asked: rows.filter((x) => x.got.kind === "asked").length,
      missed: rows.filter((x) => x.got.kind === "missed").length,
      unlinked: rows.filter((x) => x.got.kind === "unlinked").length,
      notRead: rows.filter((x) => x.got.kind === "not-read").length,
      inferred: { joined: inferred.length, right: inferred.filter((x) => x.right).length },
      outside: {
        want: outsideWant.length,
        got: rows.filter((x) => x.got.kind === "outside").length,
        right: outsideWant.filter((x) => x.right).length,
      },
      none: { want: noneWant.length, right: noneWant.filter((x) => x.right).length },
    },
    calls: rows,
    notes,
  };
}
