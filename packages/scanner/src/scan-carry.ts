import { createHash } from "node:crypto";
import { cmpText, normalizePath, recordPath, type CatalogRecord } from "@maycombhq/core";
import type { ReadersStandIn } from "./facts-scan.js";

/**
 * Beta.26 review (ADR 0124 addendum B-keep): what a scan carries from the catalog before it.
 * The built-in readers are a cross-check beside the assistant's facts (CLAUDE.md rule 4, ADR
 * 0124 §3), never the path to accuracy, so what a scan can't read is never theirs to remove or
 * weaken:
 *
 * - the records of a production repo the scan didn't read (not cloned here, a clone it couldn't
 *   read, not among the repos asked for) are carried;
 * - a record projected from verified facts is carried while the readers stand in for its repo,
 *   when every repo it rests on is one not read or stood in for; when each fact cites a file
 *   changed since, only the records citing none of the changed files are (the rest are outdated).
 *
 * What is carried goes into the scan's merge beside what it read, so the joins resolve as they
 * did when every repo was read: a call from a repo read now to one not read finds that repo's
 * endpoint (its evidence and auth with it), an event finds the listener the repo not read has. A
 * link's end in a repo read now is left to the scan to make again, so a call taken out of the
 * code goes. The readers' records of a stood-in repo that a carried fact record has (the same
 * call, endpoint, table, column or setting) are left out before the merge, so nothing is shown
 * twice. After the merge, a carried record resting only on repos not read stands as it was.
 */

/** Why a scan didn't read a repo of the estate. */
export type UnreadWhy = "not-cloned" | "unreadable" | "not-asked";

const WHY_ORDER: readonly UnreadWhy[] = ["not-cloned", "unreadable", "not-asked"];

/** What a scan carried, said by why. */
export interface CarriedSummary {
  /** The estate's repos this scan didn't read that records were carried for. */
  unread: string[];
  /** Records carried for those repos. */
  records: number;
  /** Those repos and records by why the scan didn't read them. */
  by: { why: UnreadWhy; repos: string[]; records: number }[];
  /** Records from verified facts carried while the readers stood in. */
  fromFacts: number;
  /** The readers' records left out: a carried fact record has the same call or thing. */
  covered: number;
  /** Records from facts let go: they cite a file changed since, and the readers stood in. */
  outdated: number;
}

export interface CarryInput {
  /** The catalog before the scan. */
  before: readonly CatalogRecord[];
  /** The estate's repos: the manifests' production repos (ADR 0133), whatever was asked for. */
  estate: readonly string[];
  /** The repos this scan read. */
  read: readonly string[];
  /** The repos read whose facts are on file but not used, and why. */
  standIn: Readonly<Record<string, ReadersStandIn>>;
  /** Why each repo of the estate not read wasn't; `not-cloned` when unsaid. */
  why?: Readonly<Record<string, UnreadWhy>>;
  /** The repo a component is of (the manifests' and the catalog's components). */
  repoOf?: (component: string) => string | undefined;
}

interface Held {
  r: CatalogRecord;
  /** The repos it rests on that weren't read. */
  onUnread: string[];
  /** Every repo it rests on was not read, or stood in for. */
  only: boolean;
}

export interface Carry {
  held: Held[];
  /** Fact records let go as outdated. */
  outdated: number;
  /** What goes into the merge beside the scan's own records. */
  context: CatalogRecord[];
  /** The repos not read, and those the readers stood in for. */
  unread: ReadonlySet<string>;
  standIn: ReadonlySet<string>;
  why: (repo: string) => UnreadWhy;
}

type Ev = {
  source?: string;
  repo?: string;
  by?: string;
  path?: string;
  line?: number;
  side?: string;
};
type Rec = Record<string, unknown> & { kind: string; id: string; evidence: Ev[] };

const evidenceOf = (r: CatalogRecord): Ev[] =>
  Array.isArray((r as { evidence?: unknown }).evidence) ? (r as { evidence: Ev[] }).evidence : [];

/** The repos a record rests on: its evidence's, and its own `repo` (a component's). */
export function reposOf(r: CatalogRecord): Set<string> {
  const out = new Set<string>();
  for (const e of evidenceOf(r)) if (typeof e.repo === "string" && e.repo) out.add(e.repo);
  const own = (r as { repo?: unknown }).repo;
  if (typeof own === "string" && own) out.add(own);
  return out;
}

/**
 * Projected from the assistant's facts: evidence in a repo with who read it (`by`), which the
 * built-in readers never write; a person's (`manual`) or the AI's decision (`ai`) is not a fact.
 */
export function fromFacts(r: CatalogRecord): boolean {
  return evidenceOf(r).some(
    (e) => typeof e.by === "string" && !!e.repo && e.source !== "manual" && e.source !== "ai",
  );
}

