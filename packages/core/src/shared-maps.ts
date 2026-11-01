import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { CatalogRecord } from "./catalog.js";
import { factIdPart, parseFactsLines } from "./facts.js";
import {
  callHostOf,
  JOINED_TO_SHARED_MAP,
  nameScore,
  routeScore,
  type FactEnd,
  type FactJoinOutside,
  type JoinRepo,
} from "./facts-join.js";
import { sharedDirOf } from "./metarepo.js";
import type { EvidenceT } from "./schema/common.js";
import type { Fact, FactOf } from "./schema/facts.js";
import { hostMatches } from "./schema/workspace.js";

/**
 * Another team's Atticus map, read-only (plan item O3, ADR 0160). A team that runs Atticus on its
 * own repos shares its verified facts; a person brings them in as files (`atticus join shared
 * import <their metarepo>`), and only their entries are kept, under `shared/<team>/` in this
 * metarepo: `map.yaml` (whose map it is, the system of our profile it stands for, their commit)
 * and `facts/<repo>.jsonl` (their entry facts, quotes redacted).
 *
 * A call the estate join leaves to that system (its `outside` list: by a person's answer, the
 * call's `to`, or a host the system's aliases name) is matched to the one entry of their map that
 * serves it, by method and path the way the join matches our own (a base path their manifest
 * gives in front, parameters folded), gRPC and SOAP by name. One is a match; two or more equally
 * good, a question for a person; none, a gap: their map serves nothing like it.
 *
 * A match marks the call's Interface (still to their system, never to a record of theirs) with
 * `joined-to-shared-map` and an evidence entry on their entry's line, at their repo and commit,
 * `by` their team. Their facts are never verified, corrected or reported on here: they are theirs.
 * Pure, apart from `readSharedMaps`, which reads the files.
 */

export const SHARED_MAP_SCHEMA_VERSION = 1 as const;

/** The `extractor` of the evidence a shared map adds, so a write takes the last write's off. */
export const SHARED_MAP_EVIDENCE = "atticus-shared@1";
/** A call to a system whose shared map serves nothing like it (a gap on the Interface). */
export const NOT_IN_SHARED_MAP = "not-in-shared-map";

/** The flags this module writes, and takes off again before every write. */
export const SHARED_MAP_FLAGS: ReadonlySet<string> = new Set([
  JOINED_TO_SHARED_MAP,
  NOT_IN_SHARED_MAP,
]);

const Slug = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "a lowercase slug: a-z, 0-9, '_' and '-'");
const Sha = z.string().regex(/^[0-9a-f]{7,64}$/, "a commit sha (7 to 64 hex digits)");

/** One of their repos, as their manifest gives it and as their facts were read. */
export const SharedMapRepo = z.strictObject({
  repo: z.string().min(1),
  /** The component their manifest says the repo builds; the repo when left out. */
  component: z.string().min(1).optional(),
  /** The commit of their code their facts cite (each fact's own `commit`, the first by sort). */
  commit: Sha.optional(),
  /** The hosts their manifest lists for the repo (and its modules). */
  hosts: z.array(z.string().min(1)).default([]),
  /** The path their routes sit under on those hosts (ADR 0134). */
  basePath: z.string().min(1).optional(),
  /** How many entries were kept from their facts. */
  entries: z.number().int().nonnegative(),
});
export type SharedMapRepoT = z.infer<typeof SharedMapRepo>;

/** `shared/<team>/map.yaml`: whose map it is, what it stands for, and at which commit. */
export const SharedMapFile = z.strictObject({
  schemaVersion: z.literal(SHARED_MAP_SCHEMA_VERSION),
  /** The team's id, the folder's name. */
  team: Slug,
  /** The team's name, as people say it. */
  name: z.string().min(1),
  /** The system of our profiles their map stands for: one no estate repo belongs to. */
  system: Slug,
  /**
   * Where the person imported it from, relative to the metarepo's root: kept only for a clone or
   * an export inside the metarepo. One outside it is this machine's own path (a user name, a
   * drive) in a committed file, so it is left out and `refresh <team> <folder>` is given it.
   */
  source: z.string().min(1).optional(),
  /** Their metarepo's commit the files are at. */
  commit: Sha,
  importedAt: z.iso.datetime({ offset: true }),
  repos: z.array(SharedMapRepo),
});
export type SharedMapFileT = z.infer<typeof SharedMapFile>;

