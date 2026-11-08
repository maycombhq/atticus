import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  Conventions,
  DEFAULT_CONVENTIONS,
  factsDirOf,
  isAdopted,
  isSecretPath,
  loadOrgPack,
  orgPackDirOf,
  parseCorrections,
  parseFactsLines,
  QuestionDraft,
  raiseQuestions,
  serializeFacts,
  type Fact,
  type FactCorrection,
  type Question,
} from "@maycombhq/core";
import {
  frameworkFacts,
  insideRepo,
  parseReviewed,
  type CarryChanges,
  type FileSource,
  type ReviewedEntry,
  type FormSlip,
  type VerifyReport,
} from "@maycombhq/verify";
import { changesSince, createGit, type GitRunner } from "@maycombhq/workspace";
import { repoFor } from "./repo-for.js";

/**
 * The files of a repo's read (ADR 0124), shared by `atticus verify` and `atticus map`: where the
 * repo's checkout is, the commit, the accepted exclusions, the questions the reader raised, and
 * the verifier's results written beside the facts file.
 */

/** The repo's checkout: the folder given, the repo itself when adopted, else its base clone. */
export async function checkoutOf(
  root: string,
  repo: string,
  dir?: string,
): Promise<string | undefined> {
  return dir ?? (isAdopted(root) ? root : ((await repoFor(root, repo))?.dir ?? undefined));
}

