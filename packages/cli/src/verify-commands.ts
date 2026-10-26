import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { factsDirOf, factsRelOf, listQuestions, loadOrgPack } from "@maycombhq/core";
import { dirSource, frameworkFacts, frameworksToLearn, verifyFacts } from "@maycombhq/verify";
import type { GitRunner } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import {
  carryOf,
  checkoutOf,
  excludesOf,
  headOf,
  raiseReadQuestions,
  readCorrections,
  readReviewed,
  reviewedProblemsOf,
  writeVerifyFiles,
  type QuestionProblem,
} from "./facts-files.js";
import { NoRoomError, roomGuard, streamFacts } from "./memory-room.js";

/**
 * atticus verify <repo> (ADR 0124): check the facts the assistant wrote for a repo against the
 * repo's code at its commit. Reads `facts/<repo>.jsonl` (`.atticus/facts/` when adopted); writes
 * the kept facts back in canonical form marked verified, the rejected ones with their reasons to
 * `<repo>.rejected.jsonl` for the assistant to fix, and `<repo>.verify.yaml` with the coverage.
 * The questions the assistant wrote to `<repo>.questions.jsonl` are raised for a person (ADR 0078),
 * each evidence line checked; one that can't be raised goes to the rejected file too.
 * The files the assistant read and found no fact in, `<repo>.reviewed.jsonl` (ADR 0124 addendum
 * A-read), are counted apart from read and listed with why; a line naming no file is rejected too.
 * Exit code 1 while anything is rejected, so a reading loop knows to go again.
 */
/**
 * What the org pack's framework files already teach Atticus (ADR 0054): each file's name and the
 * artifacts it ships as, so a house starter already on file isn't offered to be learned again.
 * None when there is no org pack here.
 */
async function frameworksKnownTo(root: string): Promise<string[]> {
  const op = await loadOrgPack(root).catch(() => undefined);
  return (op?.frameworks ?? []).flatMap((f) => [f.name, ...f.artifacts]);
}

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
  /** With --write: list every record changed and flow written, not only the counts. */
  verbose?: boolean;
  json?: boolean;
  now?: () => Date;
  /** The git runner the diff since the facts' commit is read with (tests mock it). */
  git?: GitRunner;
  /**
   * The heap this read may fill, in bytes (ADR 0124 addendum A-room). The default is the lower of
   * V8's heap limit and the memory the machine has free; tests pass a small one to prove the
   * message. Past it the command stops with words, rather than being killed without any.
   */
  ceilingBytes?: number;
}

/**
 * How many of a list verify prints (A-big2): the rest is counted and pointed to, in the verify
 * report or the rejected file, so a long list never fills the terminal or one line.
 */
