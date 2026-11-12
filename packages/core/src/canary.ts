import { z } from "zod";
import { parse, stringify } from "yaml";
import { wilson, type AuditPrecision, type AuditTally } from "./audit.js";
import { JOIN_GUESS_FLAGS, JOINED_BY_AI, JOINED_BY_PATH_OVERLAP } from "./facts-join.js";
import { isAdopted } from "./metarepo.js";
import type { Fact } from "./schema/facts.js";

/**
 * Canaries (plan item Z2, ADR 0196): in a scratch copy of a repo, never committed, Atticus plants
 * a few synthetic entries, calls, topics and config keys and comments out a few real ones the
 * verified facts cite. The person's assistant reads the copy as it reads any repo; the reader
 * must find the planted and miss the removed. That gives recall, and a fabrication rate the
 * verifier can't see (a claim about a line that is there but commented out passes the check that
 * the value is on the line), on the organisation's own code, with nobody labelling anything.
 * Misreadings of real lines are the sample audit's (P3, ADR 0148); the two side by side say how
 * often a claim graded as backed is wrong (the silent error rate, as two numbers, never pooled).
 *
 * Pure: the caller plants, reads and writes the files. Nothing here names a stack or framework;
 * the templates that plant are `@maycombhq/verify`'s.
 */

/**
 * Where a canary's reports are kept, relative to the root: `reports/canaries`, or
 * `.atticus/reports/canaries` when Atticus is adopted in a repo. One file per run,
 * `<date>-<repo>.yaml`; the only thing a canary writes in the metarepo.
 */
export const canaryReportsRelOf = (root: string): string =>
  isAdopted(root) ? ".atticus/reports/canaries" : "reports/canaries";

/**
 * A repo's name as a canary takes it (review of ADR 0196): letters, digits, `.`, `_` and `-`,
 * starting with a letter or digit, and never `..`, so no name reaches outside the folder it
 * names a file in.
 */
export const isCanaryRepoName = (repo: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo) && !repo.includes("..");

/**
 * The folder every run folder is made in, right in the system's temporary folder: made 0700 and
 * this user's own, so no other user can make or swap a run folder in it (review of ADR 0196). Its
 * name, like a run folder's, says nothing of a canary: a run folder is the read's workspace.
 */
export const CANARY_READS_DIR = "atticus-reads";

/**
 * A metarepo's id in a run folder's name: the first 8 characters of its state folder's name
 * (`metarepoStateDir`, ADR 0186), so a run folder is known as this metarepo's and no other's.
 */
export const isCanaryMetarepoId = (id: string): boolean => /^[0-9a-f]{8}$/.test(id);

/** The start of a run folder's name: `<repo>-<id8>-`, then the six characters mkdtemp adds. */
export const canaryRunPrefix = (repo: string, id: string): string => `${repo}-${id}-`;

/**
 * Whether a folder's base name is a run folder of this repo's and this metarepo's,
 * `<repo>-<id8>-XXXXXX`: neutral on purpose (review of ADR 0196), as the folder is the workspace
 * the read is made in.
 */
export const isCanaryRunName = (name: string, repo: string, id: string): boolean =>
  isCanaryRepoName(repo) &&
  isCanaryMetarepoId(id) &&
  name.startsWith(canaryRunPrefix(repo, id)) &&
  /^[A-Za-z0-9]{6}$/.test(name.slice(canaryRunPrefix(repo, id).length));

/** The repo and metarepo id a run folder's base name is of, or undefined when it is no run's. */
export function canaryRunOf(name: string): { repo: string; id: string } | undefined {
  const m = /^(.+)-([0-9a-f]{8})-[A-Za-z0-9]{6}$/.exec(name);
  return m && isCanaryRunName(name, m[1]!, m[2]!) ? { repo: m[1]!, id: m[2]! } : undefined;
}

/** What a planted item stands for: a route served, a call made, a topic, a config key. */
export const CANARY_WHATS = ["entry", "call", "topic-in", "topic-out", "config"] as const;
export type CanaryWhat = (typeof CANARY_WHATS)[number];