/** A shared map as the join reads it: the file, with each repo's entry facts. */
export interface SharedMap {
  team: string;
  name: string;
  system: string;
  /** Their metarepo's commit. */
  commit: string;
  repos: readonly (SharedMapRepoT & { facts: readonly Fact[] })[];
}

/** An entry of their map: their repo, fact, component, line and the commit their code is at. */
export interface SharedEntryEnd extends FactEnd {
  team: string;
  commit?: string;
}

export interface SharedJoinMatch {
  call: FactEnd;
  team: string;
  system: string;
  entry: SharedEntryEnd;
  method?: string;
  /** The path (or gRPC/SOAP name) their entry serves, as it writes it. */
  path: string;
}

export interface SharedJoinGap {
  call: FactEnd;
  team: string;
  system: string;
  method?: string;
  path: string;
  message: string;
}

export interface SharedJoinAsk {
  call: FactEnd;
  team: string;
  system: string;
  question: string;
  candidates: SharedEntryEnd[];
}

export interface SharedJoinResult {
  matches: SharedJoinMatch[];
  gaps: SharedJoinGap[];
  asks: SharedJoinAsk[];
}

export interface JoinSharedMapsInput {
  /** The calls the estate join left to a system outside the estate (`FactsJoinResult.outside`). */
  outside: readonly FactJoinOutside[];
  /** Our repos, for the call facts and the config facts their hosts come from. */
  repos: readonly JoinRepo[];
  maps: readonly SharedMap[];
  /** Our profiles' outside systems: id, name and aliases, to read the target a call was left to. */
  systems: readonly { id: string; name: string; aliases: readonly string[] }[];
}

type Call = FactOf<"call">;
type Entry = FactOf<"entry">;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const key = (s: string) => factIdPart(s.trim().toLowerCase());
const NAMED = new Set(["grpc", "soap"]);
const sameMethod = (a: string | undefined, b: string | undefined) => {
  const x = a?.toUpperCase();
  const y = b?.toUpperCase();
  return !x || !y || x === "ANY" || y === "ANY" || x === y;
};
const joinPaths = (base: string, path: string) =>
  `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

/** Match every call left to a system with a shared map to the entry of their map that serves it. */
export function joinSharedMaps(input: JoinSharedMapsInput): SharedJoinResult {
  const systemOf = new Map<string, string>();
  for (const s of input.systems)
    for (const n of [s.id, s.name, ...s.aliases]) if (n) systemOf.set(key(n), s.id);
  const mapOf = new Map(input.maps.map((m) => [m.system, m] as const));
  const repoOf = new Map(input.repos.map((r) => [r.repo, r] as const));
  const matches: SharedJoinMatch[] = [];
  const gaps: SharedJoinGap[] = [];
  const asks: SharedJoinAsk[] = [];

  for (const o of [...input.outside].sort(
    (a, b) => cmp(a.call.repo, b.call.repo) || cmp(a.call.fact, b.call.fact),
  )) {
    const system = systemOf.get(key(o.target));
    const map = system ? mapOf.get(system) : undefined;
    const ours = repoOf.get(o.call.repo);
    const call = ours?.facts.find((f): f is Call => f.kind === "call" && f.id === o.call.fact);
    if (!system || !map || !ours || !call) continue;
    const named = NAMED.has(call.callType);
    if (call.callType !== "rest" && !named) continue;

    // Their repos the call's host names (their manifest's hosts); none named, every one.
    const host = callHostOf(call, ours.facts);
    const hp = host ? /^(.*?)(?::(\d+))?$/.exec(host) : null;
    const onHost = hp
      ? map.repos.filter((r) =>
          r.hosts.some((p) => hostMatches(p, hp[1]!, hp[2] ? Number(hp[2]) : undefined)),
        )
      : [];
    const where = onHost.length ? onHost : map.repos;

    const method = call.method?.toUpperCase();
    const scored: { e: Entry; r: (typeof map.repos)[number]; score: number }[] = [];
    for (const r of where)
      for (const f of r.facts) {
        if (f.kind !== "entry" || f.entryType !== call.callType) continue;
        const score = named
          ? nameScore(call.path, f.path)
          : sameMethod(method, f.method)
            ? Math.max(
                routeScore(call.path, f.path),
                r.basePath ? routeScore(call.path, joinPaths(r.basePath, f.path)) : 0,
              )
            : 0;
        if (score >= 400) scored.push({ e: f, r, score });
      }
    const best = Math.max(0, ...scored.map((s) => s.score));
    const hits = scored
      .filter((s) => s.score === best)
      .sort((a, b) => cmp(a.r.repo, b.r.repo) || cmp(a.e.id, b.e.id));
    const endOf = (s: (typeof hits)[number]): SharedEntryEnd => ({
      team: map.team,
      repo: s.r.repo,
      fact: s.e.id,
      component: factIdPart(s.e.component ?? s.r.component ?? s.r.repo),
      at: `${s.e.cite.file}:${s.e.cite.line}`,
      ...(s.e.commit ? { commit: s.e.commit } : {}),
    });
    const what = [method, call.path].filter(Boolean).join(" ");
    const base = { call: o.call, team: map.team, system };
    if (hits.length === 1) {
      const h = hits[0]!;
      matches.push({
        ...base,
        entry: endOf(h),
        ...(method || h.e.method ? { method: (method ?? h.e.method)!.toUpperCase() } : {}),
        path: h.e.path,
      });
    } else if (hits.length > 1) {
      const names = hits.map((h) => `${h.r.repo} ${h.e.method ?? ""} ${h.e.path}`.trim());
      asks.push({
        ...base,
        question: `Which of ${map.name}'s entries answers ${what}, which ${o.call.component} calls: ${names.slice(0, -1).join(", ")} or ${names.at(-1)}?`,
        candidates: hits.map(endOf),
      });
    } else
      gaps.push({
        ...base,
        ...(method ? { method } : {}),
        path: call.path,
        message: `${o.call.component} calls ${what} on ${system}, and ${map.name}'s map (their commit ${map.commit.slice(0, 7)}) has no entry that serves it: ask ${map.name}, or correct the call if it goes elsewhere`,
      });
  }
  return { matches, gaps, asks };
}