export const SHOWN = 5;

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
  // A-room: the facts file is read a line at a time, and the read stops itself with a message
  // once the heap is past its ceiling. The same guard is passed to the verifier below, so a big
  // repo's read ends in words a person can act on rather than the kernel's silent kill.
  const room = roomGuard({
    what: `${repo}'s facts`,
    ...(o.ceilingBytes !== undefined ? { ceilingBytes: o.ceilingBytes } : {}),
  });
  // One bad line costs that fact, not the read: it goes to <repo>.rejected.jsonl with why.
  let parsed;
  try {
    parsed = await streamFacts(file, room);
  } catch (e) {
    if (!(e instanceof NoRoomError)) throw e;
    io.err(`atticus verify ${repo}: ${e.message}`);
    return 2;
  }
  if (!parsed.facts.length && parsed.bad.length) {
    io.err(`${rel}/${repo}.jsonl does not read as facts:`);
    for (const b of parsed.bad.slice(0, 20))
      io.err(`  line ${b.line}: ${b.issues.map((i) => i.message).join("; ")}`);
    if (parsed.bad.length > 20)
      io.err(`  ... and ${parsed.bad.length - 20} more (no line of the file is a fact)`);
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
  // ADR 0124 addendum A-incremental: facts read at an earlier commit are carried to this one
  // where every file they cite is unchanged since, and read again where one changed.
  const { carry, missing } = await carryOf(dir, parsed.facts, commit, o.git);
  // ADR 0124 addendum D-app: a person's corrections from the Map, applied on every run.
  const corrections = await readCorrections(root, repo);
  for (const b of corrections.bad.slice(0, SHOWN))
    io.err(`${rel}/${repo}.corrections.jsonl line ${b.line} isn't a correction: ${b.message}`);
  if (corrections.bad.length > SHOWN)
    io.err(
      `... and ${corrections.bad.length - SHOWN} more lines of ${rel}/${repo}.corrections.jsonl that aren't corrections`,
    );
  // ADR 0124 addendum A-read: the files the reader read and found nothing to record in.
  const reviewed = await readReviewed(root, repo);
  let report;
  try {
    report = await verifyFacts({
      facts: parsed.facts,
      source,
      ...(commit ? { commit, carry } : {}),
      ...(o.routed ? { routed: o.routed } : {}),
      exclude: await excludesOf(root, repo),
      corrections: corrections.corrections,
      reviewed: reviewed.entries,
      room,
    });
  } catch (e) {
    if (!(e instanceof NoRoomError)) throw e;
    io.err(`atticus verify ${repo}: ${e.message}`);
    return 2;
  }
  const reviewedBad = reviewedProblemsOf(reviewed.bad, report).map((p) => ({
    ...p,
    message: `${rel}/${repo}.reviewed.jsonl ${p.message}`,
  }));

  // ADR 0078: what the code can't settle, raised for a person.
  // A-big2: every line is raised (none is held back or capped), and the count is said.
  const qFile = join(factsDirOf(root), `${repo}.questions.jsonl`);
  let raised = 0;
  let known = 0;
  let qLines = 0;
  const qProblems: QuestionProblem[] = [];
  const hasQuestions = existsSync(qFile);
  if (hasQuestions) {
    const q = questionLines(await readFile(qFile, "utf8"));
    qLines = q.lines.length + q.problems.length;
    qProblems.push(...q.problems);
    const r = await raiseReadQuestions(root, repo, q.lines, source, {
      command: `atticus verify ${repo}`,
      at: (o.now?.() ?? new Date()).toISOString(),
    });
    raised = r.raised.length;
    known = r.known.length;
    qProblems.push(...r.problems);
  }
  const open = hasQuestions ? (await listQuestions(root, { repo, state: "open" })).questions : [];

  const badLines = parsed.bad.map((b) => ({
    line: b.line,
    raw: b.raw,
    message: `line ${b.line} isn't a fact: ${b.issues.map((i) => i.message).join("; ")}`,
  }));
  const summary = await writeVerifyFiles(
    root,
    repo,
    report,
    commit,
    qProblems,
    badLines,
    reviewedBad,
  );
  const failed =
    report.rejected.length + qProblems.length + badLines.length + reviewedBad.length > 0;

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
        {
          ...summary,
          questions: {
            lines: qLines,
            raised,
            known,
            refused: qProblems.length,
            open: open.length,
            problems: qProblems,
          },
          ...(reviewedBad.length ? { reviewedProblems: reviewedBad } : {}),
          ...(written ? { written } : {}),
        },
        null,
        2,
      ),
    );
    return failed ? 1 : 0;
  }
  const pct = Math.round(report.coverage.ratio * 100);
  const cov = report.coverage;
  io.out(
    `${repo}: ${report.accepted.length} facts kept, ${report.rejected.length} rejected; coverage ${pct}% (${cov.read.length} read, ${cov.reviewed.length ? `${cov.reviewed.length} reviewed with nothing to record, ` : ""}${cov.unknown.length} unknown${cov.excluded.length ? `, ${cov.excluded.length} excluded` : ""}).`,
  );
  // A-big2: every list is said as a count, its first few, and where the whole list is.
  const verifyYaml = `${rel}/${repo}.verify.yaml`;
  const rejectedFile = `${rel}/${repo}.rejected.jsonl`;
  const show = (lines: readonly string[], more: string) => {
    for (const l of lines.slice(0, SHOWN)) io.out(`  ${l}`);
    if (lines.length > SHOWN) io.out(`  ... and ${lines.length - SHOWN} more ${more}`);
  };
  if (report.carried.length) {
    const from = [...new Set(report.carried.map((c) => c.from.slice(0, 12)))];
    io.out(
      `${report.carried.length} of them carried to ${commit!.slice(0, 12)} from ${from.slice(0, SHOWN).join(", ")}${from.length > SHOWN ? ` and ${from.length - SHOWN} more commits` : ""}: every file they cite is unchanged since, and their lines were checked again (listed under carried in ${verifyYaml}).`,
    );
  }
  const changed = report.rejected.filter((r) => r.code === "cite-changed").length;
  if (changed)
    io.out(
      `${changed} cite a file that changed since they were read: read those files again (atticus map ${repo} --estimate lists them), then rewrite or drop each fact.`,
    );
  if (missing.length) {
    io.out(
      `Facts of ${missing.length === 1 ? "a commit" : `${missing.length} commits`} this clone doesn't have can't be compared with ${commit!.slice(0, 12)}: they are rejected as wrong-commit; read them again.`,
    );
    show(
      missing.map((c) => c.slice(0, 12)),
      "commits",
    );
  }
  const fixed = report.corrections.applied;
  if (fixed.length) {
    io.out(
      `${fixed.length} ${fixed.length === 1 ? "correction" : "corrections"} by a person applied (${rel}/${repo}.corrections.jsonl; listed under corrections in ${verifyYaml}):`,
    );
    show(
      fixed.map((a) => `${a.fact} ${a.action === "wrong" ? "left out as wrong" : "as corrected"}`),
      `(corrections in ${verifyYaml})`,
    );
  }
  const stale = report.corrections.stale;
  if (stale.length)
    show(
      stale.map((s) => `correction: ${s.message}`),
      `corrections meeting no fact (corrections.stale in ${verifyYaml})`,
    );
  show(
    report.rejected.map((r) => `${r.code}: ${r.message}`),
    `rejected (all in ${rejectedFile})`,
  );
  if (hasQuestions) {
    io.out(
      `${raised} question${raised === 1 ? "" : "s"} raised for a person now${known ? `, ${known} raised before` : ""}${qProblems.length ? `, ${qProblems.length} refused` : ""} (of ${qLines} line${qLines === 1 ? "" : "s"} in ${rel}/${repo}.questions.jsonl).`,
    );
    if (open.length) {
      io.out(
        `${open.length} question${open.length === 1 ? "" : "s"} open for ${repo}, waiting for a person's answer (atticus questions list --state open lists them all; a person answers, never the assistant):`,
      );
      show(
        open.map((q) => `${q.id}: ${q.question}`),
        "open",
      );
    }
  }
  show(
    qProblems.map((q) => `bad-question: ${q.message}`),
    `refused questions (all in ${rejectedFile})`,
  );
  show(
    badLines.map((b) => `schema: ${b.message}`),
    `lines that aren't facts (all in ${rejectedFile})`,
  );
  show(
    reviewedBad.map((b) => `bad-reviewed: ${b.message}`),
    `refused reviewed lines (all in ${rejectedFile})`,
  );
  if (failed)
    io.out(
      `Fix them from ${rel}/${repo}.rejected.jsonl (read the lines again, then rewrite or drop each fact, question or reviewed line) and run atticus verify ${repo} again.`,
    );
  else if (cov.unknown.length)
    io.out(
      `Next: read the ${cov.unknown.length} unknown files (listed in ${rel}/${repo}.verify.yaml). A file you read and found nothing to record in goes in ${rel}/${repo}.reviewed.jsonl ({"path": "<file or glob>", "why": "..."} per line); generated code is excluded in org-pack/scan/${repo}.yaml.`,
    );
  else
    io.out(
      `The read is complete: every source file is read (${cov.read.length})${cov.reviewed.length ? ` or reviewed with nothing to record (${cov.reviewed.length}, each with why in ${rel}/${repo}.verify.yaml)` : ""}.`,
    );
  if (report.redacted) io.out(`${report.redacted} quotes had a secret value redacted.`);
  // A-uncited: the quote a file of that kind can't bear is left off the kept fact, and counted.
  if (report.quotesDropped)
    io.out(
      `${report.quotesDropped} ${report.quotesDropped === 1 ? "quote was" : "quotes were"} left off (the cited line is minified, a notebook, binary or over 1,000 characters, and the quote doesn't match it); the claim itself was still checked on the line.`,
    );
  // A-uncited: an auth no line is cited for stays in the facts file and out of the catalog (a
  // note, not a rejection). The count is the same on every run, --write included, until a line
  // is cited, so re-verifying never says an estate's auth is recorded when it isn't.
  const noAuth = report.authUncited;
  if (noAuth.length) {
    io.out(
      `${noAuth.length} ${noAuth.length === 1 ? "entry's" : "entries'"} auth rests on no cited line (all under authUncited in ${verifyYaml}). ${noAuth.length === 1 ? "It is" : "They are"} kept in ${rel}/${repo}.jsonl, as the reader wrote ${noAuth.length === 1 ? "it" : "them"}, and left out of the catalog, so the map never says an auth nothing shows. To record ${noAuth.length === 1 ? "it" : "them"}: give each entry an authCite — the file and line that sets the auth and what it writes there — and run atticus verify ${repo} again:`,
    );
    show(
      noAuth.map((a) => `${a.id} (${a.auth}, ${a.cite})`),
      `(authUncited in ${verifyYaml})`,
    );
  }
  // C-estate: a note, not a rejection, so the reader follows each listener and route with a flow.
  const unfollowed = report.entriesNoFlowFollows;
  if (unfollowed.length) {
    io.out(
      `${unfollowed.length} ${unfollowed.length === 1 ? "entry" : "entries"} no flow follows (a note, not a rejection; listed under entriesNoFlowFollows in ${verifyYaml}): write a flow for each that does real work.`,
    );
    show(
      unfollowed.map(
        (e) =>
          `${e.entryType === "rest" && e.method ? e.method : e.entryType} ${e.path} (${e.id}, ${e.cite})`,
      ),
      `(entriesNoFlowFollows in ${verifyYaml})`,
    );
  }
  // A-framework: what the repo is built on, a framework whose patterns nothing shows, and a
  // framework of the house nothing here can read. Notes and questions, never rejections.
  const fws = frameworkFacts(report.accepted);
  if (fws.length)
    io.out(
      `Built on ${fws.map((f) => `${f.name}${f.version ? ` ${f.version}` : ""}`).join(", ")} (frameworks in ${verifyYaml}).`,
    );
  const gaps = report.frameworkGaps;
  if (gaps.length) {
    io.out(
      `${gaps.length} ${gaps.length === 1 ? "framework" : "frameworks"} this repo declares ${gaps.length === 1 ? "shows" : "show"} none of its patterns in the facts (a question for a person, not a rejection; under frameworkGaps in ${verifyYaml}):`,
    );
    show(
      gaps.map((g) => g.question),
      `(frameworkGaps in ${verifyYaml})`,
    );
  }
  const learn = frameworksToLearn(report.accepted, await frameworksKnownTo(root));
  if (learn.length) {
    io.out(
      `${learn.length} ${learn.length === 1 ? "framework" : "frameworks"} of the house nothing here can read yet: teach ${learn.length === 1 ? "it" : "them"} once, rather than having each repo's annotations read as ordinary code.`,
    );
    show(
      learn.map((l) => `${l.why} Learn it: ${l.command}`),
      "",
    );
  }
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
    { dir, command: `atticus verify ${repo} --write`, verbose: o.verbose === true },
    io,
  );
  return written ? 0 : 1;
}