export const CanaryPlanted = z.strictObject({
  /** `plant:<n>`, in the order planted. */
  id: z.string().min(1),
  /** The fact kind a reader should write for it. */
  kind: z.enum(["entry", "call", "config"]),
  what: z.enum(CANARY_WHATS),
  /** The template's stack, as `@maycombhq/verify` names it. */
  stack: z.string().min(1),
  /** Where it was planted, repo-relative, and the line that holds it. */
  file: z.string().min(1),
  line: z.number().int().positive(),
  /** What it says, in one line (synthetic: no code of the repo). */
  claim: z.string().min(1),
  /**
   * Its own words, folded (`foldCanary`): a fact of its kind whose claim holds them is about it.
   * Drawn so that no fact of the repo holds them.
   */
  needle: z.string().min(1),
});
export type CanaryPlantedT = z.infer<typeof CanaryPlanted>;

export const CanaryRemoved = z.strictObject({
  /** `remove:<fact id>`. */
  id: z.string().min(1),
  /** The verified fact whose cited line was commented out. */
  fact: z.string().min(1),
  kind: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().positive(),
  /** The fact's claim, as the facts already state it. */
  claim: z.string().min(1),
  /** The fact's cited value: a fact of the kind citing that very line with it is the removed one. */
  value: z.string().min(1),
  /**
   * What the fact claims (`canaryNeedleOf`): an entry's or call's method and path with its
   * parameters left out (`get /ledger-v1-transfers`), a config key exactly, folded. A fact of the
   * kind with the same needle claims the removed one.
   */
  needle: z.string().min(1),
  how: z.literal("commented"),
});
export type CanaryRemovedT = z.infer<typeof CanaryRemoved>;

/** An item a stack's template has that wasn't planted, and why (the repo couldn't serve it). */
export const CanarySkipped = z.strictObject({
  stack: z.string().min(1),
  what: z.enum(CANARY_WHATS),
  reason: z.string().min(1),
});
export type CanarySkippedT = z.infer<typeof CanarySkipped>;

/**
 * The answer key a plant keeps on this machine (never in the copy, never in the metarepo). The
 * run folder is kept by its base name only, `<repo>-<id8>-XXXXXX` (review of ADR 0196): its path
 * is rebuilt under `<temporary folder>/atticus-reads` and checked (the metarepo's id included)
 * before anything in it is read, written or deleted, so a key edited by hand can't point anywhere
 * else.
 */
export const CanaryKey = z
  .strictObject({
    schema: z.literal(1),
    repo: z.string().refine(isCanaryRepoName, "not a repo name"),
    seed: z.string().min(1),
    commit: z.string().optional(),
    /** The run folder's base name: the copy (`<repo>/`), `prompt.md` and `facts.jsonl` are in it. */
    run: z.string().min(1),
    /**
     * The real path of the `atticus-reads` folder the run folder is in (third review of ADR 0196),
     * so a temporary folder set otherwise later still finds it; checked again (named so, a real
     * folder by its real path, this user's, closed to others) before it is used. A key planted
     * before has none: its run is in the temporary folder's.
     */
    reads: z.string().min(1).optional(),
    stacks: z.array(z.string()),
    planted: z.array(CanaryPlanted),
    removed: z.array(CanaryRemoved),
    skipped: z.array(CanarySkipped).default([]),
    at: z.string(),
  })
  .refine((k) => canaryRunOf(k.run)?.repo === k.repo, {
    message: "run is not this repo's run folder name",
    path: ["run"],
  });
export type CanaryKeyT = z.infer<typeof CanaryKey>;

/** A share with its count and the Wilson interval at 95% (null with nothing to count). */
export const CanaryRate = z.strictObject({
  k: z.number().int().nonnegative(),
  n: z.number().int().nonnegative(),
  rate: z.number().nullable(),
  low: z.number().nullable(),
  high: z.number().nullable(),
});
export type CanaryRateT = z.infer<typeof CanaryRate>;

