import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  factsDirOf,
  isAdopted,
  isSecretPath,
  orgPackDirOf,
  parseCorrections,
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
): Promise<VerifySummary> {
  const dir = factsDirOf(root);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${repo}.jsonl`), serializeFacts(report.accepted), "utf8");
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
