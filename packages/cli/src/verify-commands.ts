import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  factsDirOf,
  factsRelOf,
  listQuestions,
  loadOrgPack,
  orgPackDirOf,
  stackHelpersOff,
} from "@maycombhq/core";
import {
  dirSource,
  frameworkFacts,
  frameworksToLearn,
  repairFormSlips,
  verifyFacts,
  type VerifyReport,
} from "@maycombhq/verify";
import type { GitRunner } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import {
  carryOf,
  checkoutOf,
  estateComponentsOf,
  conventionsAt,
  excludesOf,
  headOf,
  raiseReadQuestions,
  readCorrections,
  readReviewed,
  reviewedProblemsOf,
  slipNoteLines,
  writeVerifyFiles,
  type QuestionProblem,
} from "./facts-files.js";
import { NoRoomError, roomGuard, streamFacts } from "./memory-room.js";
import { componentTypeIds, componentTypesAt } from "./component-types.js";
import { notesAt } from "./org-notes.js";
import { loadReadPlan, recordReadProgress } from "./map-parts.js";
import { recordTopUpVerified } from "./map-rules.js";
import { noCheckoutLine } from "./sync-next.js";
import {
  APPLIED_WITH_LEFT_OUT,
  leftOutLines,
  leftOutOf,
  leftOutRefusedLines,
  pairingWaitLines,
  type LeftOutFact,
} from "./verify-left-out.js";

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
  // The org pack's own folder (org-pack/, or .atticus/org-pack/ in an adopted repo): loading the
  // root failed quietly, so every framework file was ignored and each starter offered to learn.
  const op = await loadOrgPack(orgPackDirOf(root)).catch(() => undefined);
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
  /**
   * With --write: write only a whole read (the review of beta.28.1, S6): a rejected fact refuses
   * the write and nothing is built, as before beta.28.1. `atticus map --all` passes it while a
   * read is in progress, so each retry of a part with rejections doesn't build the catalog.
   */
  whole?: boolean;
  /** With --write: list every record changed and flow written, not only the counts. */
  verbose?: boolean;
  /** With --write: `--allow-removals <count>`, `--discard-edits <count>` (ADR 0195 point 4). */
  allowRemovals?: number;
  discardEdits?: number;
  /**
   * The app's confirm (Apply; no flag takes it, so a person's confirmations stay counts): the
   * plan of the refusal the counts confirm, worked out again under the scan's lock; when the
   * build lists anything else, nothing is written (the review of beta.27).
   */
  plan?: string;
  json?: boolean;
  /** R1: print every skipped line, reviewed glob holding some and uncovered spec operation. */
  skipped?: boolean;
  now?: () => Date;
  /** The git runner the diff since the facts' commit is read with (tests mock it). */
  git?: GitRunner;
  /**
   * The heap this read may fill, in bytes (ADR 0124 addendum A-room). The default is the lower of
   * V8's heap limit and the memory the machine has free; tests pass a small one to prove the
   * message. Past it the command stops with words, rather than being killed without any.
   */
  ceilingBytes?: number;
  /**
   * Told the facts a written `--write` left out (exit 3), all of them: the app's Apply counts
   * them from here, never from the lines printed, which show only the first few (the hunt of
   * beta.28.1, S1).
   */
  onLeftOut?: (leftOut: readonly LeftOutFact[]) => void;
}

/**
 * How many of a list verify prints (A-big2): the rest is counted and pointed to, in the verify
 * report or the rejected file, so a long list never fills the terminal or one line.
 */
export const SHOWN = 5;

/** A list said as its first few lines and where the rest are, or (`all`) every line. */
const listed = (lines: readonly string[], more: string, all = false): string[] =>
  all || lines.length <= SHOWN
    ? lines.map((l) => `  ${l}`)
    : [
        ...lines.slice(0, SHOWN).map((l) => `  ${l}`),
        `  ... and ${lines.length - SHOWN} more ${more}`,
      ];