export const CanaryReport = z.strictObject({
  schema: z.literal(1),
  repo: z.string().min(1),
  commit: z.string().optional(),
  /** The seed it was planted by: drawn at random unless one was given, so no read can guess it. */
  seed: z.string().min(1),
  /** When it was scored, and who scored it. */
  at: z.string(),
  by: z.string().min(1),
  stacks: z.array(z.string()),
  /** The facts the read wrote, those the verifier kept and rejected, and lines that didn't read. */
  read: z.strictObject({
    facts: z.number().int().nonnegative(),
    kept: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    unread: z.number().int().nonnegative().default(0),
  }),
  /**
   * Each planted item by an opaque id, what it stood for, its stack and how the read did: never
   * its words, file or line (review of ADR 0196), so a committed report teaches no read what a
   * canary plants.
   */
  planted: z.array(
    CanaryPlanted.pick({ id: true, kind: true, what: true, stack: true }).extend({
      /** found: a kept fact; rejected: only a fact the verifier refused; missed: none. */
      result: z.enum(["found", "rejected", "missed"]),
    }),
  ),
  /** The items the templates have that this repo couldn't serve, so weren't planted. */
  skipped: z.array(CanarySkipped).default([]),
  removed: z.array(
    CanaryRemoved.omit({ needle: true }).extend({
      /**
       * absent: no fact claims it; kept: a kept fact cites its line or one beside it, by its cite
       * or a part (silent); rejected: one did, refused; elsewhere: a fact names its path or key
       * but cites neither its line nor one beside it, so may be about another line (in no rate).
       */
      result: z.enum(["absent", "kept", "rejected", "elsewhere"]),
      by: z.string().optional(),
    }),
  ),
  /** Planted found by a kept fact, of planted. */
  recall: CanaryRate,
  /** Removed the read still claimed at its line, kept by the verifier or not: the reader's rate. */
  fabrication: CanaryRate,
  /** Removed still claimed at its line by a fact the verifier kept: backed, and wrong (silent). */
  passed: CanaryRate,
});
export type CanaryReportT = z.infer<typeof CanaryReport>;

export function parseCanaryReport(
  text: string,
): { ok: true; report: CanaryReportT } | { ok: false; issues: string[] } {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    return { ok: false, issues: [`not YAML: ${(e as Error).message.split("\n")[0]}`] };
  }
  const r = CanaryReport.safeParse(raw);
  if (!r.success)
    return {
      ok: false,
      issues: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  return { ok: true, report: r.data };
}

export const serializeCanaryReport = (r: CanaryReportT): string =>
  stringify(CanaryReport.parse(r), { lineWidth: 0 });

/** Lowercase, every run of other characters one `-`: `W1_W2_URL`, `w1.w2-url` and `w1-w2-url` alike. */
export const foldCanary = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** The words of a fact's claim a canary is matched on: its path, topic, key, name and cited value. */
export function canaryClaimText(f: Fact): string {
  const x = f as unknown as Record<string, unknown>;
  return ["path", "key", "name", "topic", "source", "base"]
    .map((k) => (typeof x[k] === "string" ? (x[k] as string) : ""))
    .concat(f.cite.value)
    .map(foldCanary)
    .filter(Boolean)
    .join(" ");
}

/** A path with its parameters left out (`{id}`, `:id`), folded: `/a/{id}/b` and `/a/:x/b` alike. */
const pathKey = (p: string) => foldCanary(p.replace(/\{[^}]*\}|:[A-Za-z_]\w*/g, "-param-"));

/**
 * What a fact claims, as a removed fact is matched on: an entry's or call's method and path, its
 * parameters left out (`get ledger-v1-transfers-param`; the path alone with no method), a config
 * key exactly, else its cited value, folded. Second review of ADR 0196: the method is part of it,
 * so `PUT /users` beside a removed `GET /users` is no claim of it.
 */
export function canaryNeedleOf(f: Fact): string {
  const x = f as unknown as Record<string, unknown>;
  if ((f.kind === "entry" || f.kind === "call") && typeof x.path === "string" && pathKey(x.path))
    return withMethod(x.method, pathKey(x.path));
  if (f.kind === "config" && typeof x.key === "string" && foldCanary(x.key))
    return foldCanary(x.key);
  return foldCanary(f.cite.value) || f.cite.value;
}

