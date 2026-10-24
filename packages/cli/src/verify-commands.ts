import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { factsDirOf, factsRelOf, parseFactsLines } from "@maycombhq/core";
import { dirSource, verifyFacts } from "@maycombhq/verify";
import type { Output } from "./commands.js";
import {
  checkoutOf,
  excludesOf,
  headOf,
  raiseReadQuestions,
  writeVerifyFiles,
  type QuestionProblem,
} from "./facts-files.js";

/**
 * atticus verify <repo> (ADR 0124): check the facts the assistant wrote for a repo against the
 * repo's code at its commit. Reads `facts/<repo>.jsonl` (`.atticus/facts/` when adopted); writes
 * the kept facts back in canonical form marked verified, the rejected ones with their reasons to
 * `<repo>.rejected.jsonl` for the assistant to fix, and `<repo>.verify.yaml` with the coverage.
 * The questions the assistant wrote to `<repo>.questions.jsonl` are raised for a person (ADR 0078),
 * each evidence line checked; one that can't be raised goes to the rejected file too.
 * Exit code 1 while anything is rejected, so a reading loop knows to go again.
 */
export interface VerifyCommandOptions {
  /** The repo's checkout, when not the base clone or (adopted in place) the root itself. */
  dir?: string;
  /** The commit the facts must be of; default the checkout's HEAD. */
  commit?: string;
  /** Files the reader opened through Atticus's tools. */
  routed?: string[];
  /**
   * Write the kept facts into the catalog, the flows into specs/<repo>/ and render the map
   * (ADR 0124, A3b), only when nothing is rejected.
   */
  write?: boolean;
  json?: boolean;
  now?: () => Date;
}

/** The JSON objects of a questions file; a line that isn't JSON is a problem. */
function questionLines(text: string): { lines: unknown[]; problems: QuestionProblem[] } {
  const lines: unknown[] = [];
  const problems: QuestionProblem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw));
    } catch (e) {
      problems.push({
        line: JSON.stringify(raw),
        message: `not JSON: ${(e as Error).message}`,
      });
    }
  }
  return { lines, problems };
}

