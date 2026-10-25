import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  factsDirOf,
  isAdopted,
  isSecretPath,
  orgPackDirOf,
  QuestionDraft,
  raiseQuestions,
  serializeFacts,
  type Fact,
  type Question,
} from "@maycombhq/core";
import {
  insideRepo,
  type CarryChanges,
  type FileSource,
  type VerifyReport,
} from "@maycombhq/verify";
import { changesSince, createGit, type GitRunner } from "@maycombhq/workspace";
import { repoFor } from "./onboard-commands.js";

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
  coverage: { ratio: number; read: number; unknown: string[]; excluded: string[] };
  rejections: { id: string; code: string; message: string }[];
  /**
   * The facts this run carried from an earlier commit to `commit` (ADR 0124 addendum
   * A-incremental): every file they cite unchanged since, their lines checked again. Their
   * `commit` in the facts file is now `commit`; this is where they were read. Left out when none.
   */
  carried?: { from: string; facts: string[] }[];
  /**
   * A note, not a rejection (ADR 0124 addendum C-estate): the listeners and the rest or gRPC
   * entries no flow starts, for the reader to follow with a flow each. Left out when none.
   */
  entriesNoFlowFollows?: VerifyReport["entriesNoFlowFollows"];
}

/**
 * Write the verifier's results: the kept facts in canonical form, the rejected ones (and any
 * question that couldn't be raised) with their reasons in `<repo>.rejected.jsonl` for the reader
 * to fix, and `<repo>.verify.yaml` with the coverage.
 */
export async function writeVerifyFiles(
  root: string,
  repo: string,
  report: VerifyReport,
  commit: string | undefined,
  questionProblems: readonly QuestionProblem[] = [],
  /** Lines of the facts file that aren't facts: kept here, with why, so nothing is lost. */
  badLines: readonly { line: number; raw: string; message: string }[] = [],
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
  ];
  if (lines.length) await writeFile(rejectedFile, lines.join("\n") + "\n", "utf8");
  else await rm(rejectedFile, { force: true });
  const summary: VerifySummary = {
    repo,
    ...(commit ? { commit } : {}),
    accepted: report.accepted.length,
    rejected: report.rejected.length,
    redacted: report.redacted,
    coverage: {
      ratio: report.coverage.ratio,
      read: report.coverage.read.length,
      unknown: report.coverage.unknown,
      excluded: report.coverage.excluded,
    },
    rejections: report.rejected.map((r) => ({ id: r.fact.id, code: r.code, message: r.message })),
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
  await writeFile(join(dir, `${repo}.verify.yaml`), stringify(summary), "utf8");
  return summary;
}