/** Kinds a scan makes after its merge, from the merged records: carried, never merged. */
const AFTER_MERGE = new Set(["Capability", "GlossaryTerm"]);

/** What a scan carries of the catalog before it, and what goes into its merge. */
export function carryFrom(i: CarryInput): Carry {
  const read = new Set(i.read);
  const unread = new Set(i.estate.filter((r) => !read.has(r)));
  const standIn = new Set(Object.keys(i.standIn).filter((r) => read.has(r)));
  const blind = (r: string | undefined) => !!r && (unread.has(r) || standIn.has(r));
  const changed = new Map<string, Set<string>>();
  for (const r of standIn) {
    const s = i.standIn[r]!;
    if (s.why === "cited-changed") changed.set(r, new Set(s.changed));
  }
  const held: Held[] = [];
  let outdated = 0;
  for (const b of i.before) {
    const repos = [...reposOf(b)];
    if (!repos.length) continue;
    const onUnread = repos.filter((r) => unread.has(r)).sort(cmpText);
    const only = repos.every(blind);
    if (onUnread.length) {
      held.push({ r: b, onUnread, only });
      continue;
    }
    // A fact record is carried only when nothing it rests on was read without the readers
    // standing in: a repo read from its facts, or one with none, says what it is now.
    if (!fromFacts(b) || !only) continue;
    if (evidenceOf(b).some((e) => !!e.repo && !!e.path && changed.get(e.repo)?.has(e.path))) {
      outdated++;
      continue;
    }
    held.push({ r: b, onUnread: [], only: true });
  }
  const carry: Carry = {
    held,
    outdated,
    context: [],
    unread,
    standIn,
    why: (r) => i.why?.[r] ?? "not-cloned",
  };
  carry.context = contextOf(held, blind, i.repoOf ?? (() => undefined));
  return carry;
}

const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);

/**
 * The carried records the merge reads beside the scan's: whole when every repo they rest on
 * wasn't read; a link or table between such a repo and one read now gives only its unread end,
 * as the readers would have read it there (a caller's Interface without the read callee's
 * evidence; an event's publish or subscribe; a table's readers and writers), so the merge joins
 * it again with what the scan read.
 */
function contextOf(
  held: readonly Held[],
  blind: (r: string | undefined) => boolean,
  repoOf: (component: string) => string | undefined,
): CatalogRecord[] {
  const out: CatalogRecord[] = [];
  const evIn = (r: Rec, repos: (repo: string | undefined) => boolean) =>
    r.evidence.filter((e) => repos(e.repo));
  /** A component's repo: the manifests' or the catalog's, else the one its code is cited in. */
  const endRepo = (component: unknown, side: Ev[]) =>
    repoOf(String(component)) ?? side.find((e) => !!e.repo)?.repo;
  const loose = (owner: string, kind: string, raw: string, evidence: Ev[]) =>
    ({
      schemaVersion: 1,
      kind: "Unresolved",
      id: `unresolved.carried.${short(`${owner}|${kind}|${raw}`)}`,
      status: "current",
      confidence: "inferred",
      unresolvedKind: kind,
      raw,
      owner,
      evidence,
    }) as unknown as CatalogRecord;
  for (const { r: c, only } of held) {
    if (AFTER_MERGE.has(c.kind)) continue;
    if (only) {
      out.push(c);
      continue;
    }
    const r = c as unknown as Rec;
    if (c.kind === "Interface") {
      const callerEv = r.evidence.filter((e) => e.side === "caller");
      const calleeEv = r.evidence.filter((e) => e.side === "callee");
      const from = endRepo(r.from, callerEv);
      const to = endRepo(r.to, calleeEv);
      if (r.via === "event-bus" || r.via === "mq") {
        // The end not read now, as the loose end its reader made; the scan reads the other.
        const topic = String(r.normalizedPath ?? "");
        if (blind(from) && from)
          out.push(
            loose(
              String(r.from),
              "event-publish",
              topic,
              evIn(r, (x) => x === from),
            ),
          );
        if (blind(to) && to)
          out.push(
            loose(
              String(r.to),
              "event-subscribe",
              topic,
              evIn(r, (x) => x === to),
            ),
          );
        continue;
      }
      // A caller read now makes the call again, which the carried endpoint answers. A caller of
      // no repo (an outside system) is read where its other evidence is.
      const callerBlind = from
        ? blind(from)
        : r.evidence.filter((e) => e.side !== "callee" && e.repo).every((e) => blind(e.repo));
      if (!callerBlind) continue;
      // The callee read now is found again by the merge (its endpoint, evidence and auth).
      const readCallee = (e: Ev) => !blind(e.repo) && e.side === "callee";
      const lost = r.evidence.some(readCallee);
      const x: Rec = { ...r, evidence: r.evidence.filter((e) => !readCallee(e)) };
      if (lost) {
        delete x.endpoint;
        if (x.confidence === "verified") x.confidence = "inferred";
      }
      out.push(x as unknown as CatalogRecord);
      continue;
    }
    if (c.kind === "Table") {
      // Its first evidence is its owner's; the others' are their reads and writes.
      const owner = r.evidence[0]?.repo;
      const name = String(r.name ?? "");
      const comps = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
      if (blind(owner)) {
        out.push({
          ...r,
          evidence: evIn(r, blind),
          readers: comps(r.readers).filter((x) => !repoOf(x) || blind(repoOf(x))),
          writers: comps(r.writers).filter((x) => !repoOf(x) || blind(repoOf(x))),
        } as unknown as CatalogRecord);
        continue;
      }
      for (const [list, access] of [
        [r.readers, "read"],
        [r.writers, "write"],
      ] as const)
        for (const comp of comps(list)) {
          const repo = repoOf(comp);
          if (!blind(repo)) continue;
          const ev = evIn(r, (x) => x === repo);
          if (ev.length) out.push(loose(comp, "db-access", `${access} ${name}`, ev));
        }
      continue;
    }
    if (c.kind === "Unresolved") {
      out.push(c);
      continue;
    }
    // Anything else: what the repos not read say of it, beside what the scan reads.
    out.push({ ...r, evidence: evIn(r, blind) } as unknown as CatalogRecord);
  }
  return out;
}