// ---------------------------------------------------------------- the marks on the catalog

const isSharedEvidence = (e: EvidenceT) => e.extractor === SHARED_MAP_EVIDENCE;

/** The records with every mark a shared map made taken off (evidence and flags). */
export function stripSharedMaps(records: readonly CatalogRecord[]): CatalogRecord[] {
  return records.map((r) => {
    const ev = r.evidence as EvidenceT[];
    const flags = r.flags ?? [];
    if (!ev.some(isSharedEvidence) && !flags.some((f) => SHARED_MAP_FLAGS.has(f))) return r;
    const left = flags.filter((f) => !SHARED_MAP_FLAGS.has(f));
    const { flags: _f, ...rest } = r as CatalogRecord & { flags?: string[] };
    return {
      ...rest,
      ...(left.length ? { flags: left } : {}),
      evidence: ev.filter((e) => !isSharedEvidence(e)),
    } as CatalogRecord;
  });
}

/**
 * The records with the marks put on: the Interface a matched call made (from the call's
 * component, to the system, citing the call's line) gets `joined-to-shared-map` and their entry's
 * line as callee evidence, at their repo and commit, `by` their team; a call their map has no
 * entry for gets `not-in-shared-map`. Its confidence, its `to` and its id never change: the
 * Interface stays ours, to their system, and nothing of theirs becomes a record.
 */