/**
 * R1's notes for the reader's second pass, as `atticus verify` prints them: the lines of the
 * files read that write a path, URL or topic no fact cites, reviewed globs holding some, and spec
 * operations no entry covers. Shared with a canary's own check (second review of ADR 0196), so
 * its read gets the same recall loop the map's does.
 */
export function skippedNoteLines(
  report: Pick<VerifyReport, "skipped" | "reviewedHolds" | "specOpsUncovered">,
  o: { verifyYaml: string; seeAll: string; all: boolean },
): string[] {
  const out: string[] = [];
  const { verifyYaml, seeAll, all } = o;
  const skippedLines = report.skipped;
  if (skippedLines.length)
    out.push(
      `${skippedLines.length} ${skippedLines.length === 1 ? "line of the files read writes" : "lines of the files read write"} a path, URL or topic no fact cites (a note for the reader to check, not a rejection; under skipped in ${verifyYaml}; ${seeAll}):`,
      ...listed(
        skippedLines.map((x) => `${x.cite} ${x.kind} ${x.value}`),
        `(${seeAll})`,
        all,
      ),
    );
  const holds = report.reviewedHolds;
  if (holds.length)
    out.push(
      `${holds.length} reviewed ${holds.length === 1 ? "glob holds" : "globs hold"} lines that write a path, URL or topic (a note; under reviewedHolds in ${verifyYaml}): read them, then write their facts or say why there are none:`,
      ...listed(
        holds.map((h) => h.message),
        `(reviewedHolds in ${verifyYaml})`,
        all,
      ),
    );
  const ops = report.specOpsUncovered;
  if (ops.length)
    out.push(
      `${ops.length} ${ops.length === 1 ? "operation the repo's OpenAPI spec declares has" : "operations the repo's OpenAPI specs declare have"} no entry (a note, not a rejection; under specOpsUncovered in ${verifyYaml}; ${seeAll}):`,
      ...listed(
        ops.map((x) => x.message),
        `(${seeAll})`,
        all,
      ),
    );
  return out;
}