const HTTP_VERB = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|ANY)$/;

/** A call's path without its scheme and host, normalized; a topic as written. */
function callPath(target: string): string {
  const t = target.trim();
  if (!t.includes("/")) return t;
  return normalizePath(t.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "") || "/");
}

const tableName = (v: unknown) =>
  typeof v === "string" && v ? v.split(".").pop()!.toLowerCase() : undefined;

const verb = (m: unknown) => {
  const v = String(m ?? "").toUpperCase();
  return v === "ANY" ? "" : v;
};

/**
 * The ends of a call a record makes, by owner and direction: an HTTP (or other) call by its
 * caller, method and path; an event by its publisher and its subscriber with the topic; a table
 * by its readers and writers. An empty method matches any.
 */
function callEnds(r: CatalogRecord): { key: string; method: string }[] {
  const x = r as unknown as Record<string, unknown>;
  if (r.kind === "Table") {
    const name = tableName(x.name);
    if (!name) return [];
    const of = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    return [
      ...of(x.readers).map((c) => ({ key: `${c}|db-read|${name}`, method: "" })),
      ...of(x.writers).map((c) => ({ key: `${c}|db-write|${name}`, method: "" })),
    ];
  }
  if (r.kind === "Interface") {
    const path = callPath(String(x.normalizedPath ?? ""));
    if (!x.from || !x.to || !path) return [];
    if (x.via === "event-bus" || x.via === "mq")
      return [
        { key: `${String(x.from)}|pub|${path}`, method: "" },
        { key: `${String(x.to)}|sub|${path}`, method: "" },
      ];
    return [{ key: `${String(x.from)}|call|${path}`, method: verb(x.method) }];
  }
  if (r.kind !== "Unresolved") return [];
  const owner = String(x.owner ?? "");
  const raw = String(x.raw ?? "");
  const kind = String(x.unresolvedKind ?? "");
  if (!owner || !raw) return [];
  if (kind === "event-publish") return [{ key: `${owner}|pub|${raw}`, method: "" }];
  if (kind === "event-subscribe") return [{ key: `${owner}|sub|${raw}`, method: "" }];
  if (kind === "db-access") {
    const [access, name] = raw.split(/\s+/);
    const t = tableName(name);
    return t
      ? [{ key: `${owner}|db-${access === "write" ? "write" : "read"}|${t}`, method: "" }]
      : [];
  }
  if (kind === "http-call" || kind === "call") {
    // A reader's `GET https://host/path`; a fact's `GET https://host /path` (method, host or
    // base, path), or a topic alone.
    const words = raw.split(/\s+/).filter(Boolean);
    const method = words[0] && HTTP_VERB.test(words[0].toUpperCase()) ? words.shift()! : "";
    const target = words.join("");
    if (!method && kind === "call" && !target.includes("/"))
      return [{ key: `${owner}|pub|${target}`, method: "" }];
    return [{ key: `${owner}|call|${callPath(target)}`, method: verb(method) }];
  }
  return [{ key: `${owner}|${kind}|${raw}`, method: "" }];
}