const withMethod = (method: unknown, path: string) =>
  typeof method === "string" && foldCanary(method) ? `${foldCanary(method)} ${path}` : path;

/**
 * A method that is any method: none, ASP.NET's and the bench's `ANY`, Express's `ALL`
 * (`router.all(...)`, fourth review), or `*` (which folds to nothing, so its needle has no
 * method). Third review of ADR 0196.
 */
const anyMethod = (m: string | undefined) => m === undefined || m === "any" || m === "all";

/** Two needles alike: the same path or key, and the same method unless either is any method. */
function sameNeedle(a: string, b: string): boolean {
  const [am, ap] = a.includes(" ") ? a.split(" ") : [undefined, a];
  const [bm, bp] = b.includes(" ") ? b.split(" ") : [undefined, b];
  return ap === bp && (anyMethod(am) || anyMethod(bm) || am === bm);
}

/** Whether a fact is about a planted item: its kind, with the item's own words in its claim. */
export const plantedBy = (p: Pick<CanaryPlantedT, "kind" | "needle">, f: Fact): boolean =>
  f.kind === p.kind && canaryClaimText(f).includes(p.needle);

/** Whether a fact cites a file within one line of a line, by its cite or one of its `cite.with` parts. */
const citesNear = (f: Fact, file: string, line: number): boolean =>
  [f.cite, ...(f.cite.with ?? [])].some((c) => c.file === file && Math.abs(c.line - line) <= 1);

/**
 * How a fact claims a removed one (second review of ADR 0196): `near` when it is of its kind,
 * cites the commented line or one either side (the verifier's window), by its cite or a
 * `cite.with` part, and claims the same: the same needle (method and path, or the key exactly).
 * `value` when it claims it by its cited value only: it cites that very line with that value, or
 * (an entry or call) its path is the value with the same method (a path the read wrote without
 * the base the removed fact put in front). `elsewhere` when it has the same needle but cites
 * neither the line nor one beside it, so may well be about another line (never counted as passed).
 * A claim that merely holds the removed value (`/users/:id` beside a removed `/users`, a key
 * `url-fallback` beside a removed `url`) is none of these: a fact of the line beside it.
 */
export function removedMatch(
  r: CanaryRemovedT,
  f: Fact,
): "near" | "value" | "elsewhere" | undefined {
  if (f.kind !== r.kind) return undefined;
  const same = sameNeedle(canaryNeedleOf(f), r.needle);
  const near = citesNear(f, r.file, r.line);
  if (near && same) return "near";
  const v = foldCanary(r.value);
  if (
    near &&
    v &&
    ([f.cite, ...(f.cite.with ?? [])].some(
      (c) => c.file === r.file && c.line === r.line && foldCanary(c.value) === v,
    ) ||
      ((f.kind === "entry" || f.kind === "call") &&
        /^\//.test(r.value.trim()) &&
        sameNeedle(
          canaryNeedleOf(f),
          withMethod(r.needle.includes(" ") ? r.needle.split(" ")[0] : undefined, pathKey(r.value)),
        )))
  )
    return "value";
  return same ? "elsewhere" : undefined;
}

/** Whether a fact claims a removed one: at its line (`near`, by needle or value) or `elsewhere`. */
export function removedBy(r: CanaryRemovedT, f: Fact): "near" | "elsewhere" | undefined {
  const m = removedMatch(r, f);
  return m === "value" ? "near" : m;
}

export function canaryRate(k: number, n: number): CanaryRateT {
  const ci = wilson(k, n);
  return {
    k,
    n,
    rate: n ? Math.round((k / n) * 1000) / 1000 : null,
    low: ci?.low ?? null,
    high: ci?.high ?? null,
  };
}

