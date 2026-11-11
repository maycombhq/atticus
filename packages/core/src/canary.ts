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
 * Misreadings of real lines are the sample audit's (P3, ADR 0148); the two together give the
 * silent error rate: wrong claims graded as backed.
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
  /** The fact's cited value: a claim of the same kind on that line naming it is the removed one. */
  value: z.string().min(1),
  /**
   * The fact's path or key, folded with its parameters left out (`canaryNeedleOf`): a fact of the
   * kind with the same, cited anywhere, claims the removed one too.
   */
  needle: z.string().min(1),
  how: z.literal("commented"),
});
export type CanaryRemovedT = z.infer<typeof CanaryRemoved>;

/** The answer key a plant keeps on this machine (never in the copy, never in the metarepo). */
export const CanaryKey = z.strictObject({
  schema: z.literal(1),
  repo: z.string().min(1),
  seed: z.string().min(1),
  commit: z.string().optional(),
  /** The run folder: the copy, the prompt and the facts file the assistant writes. */
  run: z.string().min(1),
  copy: z.string().min(1),
  prompt: z.string().min(1),
  facts: z.string().min(1),
  stacks: z.array(z.string()),
  planted: z.array(CanaryPlanted),
  removed: z.array(CanaryRemoved),
  at: z.string(),
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
  seed: z.string().min(1),
  /** When it was scored, and who scored it. */
  at: z.string(),
  by: z.string().min(1),
  stacks: z.array(z.string()),
  /** The facts the read wrote, those the verifier kept and those it rejected. */
  read: z.strictObject({
    facts: z.number().int().nonnegative(),
    kept: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
  }),
  planted: z.array(
    CanaryPlanted.omit({ needle: true }).extend({
      /** found: a kept fact; rejected: only a fact the verifier refused; missed: none. */
      result: z.enum(["found", "rejected", "missed"]),
      /** The reader's fact that found it. */
      by: z.string().optional(),
    }),
  ),
  removed: z.array(
    CanaryRemoved.omit({ needle: true }).extend({
      /** absent: no fact claims it; kept: a kept fact still does (silent); rejected: one did, refused. */
      result: z.enum(["absent", "kept", "rejected"]),
      by: z.string().optional(),
    }),
  ),
  /** Planted found by a kept fact, of planted. */
  recall: CanaryRate,
  /** Removed the read still claimed, kept by the verifier or not: the reader's fabrication rate. */
  fabrication: CanaryRate,
  /** Removed still claimed by a fact the verifier kept: graded as backed, and wrong (silent). */
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

/** What a fact claims, as a removed fact is matched on: an entry's or call's path, a key, else its value. */
export function canaryNeedleOf(f: Fact): string {
  const x = f as unknown as Record<string, unknown>;
  if ((f.kind === "entry" || f.kind === "call") && typeof x.path === "string" && pathKey(x.path))
    return pathKey(x.path);
  if (f.kind === "config" && typeof x.key === "string" && foldCanary(x.key))
    return foldCanary(x.key);
  return foldCanary(f.cite.value) || f.cite.value;
}

/** Whether a fact is about a planted item: its kind, with the item's own words in its claim. */
export const plantedBy = (p: Pick<CanaryPlantedT, "kind" | "needle">, f: Fact): boolean =>
  f.kind === p.kind && canaryClaimText(f).includes(p.needle);

/**
 * Whether a fact claims a removed one: its kind, and the same path or key cited anywhere, or
 * cited on the commented line or one either side (the verifier's own window) with the removed
 * fact's value in its claim.
 */
export const removedBy = (r: CanaryRemovedT, f: Fact): boolean =>
  f.kind === r.kind &&
  (canaryNeedleOf(f) === r.needle ||
    (f.cite.file === r.file &&
      Math.abs(f.cite.line - r.line) <= 1 &&
      canaryClaimText(f).includes(foldCanary(r.value))));

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
 * rejected one only, or missed; each removed one absent, still claimed by a kept fact (a silent
 * fabrication), or claimed only by a rejected one (the verifier caught it). Recall and the
 * fabrication rate with their intervals.
 */
export function scoreCanary(
  key: Pick<CanaryKeyT, "repo" | "commit" | "seed" | "stacks" | "planted" | "removed">,
  read: { kept: readonly Fact[]; rejected: readonly Fact[] },
  o: { at: string; by: string },
): CanaryReportT {
  const planted = key.planted.map(({ needle: _n, ...p }) => {
    const k = key.planted.find((x) => x.id === p.id)!;
    const kept = read.kept.find((f) => plantedBy(k, f));
    const refused = kept ? undefined : read.rejected.find((f) => plantedBy(k, f));
    return {
      ...p,
      result: kept ? ("found" as const) : refused ? ("rejected" as const) : ("missed" as const),
      ...((kept ?? refused) ? { by: (kept ?? refused)!.id } : {}),
    };
  });
  const removed = key.removed.map((r) => {
    const kept = read.kept.find((f) => removedBy(r, f));
    const refused = kept ? undefined : read.rejected.find((f) => removedBy(r, f));
    return {
      ...(({ needle: _n, ...rest }) => rest)(r),
      result: kept ? ("kept" as const) : refused ? ("rejected" as const) : ("absent" as const),
      ...((kept ?? refused) ? { by: (kept ?? refused)!.id } : {}),
    };
  });
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
    },
    planted,
    removed,
    recall: canaryRate(planted.filter((p) => p.result === "found").length, planted.length),
    fabrication: canaryRate(removed.filter((r) => r.result !== "absent").length, removed.length),
    passed: canaryRate(removed.filter((r) => r.result === "kept").length, removed.length),
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

export interface SilentErrorRate {
  /** Wrong claims graded as backed, of the claims graded as backed that were measured. */
  silent: CanaryRateT;
  /** The sample audit's part: kept facts and backed links answered wrong, of those answered. */
  misread: CanaryRateT;
  /** The canaries' parts, summed over the latest run of each repo. */
  recall: CanaryRateT;
  /** Removed lines the read still claimed, kept or not. */
  fabrication: CanaryRateT;
  /** Removed lines the read claimed and the verifier kept: the canaries' silent errors. */
  passed: CanaryRateT;
  /** Removed lines a reader claimed that the verifier refused: flagged, so no silent error. */
  caught: number;
  repos: { audited: number; canaries: number };
}

const answered = (t: AuditTally) => t.right + t.wrong;

/**
 * The silent error rate (ADR 0196): of the claims graded as backed that were measured, the share
 * wrong. Two samples, pooled: the sample audit's answers on kept facts and on links joined by
 * something other than a guess (a misread real line, P3), and the canaries' kept facts about
 * planted and removed lines (a removed one claimed is a fabrication the verifier passed, Z2).
 * A guessed link, a planted item missed and a fabrication the verifier refused are not silent:
 * they are flagged or absent, the system working.
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
  const misread = canaryRate(wrong, backed);
  let found = 0;
  let planted = 0;
  let kept = 0;
  let claimed = 0;
  let removed = 0;
  let caught = 0;
  for (const c of canaries) {
    found += c.recall.k;
    planted += c.recall.n;
    kept += c.passed.k;
    claimed += c.fabrication.k;
    removed += c.removed.length;
    caught += c.removed.filter((r) => r.result === "rejected").length;
  }
  return {
    silent: canaryRate(wrong + kept, backed + found + kept),
    misread,
    recall: canaryRate(found, planted),
    fabrication: canaryRate(claimed, removed),
    passed: canaryRate(kept, removed),
    caught,
    repos: { audited: audit?.repos ?? 0, canaries: canaries.length },
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