/** C-estate's note, as `atticus verify` prints it: the listeners and routes no flow follows. */
export function unfollowedNoteLines(
  report: Pick<VerifyReport, "entriesNoFlowFollows">,
  verifyYaml: string,
): string[] {
  const unfollowed = report.entriesNoFlowFollows;
  if (!unfollowed.length) return [];
  return [
    `${unfollowed.length} ${unfollowed.length === 1 ? "entry" : "entries"} no flow follows (a note, not a rejection; listed under entriesNoFlowFollows in ${verifyYaml}): write a flow for each that does real work.`,
    ...listed(
      unfollowed.map(
        (e) =>
          `${e.entryType === "rest" && e.method ? e.method : e.entryType} ${e.path} (${e.id}, ${e.cite})`,
      ),
      `(entriesNoFlowFollows in ${verifyYaml})`,
    ),
  ];
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

/** The files beside a repo's facts that are not its facts. */
const FACTS_SIDE_FILES = /\.(questions|reviewed|rejected|corrections)\.jsonl$/;

/** The repos with a facts file here (`<repo>.jsonl`), in id order: those read so far. */
export async function factsRepos(root: string): Promise<string[]> {
  const names = await readdir(factsDirOf(root)).catch(() => [] as string[]);
  return names
    .filter((n) => n.endsWith(".jsonl") && !FACTS_SIDE_FILES.test(n))
    .map((n) => n.slice(0, -".jsonl".length))
    .sort();
}

/**
 * atticus verify --all [--write]: every repo read so far, one after another, as `atticus verify
 * <repo>` would, then a line saying how many passed. No model is called. Exits 1 when any repo
 * has rejected facts, so a script can tell.
 */
export async function verifyAllCommand(
  root: string,
  o: Omit<VerifyCommandOptions, "dir" | "onLeftOut"> & {
    /**
     * Each repo's own outcome as it ends: its exit code and, for a write with rejected facts
     * left out (exit 3), how many (the hunt of beta.28.1, S2: the app's Apply to every repo).
     */
    onRepo?: (repo: string, code: number, leftOut: number) => void;
  },
  io: Output,
): Promise<number> {
  const repos = await factsRepos(root);
  if (!repos.length) {
    io.err(
      `No repo has facts yet (${factsRelOf(root)}/<repo>.jsonl). Read one first: /atticus-map <repo> in your assistant.`,
    );
    return 2;
  }
  const failed: string[] = [];
  const { onRepo, ...each } = o;
  for (const repo of repos) {
    let leftOut = 0;
    const code = await verifyCommand(
      root,
      repo,
      { ...each, onLeftOut: (l) => (leftOut = l.length) },
      io,
    );
    onRepo?.(repo, code, leftOut);
    if (code !== 0) failed.push(repo);
  }
  const passed = repos.length - failed.length;
  io.out(
    `Verified ${repos.length === 1 ? "1 repo" : `${repos.length} repos`}: ${passed} passed${failed.length ? `, ${failed.length} with something to fix (${failed.join(", ")})` : ""}.`,
  );
  return failed.length ? 1 : 0;
}

/**
 * What the verifier is given besides the facts and the source, read from the metarepo: a person's
 * corrections from the Map (ADR 0124 addendum D-app), the files the reader found nothing in
 * (A-read), the estate's components (J1), the org pack's conventions (ADR 0147) and the accepted
 * exclusions. Shared by `atticus verify` and the app's preview of it (ADR 0149), so both check
 * the same way.
 */
export async function verifyInputsOf(root: string, repo: string, dir?: string) {
  return {
    // ADR 0163: the org notes the read was handed, so a term's note is one of them.
    notes: (await notesAt(root, repo, dir)).notes,
    // ADR 0180: a component fact's type is one of the organisation's.
    componentTypes: componentTypeIds(await componentTypesAt(root)),
    corrections: await readCorrections(root, repo),
    reviewed: await readReviewed(root, repo),
    estate: await estateComponentsOf(root),
    conventions: await conventionsAt(root),
    exclude: await excludesOf(root, repo),
    // ADR 0169: the model files the read plan leaves out, counted apart in coverage.
    notReached: (await loadReadPlan(root, repo))?.notReached?.files ?? [],
  };
}

export async function verifyCommand(
  root: string,
  repo: string,
  o: VerifyCommandOptions,
  io: Output,
): Promise<number> {
  const off = stackHelpersOff();
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
  // R6: the reader's slips of form (a camelCase id, a flow with no cite) are fixed, not refused.
  const repaired = repairFormSlips(parsed.facts, parsed.bad);
  parsed = { facts: repaired.facts, bad: repaired.bad, newer: parsed.newer };
  // Beta.25 (ADR 0192 addendum): a fact of a kind a newer Atticus wrote is kept as written, unread.
  if (parsed.newer.length) {
    io.err(
      `${parsed.newer.length} ${parsed.newer.length === 1 ? "fact" : "facts"} of ${rel}/${repo}.jsonl ${parsed.newer.length === 1 ? "is" : "are"} written by a newer Atticus: kept in the file as written, not read here. Install that version (a team upgrades together):`,
    );
    for (const n of parsed.newer.slice(0, SHOWN)) io.err(`  line ${n.line}: ${n.message}`);
  }
  const slips = repaired.slips;
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
    io.err(noCheckoutLine(repo));
    return 2;
  }
  // The hunt of beta.28.1 (F1): a clone with no .git of its own (a copy under workspace/) has no
  // commit to tell; git would answer the metarepo's HEAD, a commit its facts were never read at.
  const ownGit = dir === root || existsSync(join(dir, ".git"));
  if (!o.commit && !ownGit)
    io.err(
      `Atticus can't tell ${repo}'s commit: ${relative(root, dir).replace(/\\/g, "/")} has no .git of its own (a copy, not a clone), so its facts are checked at no commit. Sync the repos to clone it again.`,
    );
  const commit = o.commit ?? (ownGit ? await headOf(dir) : undefined);
  const source = dirSource(dir);
  // ADR 0124 addendum A-incremental: facts read at an earlier commit are carried to this one
  // where every file they cite is unchanged since, and read again where one changed.
  const { carry, missing } = await carryOf(dir, parsed.facts, commit, o.git);
  // ADR 0124 addendum D-app: a person's corrections from the Map, applied on every run.
  const inputs = await verifyInputsOf(root, repo, dir);
  const { corrections, reviewed, estate, conventions } = inputs;
  for (const b of corrections.bad.slice(0, SHOWN))
    io.err(`${rel}/${repo}.corrections.jsonl line ${b.line} isn't a correction: ${b.message}`);
  if (corrections.bad.length > SHOWN)
    io.err(
      `... and ${corrections.bad.length - SHOWN} more lines of ${rel}/${repo}.corrections.jsonl that aren't corrections`,
    );
  let report;
  try {
    report = await verifyFacts({
      facts: parsed.facts,
      source,
      // G4: the stack helpers this run switched off (ATTICUS_HELPERS_OFF).
      ...(off.has("derived-names") ? { derivedNames: false } : {}),
      ...(off.has("readers") ? { readers: false } : {}),
      ...(commit ? { commit, carry } : {}),
      ...(o.routed ? { routed: o.routed } : {}),
      exclude: inputs.exclude,
      corrections: corrections.corrections,
      reviewed: reviewed.entries,
      room,
      // J1 (ADR 0143): an exposure read here names a component the manifest lists.
      ...(estate ? { estate } : {}),
      conventions,
      notes: inputs.notes,
      componentTypes: inputs.componentTypes,
      notReached: inputs.notReached,
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
  const failed =
    report.rejected.length + qProblems.length + badLines.length + reviewedBad.length > 0;
  // Beta.26: a --write that refuses writes nothing but what to fix and the report: the facts
  // file stays as it was, so the kept facts aren't stamped verified without the rest (a scan
  // would take the half-read repo from them). Without --write the check keeps its inner loop
  // (ADR 0124 A3b): the kept facts in canonical form, the rejected ones in <repo>.rejected.jsonl.
  const keepFacts = o.write === true && failed;
  // Beta.28.1 (field report 5): a rejected fact no longer blocks --write. The kept facts (a
  // person's corrections and pairings with them) are written, each rejected fact left out, its
  // last accepted copy kept in its place (verify-left-out.ts). Lines that aren't facts still
  // refuse the write: nothing says what they backed. The review of beta.28.1 (S4): so do
  // questions or reviewed lines refused with no fact rejected, as before; with facts left out,
  // they are said beside them.
  // The hunt of beta.28.1 (F1): never a partial write under a commit its facts weren't read at:
  // a fact rejected as read at another commit, or every fact rejected, refuses it as before.
  const otherCommit = report.rejected.filter((r) => r.code === "wrong-commit").length;
  const noneKept = report.accepted.length === 0;
  const leftOut =
    keepFacts &&
    !o.whole &&
    badLines.length === 0 &&
    report.rejected.length > 0 &&
    !otherCommit &&
    !noneKept
      ? await leftOutOf(root, repo, report)
      : undefined;
  const partial = leftOut?.ok ? leftOut : undefined;
  // Verify's own verdict ("The read is complete: every source file is read or reviewed"),
  // kept in the facts slot's meta as `readComplete` (ADR 0195 addendum "a legacy join its
  // caller's facts place elsewhere"): only a complete read retires an adopted arrow that cites
  // no caller line.
  const complete = !failed && report.coverage.unknown.length === 0;
  const summary = await writeVerifyFiles(
    root,
    repo,
    report,
    commit,
    qProblems,
    badLines,
    reviewedBad,
    slips,
    parsed.newer.flatMap((n) => (n.raw !== undefined ? [n.raw] : [])),
    { keepFacts },
  );
  // ADR 0141: the parts (or the one-session read) the facts now account for are stamped in the
  // read plan, so what a read took is on file; a stamp is never moved.
  await recordReadProgress(root, repo, {
    commit,
    kept: report.accepted.length,
    // ADR 0170: a part is read when this coverage leaves nothing under it unaccounted.
    unknown: report.coverage.unknown,
    ...(o.now
      ? {
          now: o
            .now()
            .toISOString()
            .replace(/\.\d{3}Z$/, "Z"),
        }
      : {}),
  });
  // ADR 0167: a top-up session given before this verify is done when it passes; after the last,
  // the read records the reading rules there are now.
  if (!failed) await recordTopUpVerified(root, repo, { commit });

  // --write (ADR 0124, A3b): the kept facts become the catalog, only when none was rejected,
  // so a half-fixed read never replaces the repo's records.
  const n = report.rejected.length;
  const whyWhole = otherCommit
    ? ` (${otherCommit === 1 ? "1 fact was" : `${otherCommit} facts were`} read at another commit than ${commit ? commit.slice(0, 12) : "this clone's"}: read ${repo} again at this commit with atticus map ${repo}, then Apply)`
    : n && noneKept
      ? " (every fact of the read was rejected, so nothing of it would be written)"
      : "";
  const rejectedNote = `${leftOut && !leftOut.ok ? `${leftOut.problem}. ` : ""}Nothing written: ${n ? `${n} ${n === 1 ? "fact was" : "facts were"} rejected${whyWhole}` : "some lines of the read were refused"}, so ${rel}/${repo}.jsonl and the catalog are left as they were. Fix them from ${rel}/${repo}.rejected.jsonl and run atticus verify ${repo} --write again.`;
  // N2: a partial write refused (guards, the lock) says the facts it would have left out.
  const refusedLeftOut = () =>
    partial
      ? leftOutRefusedLines(
          repo,
          partial.leftOut,
          { facts: `${rel}/${repo}.jsonl`, rejected: `${rel}/${repo}.rejected.jsonl` },
          SHOWN,
        )
      : [];
  if (o.json) {
    let written;
    let refusedBuild: unknown;
    if (o.write && (!failed || partial)) {
      const { writeFactsIntoCatalog } = await import("./map-render-commands.js");
      written = await writeFactsIntoCatalog(
        root,
        repo,
        partial?.facts ?? report.accepted,
        {
          dir,
          command: `atticus verify ${repo} --write`,
          ...(commit ? { commit } : {}),
          ...(complete ? { readComplete: true } : {}),
          ...(o.allowRemovals !== undefined ? { allowRemovals: o.allowRemovals } : {}),
          ...(o.discardEdits !== undefined ? { discardEdits: o.discardEdits } : {}),
          ...(o.plan !== undefined ? { plan: o.plan } : {}),
          onRefused: (r) => (refusedBuild = r.guard.refused),
        },
        { ...io, out: () => undefined },
      );
      if (!written) for (const l of refusedLeftOut()) io.err(l);
      if (!written && !refusedBuild) return 1;
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
          ...(written && partial ? { leftOut: partial.leftOut } : {}),
          ...(refusedBuild ? { refused: refusedBuild } : {}),
        },
        null,
        2,
      ),
    );
    if (refusedBuild) return 1;
    if (written && partial) {
      o.onLeftOut?.(partial.leftOut);
      return APPLIED_WITH_LEFT_OUT;
    }
    return failed ? 1 : 0;
  }
  const pct = Math.round(report.coverage.ratio * 100);
  const cov = report.coverage;
  io.out(
    `${repo}: ${report.accepted.length} facts kept, ${report.rejected.length} rejected; coverage ${pct}% (${cov.read.length} read, ${cov.reviewed.length ? `${cov.reviewed.length} reviewed with nothing to record, ` : ""}${cov.unknown.length} unknown${cov.excluded.length ? `, ${cov.excluded.length} excluded` : ""}${cov.notReached.length ? `, ${cov.notReached.length} model files no entry or call reaches` : ""}).`,
  );
  // ADR 0169: the model files left out, said, never silent, with the command that reads them.
  if (cov.notReached.length) {
    // ADR 0170: under --models entries, those only an outbound client reaches are said apart.
    const client = new Set((await loadReadPlan(root, repo))?.notReached?.clientOnly?.files ?? []);
    const byClient = cov.notReached.filter((p) => client.has(p)).length;
    const rest = cov.notReached.length - byClient;
    if (byClient)
      io.out(
        `${byClient} model files only an outbound client reaches; atticus map ${repo} --models reachable reads them.`,
      );
    if (rest)
      io.out(
        `${rest} model files no entry or call reaches; atticus map ${repo} --models all reads them.`,
      );
  }
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
  if (failed) {
    // beta.27: a Copilot session took the move for its edit undone, and wrote the same facts again.
    // A fact of another commit stays in the facts file (round 40), so it isn't said moved.
    if (!keepFacts && report.rejected.some((r) => r.code !== "wrong-commit"))
      io.out(
        `The rejected facts were moved out of ${rel}/${repo}.jsonl into ${rel}/${repo}.rejected.jsonl, each with why: nothing was undone, and the facts kept stay as they are.`,
      );
    // Beta.28.1: a --write that goes ahead with facts left out says how to fix them once it wrote.
    if (!partial)
      io.out(
        `Fix them from ${rel}/${repo}.rejected.jsonl (read the lines again, then rewrite or drop each fact, question or reviewed line) and run atticus verify ${repo} again.`,
      );
  } else if (cov.unknown.length)
    io.out(
      `Next: read the ${cov.unknown.length} unknown files (listed in ${rel}/${repo}.verify.yaml). A file you read and found nothing to record in goes in ${rel}/${repo}.reviewed.jsonl ({"path": "<file or glob>", "why": "..."} per line); generated code is excluded in org-pack/scan/${repo}.yaml.`,
    );
  else
    io.out(
      `The read is complete: every source file is read (${cov.read.length})${cov.reviewed.length ? ` or reviewed with nothing to record (${cov.reviewed.length}, each with why in ${rel}/${repo}.verify.yaml)` : ""}.`,
    );
  // R6: notes, never rejections. A slip of form fixed in the facts, and a reviewed glob that
  // matches nothing (it stands for no file, so it excuses none).
  for (const l of slipNoteLines(slips, verifyYaml, SHOWN)) io.out(l);
  const dropped = report.reviewedDropped;
  if (dropped.length) {
    io.out(
      `${dropped.length} reviewed ${dropped.length === 1 ? "glob matches" : "globs match"} no file and ${dropped.length === 1 ? "was" : "were"} dropped (a note, not a refusal; under reviewedDropped in ${verifyYaml}):`,
    );
    show(
      dropped.map((d) => d.message),
      `(reviewedDropped in ${verifyYaml})`,
    );
  }
  // P2: a warning, counted, never a rejection (yet).
  const unseen = report.methodUnseen;
  if (unseen.length) {
    io.out(
      `${unseen.length} ${unseen.length === 1 ? "entry or call claims" : "entries or calls claim"} an HTTP method ${unseen.length === 1 ? "its" : "their"} lines don't write (a warning, not a rejection; under methodUnseen in ${verifyYaml}):`,
    );
    show(
      unseen.map((m) => m.message),
      `(methodUnseen in ${verifyYaml})`,
    );
  }
  // R1: the lines the reader skipped, notes for its second pass; never a rejection, and nothing
  // kept or dropped because of them. --skipped prints every one.
  for (const l of skippedNoteLines(report, {
    verifyYaml,
    seeAll: `atticus verify ${repo} --skipped prints every one`,
    all: o.skipped === true,
  }))
    io.out(l);
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
  for (const l of unfollowedNoteLines(report, verifyYaml)) io.out(l);
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
  // ADR 0192: what the build files read write that no artifact or dependency fact records.
  const unrecorded = report.buildUnrecorded ?? [];
  if (unrecorded.length) {
    io.out(
      `${unrecorded.length} ${unrecorded.length === 1 ? "coordinate or dependency" : "coordinates and dependencies"} a build file read writes ${unrecorded.length === 1 ? "has" : "have"} no fact (a note, not a rejection; under buildUnrecorded in ${verifyYaml}): record each as an artifact or dependency fact, so a library of the estate's own is drawn as what its services build on:`,
    );
    show(
      unrecorded.map((u) => `${u.kind} ${u.coordinates} (${u.cite})`),
      `(buildUnrecorded in ${verifyYaml})`,
    );
  }
  // Review of beta.25: a fact naming a folder's component in a repo that ships as one.
  const placed = report.componentsPlaced ?? [];
  if (placed.length) {
    io.out(
      `${placed.length} ${placed.length === 1 ? "fact names a component" : "facts name components"} the manifest doesn't list, in a repo whose manifest lists no modules (a note, not a rejection; under componentsPlaced in ${verifyYaml}): each is placed in the repo's component. List the modules in repos.manifest.yaml if they ship apart:`,
    );
    show(
      placed.map((p) => `${p.id}: ${p.named} is ${p.component} (${p.cite})`),
      `(componentsPlaced in ${verifyYaml})`,
    );
  }
  // G4: with the framework models off, nothing is offered to learn.
  const learn = off.has("framework-models")
    ? []
    : frameworksToLearn(
        report.accepted,
        await frameworksKnownTo(root),
        (await conventionsAt(root)).frameworks,
      );
  if (learn.length) {
    io.out(
      `${learn.length} ${learn.length === 1 ? "framework" : "frameworks"} of the house nothing here can read yet: teach ${learn.length === 1 ? "it" : "them"} once, rather than having each repo's annotations read as ordinary code.`,
    );
    show(
      learn.map((l) => `${l.why} Learn it: ${l.command}`),
      "",
    );
  }
  if (failed && !partial) {
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
    partial?.facts ?? report.accepted,
    {
      dir,
      command: `atticus verify ${repo} --write`,
      verbose: o.verbose === true,
      ...(commit ? { commit } : {}),
      ...(complete ? { readComplete: true } : {}),
      ...(o.allowRemovals !== undefined ? { allowRemovals: o.allowRemovals } : {}),
      ...(o.discardEdits !== undefined ? { discardEdits: o.discardEdits } : {}),
      ...(o.plan !== undefined ? { plan: o.plan } : {}),
    },
    io,
  );
  if (written && partial) {
    for (const l of leftOutLines(
      repo,
      partial.leftOut,
      { facts: `${rel}/${repo}.jsonl`, rejected: rejectedFile },
      SHOWN,
      qProblems.length + reviewedBad.length,
    ))
      io.out(l);
    // F5: a person's pairing of a call left out waits on the fact to put back, said.
    for (const l of pairingWaitLines(
      partial.leftOut,
      report.rejected,
      new Set(corrections.corrections.filter((c) => c.action === "link").map((c) => c.fact)),
      `${rel}/${repo}.jsonl`,
    ))
      io.out(l);
    o.onLeftOut?.(partial.leftOut);
    return APPLIED_WITH_LEFT_OUT;
  }
  if (!written) for (const l of refusedLeftOut()) io.err(l);
  return written ? 0 : 1;
}