/**
 * Score a read of the copy against the key: each planted item found by a kept fact, by a
 * rejected one only, or missed; each removed one absent, still claimed at its line by a kept fact
 * (a silent fabrication), claimed there only by a rejected one (the verifier caught it), or named
 * only by a fact cited elsewhere. One fact answers for one item at most (review of ADR 0196): the
 * planted items are matched in order, each to the first fact not yet taken, then the removed ones
 * in passes, strongest match first (`removedMatch`). Recall and the fabrication rate with their
 * intervals.
 */
export function scoreCanary(
  key: Pick<CanaryKeyT, "repo" | "commit" | "seed" | "stacks" | "planted" | "removed"> & {
    skipped?: CanaryKeyT["skipped"];
  },
  read: { kept: readonly Fact[]; rejected: readonly Fact[]; unread?: number },
  o: { at: string; by: string },
): CanaryReportT {
  const taken = new Set<Fact>();
  const first = (list: readonly Fact[], ok: (f: Fact) => boolean) => {
    const f = list.find((x) => !taken.has(x) && ok(x));
    if (f) taken.add(f);
    return f;
  };
  const planted = key.planted.map((p) => {
    const kept = first(read.kept, (f) => plantedBy(p, f));
    const refused = kept ? undefined : first(read.rejected, (f) => plantedBy(p, f));
    return {
      id: p.id,
      kind: p.kind,
      what: p.what,
      stack: p.stack,
      result: kept ? ("found" as const) : refused ? ("rejected" as const) : ("missed" as const),
    };
  });
  // Second review of ADR 0196: in passes, each over every removed line not yet matched, so a
  // fact that claims one line by its needle is never taken first by the line beside it on a
  // weaker match: the same needle at the line (kept, then refused), then the value at the line,
  // then the same needle cited elsewhere.
  const got = new Map<string, { result: Got; by: Fact }>();
  type Got = "kept" | "rejected" | "elsewhere";
  const passes: [list: readonly Fact[], m: "near" | "value" | "elsewhere", r: Got][] = [
    [read.kept, "near", "kept"],
    [read.rejected, "near", "rejected"],
    [read.kept, "value", "kept"],
    [read.rejected, "value", "rejected"],
    [[...read.kept, ...read.rejected], "elsewhere", "elsewhere"],
  ];
  for (const [list, m, result] of passes)
    for (const r of key.removed) {
      if (got.has(r.id)) continue;
      const f = first(list, (x) => removedMatch(r, x) === m);
      if (f) got.set(r.id, { result, by: f });
    }
  const removed = key.removed.map((r) => {
    const g = got.get(r.id);
    return {
      ...(({ needle: _n, ...rest }) => rest)(r),
      result: g?.result ?? ("absent" as const),
      ...(g ? { by: g.by.id } : {}),
    };
  });
  // A line a fact names only elsewhere isn't known to be claimed or not: in neither rate's count.
  const counted = removed.filter((r) => r.result !== "elsewhere");
  return {
    schema: 1,
    repo: key.repo,
    ...(key.commit ? { commit: key.commit } : {}),
    seed: key.seed,
    at: o.at,
    by: o.by,
    stacks: [...key.stacks],
    read: {
      facts: read.kept.length + read.rejected.length,
      kept: read.kept.length,
      rejected: read.rejected.length,
      unread: read.unread ?? 0,
    },
    planted,
    skipped: [...(key.skipped ?? [])],
    removed,
    recall: canaryRate(planted.filter((p) => p.result === "found").length, planted.length),
    fabrication: canaryRate(
      counted.filter((r) => r.result === "kept" || r.result === "rejected").length,
      counted.length,
    ),
    passed: canaryRate(counted.filter((r) => r.result === "kept").length, counted.length),
  };
}

/**
 * The joins a link may rest on that are guesses (ADR 0124 addenda F-honest, F-how; the AI's
 * pairings, ADR 0181): a link joined so is graded inferred, never backed, so a wrong one is no
 * silent error.
 */
const GUESSED: ReadonlySet<string> = new Set([
  ...JOIN_GUESS_FLAGS,
  JOINED_BY_PATH_OVERLAP,
  JOINED_BY_AI,
]);
const GUESSED_JOINS = { test: (how: string) => GUESSED.has(how) };