export async function headOf(dir: string): Promise<string | undefined> {
  try {
    const r = await createGit({ timeoutMs: 30_000 })(["rev-parse", "HEAD"], dir);
    return r.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The files changed since each earlier commit the facts name, to `commit` (ADR 0124 addendum
 * A-incremental), read with local git in the checkout; a commit the clone doesn't have is
 * `missing`, and its facts are read again whole.
 */
export async function carryOf(
  dir: string,
  facts: readonly Fact[],
  commit: string | undefined,
  git?: GitRunner,
): Promise<{ carry: CarryChanges; missing: string[] }> {
  if (!commit) return { carry: {}, missing: [] };
  const r = await changesSince(
    dir,
    facts.map((f) => f.commit),
    commit,
    git,
  );
  return { carry: r.changes, missing: r.missing };
}

/** Exclusion globs a person accepted for this repo (ADR 0075 scan settings). */
/**
 * The org pack's conventions (ADR 0147, `conventions.yaml`): the built-in lists when there is
 * no file, or when it doesn't read (`atticus doctor` and the org pack's load say why).
 */
export async function conventionsAt(root: string): Promise<Conventions> {
  const file = join(orgPackDirOf(root), "conventions.yaml");
  if (!existsSync(file)) return DEFAULT_CONVENTIONS;
  try {
    const r = Conventions.safeParse(parse(await readFile(file, "utf8")));
    return r.success ? r.data : DEFAULT_CONVENTIONS;
  } catch {
    return DEFAULT_CONVENTIONS;
  }
}

export async function excludesOf(root: string, repo: string): Promise<string[]> {
  const file = join(orgPackDirOf(root), "scan", `${repo}.yaml`);
  if (!existsSync(file)) return [];
  try {
    const doc = parse(await readFile(file, "utf8")) as { exclude?: { path?: string }[] } | null;
    return (doc?.exclude ?? []).map((e) => e.path).filter((p): p is string => !!p);
  } catch {
    return [];
  }
}

/** A question line the reader wrote that can't be raised, and why. */
export interface QuestionProblem {
  line: string;
  message: string;
}

/**
 * The questions a reader raised (ADR 0078's `QuestionDraft`, one JSON object per line), each
 * evidence line checked to exist in the repo, written to questions/ with `raiseQuestions`. A
 * question already on file isn't asked again.
 */
export async function raiseReadQuestions(
  root: string,
  repo: string,
  lines: readonly unknown[],
  source: FileSource,
  by: { command: string; run?: string; at: string },
): Promise<{ raised: Question[]; known: Question[]; problems: QuestionProblem[] }> {
  const drafts: QuestionDraft[] = [];
  const problems: QuestionProblem[] = [];
  for (const raw of lines) {
    const line = JSON.stringify(raw);
    const r = QuestionDraft.safeParse(raw);
    if (!r.success) {
      problems.push({
        line,
        message: `not a question: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
      });
      continue;
    }
    const bad = r.data.evidence.find((e) => {
      const file = e.slice(0, e.lastIndexOf(":"));
      const n = Number(e.slice(e.lastIndexOf(":") + 1));
      if (!insideRepo(file) || isSecretPath(file)) return true;
      const text = source.read(file);
      return text === undefined || n < 1 || n > text.split(/\r?\n/).length;
    });
    if (bad) {
      problems.push({ line, message: `its evidence ${bad} is no line of the repo` });
      continue;
    }
    drafts.push(r.data);
  }
  if (!drafts.length) return { raised: [], known: [], problems };
  const r = await raiseQuestions(root, drafts, {
    step: "map",
    repo,
    command: by.command,
    rerun: `atticus map ${repo}`,
    ...(by.run ? { run: by.run } : {}),
    at: by.at,
  });
  return { raised: r.raised, known: [...r.known, ...r.reused], problems };
}

export interface VerifySummary {
  repo: string;
  commit?: string;
  accepted: number;
  rejected: number;
  redacted: number;
  /**
   * Quotes left off a kept fact, the cited line being one a quote can't be checked against (ADR
   * 0124 addendum A-uncited). Left out when none, so reports with no such quote are as they were.
   */
  quotesDropped?: number;
  coverage: {
    ratio: number;
    read: number;
    /** Files the reader read and found no fact in (ADR 0124 addendum A-read); left out when none. */
    reviewed?: number;
    unknown: string[];
    excluded: string[];
    /** ADR 0169: model files the read plan leaves out, nothing reaching them; left out when none. */
    notReached?: string[];
  };
  rejections: { id: string; code: string; message: string }[];
  /**
   * The facts this run carried from an earlier commit to `commit` (ADR 0124 addendum
   * A-incremental): every file they cite unchanged since, their lines checked again. Their
   * `commit` in the facts file is now `commit`; this is where they were read. Left out when none.
   */
  carried?: { from: string; facts: string[] }[];
  /** A person's corrections the verifier applied, and those that met no fact. */
  corrections?: {
    applied: { fact: string; action: string; by: string }[];
    stale: { fact: string; why: string; message: string }[];
  };
  /**
   * A note, not a rejection (ADR 0124 addendum C-estate): the listeners and the rest or gRPC
   * entries no flow starts, for the reader to follow with a flow each. Left out when none.
   */
  entriesNoFlowFollows?: VerifyReport["entriesNoFlowFollows"];
  /**
   * The reader's `<repo>.reviewed.jsonl` lines that hold (ADR 0124 addendum A-read), each with
   * why and the files it stands for, for a person to challenge. Left out when none.
   */
  reviewed?: VerifyReport["reviewed"];
  /** R6: the reviewed globs that match no file, dropped with a note. Left out when none. */
  reviewedDropped?: VerifyReport["reviewedDropped"];
  /** P2: how many kept entries and calls claim a method their lines don't write; left out when none. */
  methodUnseenCount?: number;
  /** P2: those entries and calls, each with where it is cited (a warning, not a rejection). */
  methodUnseen?: VerifyReport["methodUnseen"];
  /**
   * R1: how many lines of the files read write a path, URL or topic no kept fact cites or names;
   * left out when none. A note for the reader to check, never a rejection.
   */
  skippedCount?: number;
  /** R1: the first of them (at most `SKIPPED_LISTED`); `atticus verify <repo> --skipped` prints all. */
  skipped?: VerifyReport["skipped"];
  /** R1: the reviewed globs whose files write such a line, each with the first few. */
  reviewedHolds?: VerifyReport["reviewedHolds"];
  /** R1: how many operations the repo's OpenAPI specs declare that no entry covers. */
  specOpsUncoveredCount?: number;
  /** R1: the first of them (at most `SKIPPED_LISTED`). */
  specOpsUncovered?: VerifyReport["specOpsUncovered"];
  /** R6: the slips of form fixed in the facts (a slugged id, a flow's cite). Left out when none. */
  slips?: FormSlip[];
  /**
   * A note: the entries whose `auth` rests on no cited line (ADR 0124 addendum A-uncited). The
   * claim is in the facts file and not in the catalog. Left out when none.
   */
  authUncited?: VerifyReport["authUncited"];
  /**
   * What the repo is built on, as its framework facts say (ADR 0124 addendum A-framework): the
   * name, the version when one is declared, and where. Left out when the facts name none.
   */
  frameworks?: { name: string; version?: string; cite: string; component?: string }[];
  /**
   * A note, not a rejection (A-framework): a framework the repo declares whose patterns none of
   * the facts show, which is usually a missed read. Left out when there are none.
   */
  frameworkGaps?: VerifyReport["frameworkGaps"];
}

/**
 * The estate an exposure may name (ADR 0143): every repo of the org pack's manifests, its
 * component and its modules' components; and (beta.10) the components each repo's facts file
 * names, so `<repo>/<module>` can name a module the manifest doesn't list. A repo with no facts
 * file yet is left out of `repoComponents`. Undefined when there is no org pack, or it lists no
 * repo, so nothing checks the name then.
 */
export async function estateComponentsOf(
  root: string,
): Promise<{ components: string[]; repoComponents: Record<string, string[]> } | undefined> {
  const op = await loadOrgPack(orgPackDirOf(root)).catch(() => undefined);
  const repos = (op?.profiles ?? []).flatMap((p) => p.repos?.repos ?? []);
  if (!repos.length) return undefined;
  const components = repos.flatMap((r) => [
    r.id,
    ...(r.component ? [r.component] : []),
    ...(r.modules ?? []).map((m) => m.component),
  ]);
  const repoComponents: Record<string, string[]> = {};
  for (const r of repos) {
    const text = await readFile(join(factsDirOf(root), `${r.id}.jsonl`), "utf8").catch(
      () => undefined,
    );
    if (text === undefined) continue;
    const named = parseFactsLines(text).facts.flatMap((f) => (f.component ? [f.component] : []));
    repoComponents[r.id] = [
      ...new Set([r.component ?? r.id, ...(r.modules ?? []).map((m) => m.component), ...named]),
    ].sort();
  }
  return { components: [...new Set(components)].sort(), repoComponents };
}

/**
 * How many skipped lines and uncovered spec operations `<repo>.verify.yaml` lists (R1); the
 * count says how many there are, and `atticus verify <repo> --skipped` prints every one.
 */
export const SKIPPED_LISTED = 100;

/** A line of `<repo>.reviewed.jsonl` refused: not an entry, or naming no file of the repo. */
export interface ReviewedLineProblem {
  line?: number;
  raw: unknown;
  message: string;
}

/**
 * Write the verifier's results: the kept facts in canonical form, the rejected ones (and any
 * question that couldn't be raised) with their reasons in `<repo>.rejected.jsonl` for the reader
 * to fix, and `<repo>.verify.yaml` with the coverage.
 *
 * The facts file keeps every claim its reader wrote (ADR 0124 addendum A-uncited). Two things are
 * rewritten, and only in the bytes: a quote's secret value is redacted, and a quote the cited
 * line can't be checked against is left off and counted. A claim the catalog mustn't carry — an
 * `auth` no line is cited for — is dropped on the way into the catalog (`catalogAuth`), not here,
 * so the warning for it is still raised the next time the facts are verified.
 */
/**
 * R6: the note a run gives for the slips of form it fixed (`atticus verify`, `atticus map`), the
 * same words wherever the repair runs: a heading, the first `shown` fixes, and how many more.
 */
export function slipNoteLines(slips: readonly FormSlip[], verifyYaml: string, shown = 5): string[] {
  if (!slips.length) return [];
  return [
    `${slips.length} ${slips.length === 1 ? "slip" : "slips"} of form fixed in the facts (a note, not a rejection; under slips in ${verifyYaml}):`,
    ...slips.slice(0, shown).map((x) => `  ${x.message}`),
    ...(slips.length > shown
      ? [`  ... and ${slips.length - shown} more (slips in ${verifyYaml})`]
      : []),
  ];
}

export async function writeVerifyFiles(
  root: string,
  repo: string,
  report: VerifyReport,
  commit: string | undefined,
  questionProblems: readonly QuestionProblem[] = [],
  /** Lines of the facts file that aren't facts: kept here, with why, so nothing is lost. */
  badLines: readonly { line: number; raw: string; message: string }[] = [],
  /** Lines of `<repo>.reviewed.jsonl` refused (A-read): kept here, with why, for the reader to fix. */
  reviewedProblems: readonly ReviewedLineProblem[] = [],
  /** R6: the slips of form fixed in the facts before they were checked. */
  slips: readonly FormSlip[] = [],
): Promise<VerifySummary> {
  const dir = factsDirOf(root);
  await mkdir(dir, { recursive: true });
  // Round 40: a fact read at another commit than the clone's isn't wrong, it is of another
  // commit: it stays in the facts file (and is still refused), so a run on the wrong checkout
  // never empties the file and lets the next run write a catalog without that repo's records.
  const otherCommit = report.rejected.filter((r) => r.code === "wrong-commit").map((r) => r.fact);
  await writeFile(
    join(dir, `${repo}.jsonl`),
    serializeFacts([...report.accepted, ...otherCommit]),
    "utf8",
  );
  const rejectedFile = join(dir, `${repo}.rejected.jsonl`);
  const lines = [
    ...report.rejected.map((r) =>
      JSON.stringify({ code: r.code, message: r.message, fact: r.fact }),
    ),
    ...questionProblems.map((q) =>
      JSON.stringify({ code: "bad-question", message: q.message, question: JSON.parse(q.line) }),
    ),
    ...badLines.map((b) => JSON.stringify({ code: "schema", message: b.message, raw: b.raw })),
    ...reviewedProblems.map((r) =>
      JSON.stringify({ code: "bad-reviewed", message: r.message, reviewed: r.raw }),
    ),
  ];
  if (lines.length) await writeFile(rejectedFile, lines.join("\n") + "\n", "utf8");
  else await rm(rejectedFile, { force: true });
  const summary: VerifySummary = {
    repo,
    ...(commit ? { commit } : {}),
    accepted: report.accepted.length,
    rejected: report.rejected.length,
    redacted: report.redacted,
    ...(report.quotesDropped ? { quotesDropped: report.quotesDropped } : {}),
    coverage: {
      ratio: report.coverage.ratio,
      read: report.coverage.read.length,
      ...(report.coverage.reviewed.length ? { reviewed: report.coverage.reviewed.length } : {}),
      unknown: report.coverage.unknown,
      excluded: report.coverage.excluded,
      ...(report.coverage.notReached.length ? { notReached: report.coverage.notReached } : {}),
    },
    rejections: report.rejected.map((r) => ({ id: r.fact.id, code: r.code, message: r.message })),
    // ADR 0124 addendum D-app: a person's corrections, said only when there are some.
    ...(report.corrections.applied.length || report.corrections.stale.length
      ? {
          corrections: {
            applied: report.corrections.applied,
            stale: report.corrections.stale.map((s) => ({
              fact: s.correction.fact,
              why: s.why,
              message: s.message,
            })),
          },
        }
      : {}),
  };
  if (report.carried.length) {
    const by = new Map<string, string[]>();
    for (const c of report.carried) by.set(c.from, [...(by.get(c.from) ?? []), c.id]);
    summary.carried = [...by.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([from, facts]) => ({ from, facts: facts.sort() }));
  }
  if (report.entriesNoFlowFollows.length)
    summary.entriesNoFlowFollows = report.entriesNoFlowFollows;
  if (report.reviewed.length) summary.reviewed = report.reviewed;
  if (report.reviewedDropped.length) summary.reviewedDropped = report.reviewedDropped;
  if (report.methodUnseen.length) {
    summary.methodUnseenCount = report.methodUnseen.length;
    summary.methodUnseen = report.methodUnseen;
  }
  // R1: notes for the reader's second pass, capped with a count.
  if (report.skipped.length) {
    summary.skippedCount = report.skipped.length;
    summary.skipped = report.skipped.slice(0, SKIPPED_LISTED);
  }
  if (report.reviewedHolds.length) summary.reviewedHolds = report.reviewedHolds;
  if (report.specOpsUncovered.length) {
    summary.specOpsUncoveredCount = report.specOpsUncovered.length;
    summary.specOpsUncovered = report.specOpsUncovered.slice(0, SKIPPED_LISTED);
  }
  if (slips.length) summary.slips = [...slips];
  if (report.authUncited.length) summary.authUncited = report.authUncited;
  // A-framework: what the repo is built on, and the frameworks whose patterns nothing shows.
  const fws = frameworkFacts(report.accepted);
  if (fws.length)
    summary.frameworks = fws.map((f) => ({
      name: f.name,
      ...(f.version ? { version: f.version } : {}),
      cite: `${f.cite.file}:${f.cite.line}`,
      ...(f.component ? { component: f.component } : {}),
    }));
  if (report.frameworkGaps.length) summary.frameworkGaps = report.frameworkGaps;
  await writeFile(join(dir, `${repo}.verify.yaml`), stringify(summary), "utf8");
  return summary;
}

/**
 * A person's corrections of a repo's facts (`<repo>.corrections.jsonl`, ADR 0124 addendum D-app),
 * written from the Map. None when there is no file; a line that isn't one is said, not fatal.
 */
export async function readCorrections(
  root: string,
  repo: string,
): Promise<{ corrections: FactCorrection[]; bad: { line: number; message: string }[] }> {
  const text = await readFile(join(factsDirOf(root), `${repo}.corrections.jsonl`), "utf8").catch(
    () => undefined,
  );
  return text === undefined ? { corrections: [], bad: [] } : parseCorrections(text);
}

/**
 * The files the reader read and found no fact in (`<repo>.reviewed.jsonl`, ADR 0124 addendum
 * A-read). None when there is no file; a line that isn't an entry is a problem, not fatal.
 */
export async function readReviewed(
  root: string,
  repo: string,
): Promise<{ entries: ReviewedEntry[]; bad: ReviewedLineProblem[] }> {
  const text = await readFile(join(factsDirOf(root), `${repo}.reviewed.jsonl`), "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return { entries: [], bad: [] };
  const r = parseReviewed(text);
  return {
    entries: r.entries,
    bad: r.bad.map((b) => ({ line: b.line, raw: b.raw, message: b.message })),
  };
}

/** The reviewed lines the verifier refused, as the rejected file and the summary say them. */
export function reviewedProblemsOf(
  bad: readonly ReviewedLineProblem[],
  report: VerifyReport,
): ReviewedLineProblem[] {
  return [
    ...bad,
    ...report.reviewedProblems.map((p) => ({
      ...(p.line !== undefined ? { line: p.line } : {}),
      raw: { path: p.path, why: p.why },
      message: p.message,
    })),
  ].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}