export function applySharedMaps(
  records: readonly CatalogRecord[],
  result: SharedJoinResult,
  systems: JoinSharedMapsInput["systems"],
): CatalogRecord[] {
  const names = new Map<string, Set<string>>();
  for (const s of systems)
    names.set(s.id, new Set([s.id, s.name, ...s.aliases].map((n) => key(n))));
  const marks = new Map<string, { flag: string; evidence?: EvidenceT }[]>();
  const add = (k: string, m: { flag: string; evidence?: EvidenceT }) =>
    marks.set(k, [...(marks.get(k) ?? []), m]);
  for (const m of result.matches) {
    const [path, line] = splitAt(m.entry.at);
    add(`${m.call.repo}|${m.call.at}|${m.call.component}|${m.system}`, {
      flag: JOINED_TO_SHARED_MAP,
      evidence: {
        source: "code",
        repo: m.entry.repo,
        path,
        line,
        ...(m.entry.commit ? { commit: m.entry.commit } : {}),
        side: "callee",
        extractor: SHARED_MAP_EVIDENCE,
        by: m.team,
      },
    });
  }
  for (const g of result.gaps)
    add(`${g.call.repo}|${g.call.at}|${g.call.component}|${g.system}`, {
      flag: NOT_IN_SHARED_MAP,
    });
  if (!marks.size) return stripSharedMaps(records);
  return stripSharedMaps(records).map((r) => {
    if (r.kind !== "Interface") return r;
    const found: { flag: string; evidence?: EvidenceT }[] = [];
    for (const [system, set] of names) {
      if (!set.has(key(r.to))) continue;
      for (const e of r.evidence as EvidenceT[]) {
        if (e.side === "callee" || !e.repo || !e.path || e.line === undefined) continue;
        found.push(...(marks.get(`${e.repo}|${e.path}:${e.line}|${r.from}|${system}`) ?? []));
      }
    }
    if (!found.length) return r;
    const flags = [...(r.flags ?? [])];
    for (const f of found) if (!flags.includes(f.flag)) flags.push(f.flag);
    const evKey = (e: EvidenceT) => `${e.source}|${e.repo ?? ""}|${e.path ?? ""}|${e.line ?? ""}`;
    const have = new Set((r.evidence as EvidenceT[]).map(evKey));
    const more = found
      .flatMap((f) => (f.evidence ? [f.evidence] : []))
      .filter((e) => (have.has(evKey(e)) ? false : (have.add(evKey(e)), true)))
      .sort((a, b) => cmp(evKey(a), evKey(b)));
    return { ...r, flags, evidence: [...(r.evidence as EvidenceT[]), ...more] } as CatalogRecord;
  });
}

function splitAt(at: string): [string, number] {
  const i = at.lastIndexOf(":");
  return [at.slice(0, i), Number(at.slice(i + 1))];
}

/** The part of a shared join about one repo's calls. */
export function sharedJoinAbout(all: SharedJoinResult, repo: string): SharedJoinResult {
  const of = <T extends { call: FactEnd }>(l: readonly T[]) =>
    l.filter((x) => x.call.repo === repo);
  return { matches: of(all.matches), gaps: of(all.gaps), asks: of(all.asks) };
}

// ---------------------------------------------------------------- the files

/** A shared map on disk that couldn't be read, with why. */
export interface SharedMapProblem {
  team: string;
  message: string;
}

/**
 * Every shared map under `shared/` (ADR 0160): each `<team>/map.yaml` and its `facts/<repo>.jsonl`,
 * only their entry facts kept. A folder that doesn't read is a problem, said, and left out; a
 * metarepo with none gives none. Files only.
 */
export async function readSharedMaps(
  root: string,
): Promise<{ maps: (SharedMap & { file: SharedMapFileT })[]; problems: SharedMapProblem[] }> {
  const dir = sharedDirOf(root);
  const teams = await readdir(dir, { withFileTypes: true }).then(
    (l) =>
      l
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort(),
    () => [] as string[],
  );
  const maps: (SharedMap & { file: SharedMapFileT })[] = [];
  const problems: SharedMapProblem[] = [];
  for (const team of teams) {
    const text = await readFile(join(dir, team, "map.yaml"), "utf8").catch(() => undefined);
    if (text === undefined) {
      problems.push({ team, message: `shared/${team}/ has no map.yaml: import it again` });
      continue;
    }
    let raw: unknown;
    try {
      raw = parse(text);
    } catch (e) {
      problems.push({
        team,
        message: `shared/${team}/map.yaml isn't YAML: ${(e as Error).message}`,
      });
      continue;
    }
    const p = SharedMapFile.safeParse(raw);
    if (!p.success || p.data.team !== team) {
      problems.push({
        team,
        message: p.success
          ? `shared/${team}/map.yaml names the team ${p.data.team}: it must be the folder's name`
          : `shared/${team}/map.yaml isn't a shared map: ${p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      });
      continue;
    }
    const repos: SharedMap["repos"][number][] = [];
    for (const r of p.data.repos) {
      const body = await readFile(join(dir, team, "facts", `${r.repo}.jsonl`), "utf8").catch(
        () => "",
      );
      // Their entries only: anything else in the file is left out, never joined or verified.
      const facts = parseFactsLines(body).facts.filter(
        (f) => f.kind === "entry" && f.repo === r.repo,
      );
      repos.push({ ...r, facts });
    }
    maps.push({
      team,
      name: p.data.name,
      system: p.data.system,
      commit: p.data.commit,
      repos,
      file: p.data,
    });
  }
  return { maps, problems };
}