/** An endpoint, a table, a column or a setting by what it names, as the cross-check note says. */
function thingKey(r: CatalogRecord): string | undefined {
  const x = r as unknown as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  if (r.kind === "Endpoint") {
    const path = s(x.normalizedPath) ?? s(x.pathOrTopic);
    return path && s(x.component)
      ? `${String(x.component)}|${verb(x.method)}|${callPath(path)}`
      : undefined;
  }
  if (r.kind === "Table") return s(x.name)?.toLowerCase();
  if (r.kind === "Column")
    return s(x.table) && s(x.name)
      ? `${String(x.table).split(".").pop()}.${String(x.name)}`.toLowerCase()
      : undefined;
  if (r.kind === "Setting") return s(x.key);
  return undefined;
}

const locOf = (e: Ev) =>
  e.repo && e.path && typeof e.line === "number" ? `${e.repo}\u0000${e.path}\u0000${e.line}` : "";

/**
 * The readers' records of a repo they stand in for, without those a carried fact record of
 * the repo has: the same call (its caller, method and path, or topic and side, a table's
 * reader or writer, or the same cited line), or the same endpoint, table, column or setting.
 * A fact's loose end (`unresolved.<fact-id>`) and the readers' own for one call, or a fact's
 * link and the readers' loose end, are never both kept. What the readers find besides stays.
 */
export function withoutCovered(
  repo: string,
  records: readonly CatalogRecord[],
  carry: Carry,
): { records: CatalogRecord[]; covered: number } {
  if (!carry.standIn.has(repo)) return { records: [...records], covered: 0 };
  const ends = new Map<string, Set<string>>();
  const locs = new Set<string>();
  const things = new Set<string>();
  for (const { r } of carry.held) {
    if (!fromFacts(r) || !reposOf(r).has(repo)) continue;
    for (const e of callEnds(r)) ends.set(e.key, (ends.get(e.key) ?? new Set()).add(e.method));
    if (r.kind === "Interface" || r.kind === "Unresolved")
      for (const e of evidenceOf(r)) if (locOf(e)) locs.add(locOf(e));
    const k = thingKey(r);
    if (k !== undefined) things.add(`${r.kind}|${k}`);
  }
  const covered = (x: CatalogRecord): boolean => {
    if (fromFacts(x)) return false;
    const k = thingKey(x);
    if (k !== undefined && things.has(`${x.kind}|${k}`)) return true;
    if (x.kind !== "Unresolved" && x.kind !== "Interface") return false;
    for (const e of callEnds(x)) {
      const ms = ends.get(e.key);
      if (ms && (ms.has("") || !e.method || ms.has(e.method))) return true;
    }
    const own =
      x.kind === "Unresolved" ? evidenceOf(x) : evidenceOf(x).filter((e) => e.side === "caller");
    return own.some((e) => locs.has(locOf(e)));
  };
  const out = records.filter((x) => !covered(x));
  return { records: out, covered: records.length - out.length };
}

/**
 * The scan's final records with what it carried: a carried record resting only on repos not
 * read (or stood in for) stands as it was over the merge's, and one the scan makes after its
 * merge (a feature, a glossary term) is added when the scan didn't make it again. A link or table
 * between such a repo and one read now is the merge's: it was joined again from both.
 */
export function withCarried(
  records: readonly CatalogRecord[],
  carry: Carry,
  covered: number,
): { records: CatalogRecord[]; summary: CarriedSummary } {
  const out = new Map(records.map((r) => [recordPath(r), r]));
  const unreadUsed = new Map<string, UnreadWhy>();
  const byWhy = new Map<UnreadWhy, number>();
  let n = 0;
  let fromFactsN = 0;
  for (const { r, onUnread, only } of carry.held) {
    const at = recordPath(r);
    if (only || (AFTER_MERGE.has(r.kind) && !out.has(at))) out.set(at, r);
    if (onUnread.length) {
      n++;
      for (const repo of onUnread) unreadUsed.set(repo, carry.why(repo));
      const why = WHY_ORDER.find((w) => onUnread.some((repo) => carry.why(repo) === w))!;
      byWhy.set(why, (byWhy.get(why) ?? 0) + 1);
    } else fromFactsN++;
  }
  return {
    records: [...out.values()].sort((a, b) =>
      a.kind === b.kind ? cmpText(a.id, b.id) : cmpText(a.kind, b.kind),
    ),
    summary: {
      unread: [...unreadUsed.keys()].sort(cmpText),
      records: n,
      by: WHY_ORDER.filter((w) => byWhy.has(w)).map((why) => ({
        why,
        repos: [...unreadUsed]
          .filter(([, w]) => w === why)
          .map(([r]) => r)
          .sort(cmpText),
        records: byWhy.get(why)!,
      })),
      fromFacts: fromFactsN,
      covered,
      outdated: carry.outdated,
    },
  };
}