/**
 * How often a claim graded as backed is wrong (ADR 0196, as revised on review): two numbers side
 * by side, each with its count and interval, never pooled into one. Their samples are of different
 * things (real lines a person answered; lines Atticus took out), and a pooled figure let the
 * canaries' found plants, right by construction, pad its denominator.
 */
export interface SilentErrorRate {
  /** The audit misread rate: kept facts and backed links answered wrong, of those answered. */
  misread: CanaryRateT;
  /**
   * The canary pass-through rate: lines taken out that the read still claimed at their place and
   * the verifier kept, of the lines taken out (less those a fact names only elsewhere).
   */
  passed: CanaryRateT;
  /** Planted items found, summed over the latest run of each repo. */
  recall: CanaryRateT;
  /** Removed lines the read still claimed, kept or not. */
  fabrication: CanaryRateT;
  /** Removed lines a reader claimed that the verifier refused: flagged, so no silent error. */
  caught: number;
  /** Removed lines a fact named only elsewhere: in neither count. */
  elsewhere: number;
  repos: { audited: number; canaries: number };
  /** What the canaries' numbers cover: each stack planted in, with the items planted there. */
  covers: { stack: string; what: CanaryWhat[] }[];
}

const answered = (t: AuditTally) => t.right + t.wrong;

/** Each stack the reports planted in, with the items planted there, in a fixed order. */
export function canaryCovers(
  reports: readonly { planted: readonly { stack: string; what: CanaryWhat }[] }[],
): { stack: string; what: CanaryWhat[] }[] {
  const by = new Map<string, Set<CanaryWhat>>();
  for (const r of reports)
    for (const p of r.planted) by.set(p.stack, (by.get(p.stack) ?? new Set()).add(p.what));
  return [...by.keys()]
    .sort()
    .map((stack) => ({ stack, what: CANARY_WHATS.filter((w) => by.get(stack)!.has(w)) }));
}

/**
 * The two numbers (ADR 0196): the audit misread rate, from the sample audit's answers on kept
 * facts and on links joined by something other than a guess (a misread real line, P3); and the
 * canary pass-through rate, from the latest canary of each repo (a removed line still claimed and
 * kept is a fabrication the verifier passed, Z2). A guessed link, a planted item missed and a
 * fabrication the verifier refused are not silent: they are flagged or absent, the system working.
 */
export function silentErrorRate(
  audit: { precision: AuditPrecision; repos: number } | undefined,
  canaries: readonly CanaryReportT[],
): SilentErrorRate {
  let wrong = 0;
  let backed = 0;
  if (audit) {
    const p = audit.precision;
    const links = Object.entries(p.byHow).filter(([how]) => !GUESSED_JOINS.test(how));
    wrong += p.facts.wrong + links.reduce((n, [, t]) => n + t.wrong, 0);
    backed += answered(p.facts) + links.reduce((n, [, t]) => n + answered(t), 0);
  }
  let found = 0;
  let planted = 0;
  let kept = 0;
  let claimed = 0;
  let removed = 0;
  let caught = 0;
  let elsewhere = 0;
  for (const c of canaries) {
    found += c.recall.k;
    planted += c.recall.n;
    kept += c.passed.k;
    claimed += c.fabrication.k;
    removed += c.passed.n;
    caught += c.removed.filter((r) => r.result === "rejected").length;
    elsewhere += c.removed.filter((r) => r.result === "elsewhere").length;
  }
  return {
    misread: canaryRate(wrong, backed),
    passed: canaryRate(kept, removed),
    recall: canaryRate(found, planted),
    fabrication: canaryRate(claimed, removed),
    caught,
    elsewhere,
    repos: { audited: audit?.repos ?? 0, canaries: canaries.length },
    covers: canaryCovers(canaries),
  };
}

/** The latest report of each repo, by when it was scored. */
export function latestCanaries(reports: readonly CanaryReportT[]): CanaryReportT[] {
  const by = new Map<string, CanaryReportT>();
  for (const r of reports) {
    const had = by.get(r.repo);
    if (!had || had.at < r.at) by.set(r.repo, r);
  }
  return [...by.values()].sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
}