export async function verifyCommand(
  root: string,
  repo: string,
  o: VerifyCommandOptions,
  io: Output,
): Promise<number> {
  const rel = factsRelOf(root);
  const file = join(factsDirOf(root), `${repo}.jsonl`);
  if (!existsSync(file)) {
    io.err(
      `No facts for ${repo} at ${rel}/${repo}.jsonl. Run /atticus-map ${repo} in your assistant first (or atticus map ${repo} to read it in batches); it writes that file.`,
    );
    return 2;
  }
  // One bad line costs that fact, not the read: it goes to <repo>.rejected.jsonl with why.
  const parsed = parseFactsLines(await readFile(file, "utf8"));
  if (!parsed.facts.length && parsed.bad.length) {
    io.err(`${rel}/${repo}.jsonl does not read as facts:`);
    for (const b of parsed.bad.slice(0, 20))
      io.err(`  line ${b.line}: ${b.issues.map((i) => i.message).join("; ")}`);
    if (parsed.bad.length > 20) io.err(`  ... and ${parsed.bad.length - 20} more`);
    return 2;
  }
  const dir = await checkoutOf(root, repo, o.dir);
  if (!dir) {
    io.err(
      `No checkout of ${repo}: clone it (atticus workspace sync) or give its folder with --dir.`,
    );
    return 2;
  }
  const commit = o.commit ?? (await headOf(dir));
  const source = dirSource(dir);
  const report = await verifyFacts({
    facts: parsed.facts,
    source,
    ...(commit ? { commit } : {}),
    ...(o.routed ? { routed: o.routed } : {}),
    exclude: await excludesOf(root, repo),
  });

  // ADR 0078: what the code can't settle, raised for a person.
  const qFile = join(factsDirOf(root), `${repo}.questions.jsonl`);
  let raised = 0;
  const qProblems: QuestionProblem[] = [];
  if (existsSync(qFile)) {
    const q = questionLines(await readFile(qFile, "utf8"));
    qProblems.push(...q.problems);
    const r = await raiseReadQuestions(root, repo, q.lines, source, {
      command: `atticus verify ${repo}`,
      at: (o.now?.() ?? new Date()).toISOString(),
    });
    raised = r.raised.length;
    qProblems.push(...r.problems);
  }

  const badLines = parsed.bad.map((b) => ({
    line: b.line,
    raw: b.raw,
    message: `line ${b.line} isn't a fact: ${b.issues.map((i) => i.message).join("; ")}`,
  }));
  const summary = await writeVerifyFiles(root, repo, report, commit, qProblems, badLines);
  const failed = report.rejected.length + qProblems.length + badLines.length > 0;

  // --write (ADR 0124, A3b): the kept facts become the catalog, only when none was rejected,
  // so a half-fixed read never replaces the repo's records.
  const rejectedNote = `Nothing written to the catalog: ${report.rejected.length} facts were rejected. Fix them and run atticus verify ${repo} --write again.`;
  if (o.json) {
    let written;
    if (o.write && !failed) {
      const { writeFactsIntoCatalog } = await import("./map-render-commands.js");
      written = await writeFactsIntoCatalog(
        root,
        repo,
        report.accepted,
        { dir, command: `atticus verify ${repo} --write` },
        { ...io, out: () => undefined },
      );
      if (!written) return 1;
    } else if (o.write) io.err(rejectedNote);
    io.out(
      JSON.stringify(
        { ...summary, questions: { raised, problems: qProblems }, ...(written ? { written } : {}) },
        null,
        2,
      ),
    );
    return failed ? 1 : 0;
  }
  const pct = Math.round(report.coverage.ratio * 100);
  io.out(
    `${repo}: ${report.accepted.length} facts kept, ${report.rejected.length} rejected; coverage ${pct}% (${report.coverage.read.length} read, ${report.coverage.unknown.length} unknown${report.coverage.excluded.length ? `, ${report.coverage.excluded.length} excluded` : ""}).`,
  );
  for (const r of report.rejected.slice(0, 15)) io.out(`  ${r.code}: ${r.message}`);
  if (report.rejected.length > 15) io.out(`  ... and ${report.rejected.length - 15} more`);
  if (raised)
    io.out(
      `${raised} question${raised === 1 ? "" : "s"} raised for a person (atticus questions list): a person answers, never the assistant.`,
    );
  for (const q of qProblems) io.out(`  bad-question: ${q.message}`);
  for (const b of badLines.slice(0, 15)) io.out(`  schema: ${b.message}`);
  if (failed)
    io.out(
      `Fix them from ${rel}/${repo}.rejected.jsonl (read the lines again, then rewrite or drop each fact or question) and run atticus verify ${repo} again.`,
    );
  else if (report.coverage.unknown.length)
    io.out(
      `Next: read the ${report.coverage.unknown.length} unknown files (listed in ${rel}/${repo}.verify.yaml), or exclude generated code in org-pack/scan/${repo}.yaml.`,
    );
  if (report.redacted) io.out(`${report.redacted} quotes had a secret value redacted.`);
  if (failed) {
    if (o.write) io.err(rejectedNote);
    return 1;
  }
  if (!o.write) {
    io.out(
      `When the read is complete: atticus verify ${repo} --write puts the facts in the catalog, the flows in specs/${repo}/, and renders the map.`,
    );
    return 0;
  }
  // Loaded here: the catalog writer brings the scanner, which a check alone never needs.
  const { writeFactsIntoCatalog } = await import("./map-render-commands.js");
  const written = await writeFactsIntoCatalog(
    root,
    repo,
    report.accepted,
    { dir, command: `atticus verify ${repo} --write` },
    io,
  );
  return written ? 0 : 1;
}
