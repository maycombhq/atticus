import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  CancelledError,
  isFileSystemError,
  catalogDirOf,
  currentSignal,
  factsDirOf,
  factsRelOf,
  listQuestions,
  loadOrgPack,
  newerThan,
  type Fact,
  orgPackDirOf,
  releaseCurrent,
  stackHelpersOff,
} from "@maycombhq/core";
import { VERSION } from "./version.js";
import {
  dirSource,
  frameworkFacts,
  frameworksToLearn,
  repairFormSlips,
  verifyFacts,
  type VerifyReport,
  isDeployFile,
} from "@maycombhq/verify";
import type { BuildRefusal } from "@maycombhq/scanner";
import type { GitRunner } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import type { PairResult } from "./apply-pair.js";
import { refusalEnds } from "./standing.js";
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
import { durationWords } from "./write-progress.js";
import {
  APPLIED_WITH_LEFT_OUT,
  leftOutLines,
  leftOutOf,
  leftOutRefusedLines,
  pairingWaitLines,
  type LeftOutFact,
} from "./verify-left-out.js";

/** The note for a repo with no deploy fact while deploy or pipeline files aren't read. */
export function noDeployNote(
  repo: string,
  facts: readonly { kind: string }[],
  unknown: readonly string[],
): string | undefined {
  if (facts.some((f) => f.kind === "deploy")) return undefined;
  const files = unknown.filter(isDeployFile).sort();
  if (!files.length) return undefined;
  const shown = files.slice(0, 3).join(", ");
  const more = files.length > 3 ? ` and ${files.length - 3} more` : "";
  const n =
    files.length === 1
      ? "1 deploy or pipeline file isn't"
      : `${files.length} deploy or pipeline files aren't`;
  const them = files.length === 1 ? "it" : "them";
  const holds = files.length === 1 ? "it holds" : "they hold";
  return `${repo} has no deploy fact, and ${n} read: ${shown}${more}. A change that moves or ships ${repo} has nothing to stand on until then: read ${them}, or say in the reviewed file why ${holds} no deploy.`;
}
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
  /** beta.32: `verify --all` checked once that no `atticus upgrade` is owed (upgradeBeforeWrite). */
  upgradeChecked?: boolean;
  /** ADR 0210 part 3: `verify --all` ran the upgrade owed first (said in --json as `upgraded`). */
  upgradedFirst?: boolean;
  /** ADR 0205 step 2 (the app's Apply): the write's caches written after its result. */
  cachesAfterResult?: boolean;
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
  /**
   * Told the build's refusal when --write's build refused (a large removal, a hand edit): the
   * repos run of ADR 0204 decision 4 says that repo waits for a confirm, with its listing.
   */
  onBuildRefused?: (refused: BuildRefusal) => void;
  /**
   * v31 (one build for many repos): the catalog write, in place of `writeFactsIntoCatalog`;
   * `verify --all --write` holds each repo's write here until every repo is verified. No flag.
   */
  writeFacts?: typeof import("./map-render-commands.js").writeFactsIntoCatalog;
  /** ADR 0210 part 4: false leaves the pairing after the write to the caller (verify --all). */
  pair?: boolean;
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
export const FACTS_SIDE_FILES = /\.(questions|reviewed|rejected|corrections)\.jsonl$/;

/** The repos with a facts file here (`<repo>.jsonl`), in id order: those read so far. */
export async function factsRepos(root: string): Promise<string[]> {
  const names = await readdir(factsDirOf(root)).catch(() => [] as string[]);
  return names
    .filter((n) => n.endsWith(".jsonl") && !FACTS_SIDE_FILES.test(n))
    .map((n) => n.slice(0, -".jsonl".length))
    .sort();
}

/**
 * Beta.28.4: the time a run has left, for a person to plan by: never to the second. Under an
 * hour to the minute, past it to five minutes.
 */
export function timeLeftWords(ms: number): string {
  if (ms < 45_000) return "under a minute";
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `about ${min} min`;
  const five = Math.round(min / 5) * 5;
  const h = Math.floor(five / 60);
  return five % 60 ? `about ${h} h ${five % 60} min` : `about ${h} h`;
}

/**
 * v31: whether `verify --all` over `repos` repos writes them with one build (two repos or more,
 * with --write, unless ATTICUS_APPLY_ONE_BUILD=0). The app asks it too, for how Stop is said.
 */
export function oneBuildFor(write: boolean, repos: number): boolean {
  return write && repos > 1 && process.env.ATTICUS_APPLY_ONE_BUILD !== "0";
}

/**
 * atticus verify --all [--write]: every repo read so far, one after another, as `atticus verify
 * <repo>` would, then a line saying how many passed. No model is called. Exits 1 when any repo
 * has rejected facts, so a script can tell.
 *
 * Beta.28.4: over two repos or more, each repo's start is said with its place ("Repo 3 of 7:
 * forge-ledger…") and, once one has finished, how long the repos done took and about how long
 * the rest take at that rate. Progress lines: a terminal's standard error, the app job's
 * Console; never standard output, which a script reads.
 *
 * Stop (the app's job, beta.28.4): a repo's write is never cut short. Asked during one, the run
 * ends once that write has ended whole, before the next repo; asked while a repo is still read
 * or built, it ends there with nothing of that repo in the catalog. Either way it says how many
 * repos it went through and which are not applied, and exits 1.
 */
export async function verifyAllCommand(
  root: string,
  o: Omit<VerifyCommandOptions, "dir" | "onLeftOut"> & {
    /**
     * Each repo's own outcome as it ends: its exit code and, for a write with rejected facts
     * left out (exit 3), how many (the hunt of beta.28.1, S2: the app's Apply to every repo).
     */
    onRepo?: (repo: string, code: number, leftOut: number) => void;
    /**
     * Beta.28.4: only these repos, in id order whatever order they come in (the app's Apply to
     * the repos whose corrections wait). Each has facts on file, or nothing is verified. No flag
     * passes it: `atticus verify --all` stays every repo read so far.
     */
    only?: readonly string[];
    /**
     * Beta.28.4: told as each repo starts, after its "Repo N of M" line: how many repos are
     * done (finished, whatever their outcome) and how many there are.
     */
    onStart?: (repo: string, done: number, of: number) => void;
    /**
     * Beta.28.4: Stop was asked (the app's job) and the run ended before these repos, in id
     * order: the one it was on when its write hadn't started, and those after it.
     */
    onStopped?: (notReached: readonly string[]) => void;
    /** The run's clock, in milliseconds (tests pass one); the time by default. */
    clock?: () => number;
  },
  io: Output,
): Promise<number> {
  const read = await factsRepos(root);
  if (!read.length) {
    io.err(
      `No repo has facts yet (${factsRelOf(root)}/<repo>.jsonl). Read one first: /atticus-map <repo> in your assistant.`,
    );
    return 2;
  }
  const { onRepo, only, onStart, onStopped, clock = Date.now, ...each } = o;
  const unread = (only ?? []).filter((r) => !read.includes(r));
  if (unread.length) {
    io.err(
      `No facts on file for ${unread.join(", ")} (${factsRelOf(root)}/<repo>.jsonl): nothing was verified.`,
    );
    return 2;
  }
  const repos = only ? read.filter((r) => only.includes(r)) : read;
  // beta.32: an upgrade owed is said once, before any repo is verified.
  const upgradeChecked = each.write === true && each.plan === undefined;
  const up = upgradeChecked ? await upgradeRefusal(root, io, each.json) : undefined;
  if (up === "stopped") return 1;
  const failed: string[] = [];
  // v31 (one build for many repos): with --write over two repos or more, each repo is verified as
  // before and its write held; the held writes are then one build, one guard and one undo step,
  // and each repo's own files after it. ATTICUS_APPLY_ONE_BUILD=0: each repo its own build.
  const oneBuild = each.plan === undefined && oneBuildFor(each.write === true, repos.length);
  type WriteFacts = NonNullable<VerifyCommandOptions["writeFacts"]>;
  type Held = {
    repo: string;
    args: Parameters<WriteFacts>;
    resolve: (r: ReturnType<WriteFacts>) => void;
    reject: (e: unknown) => void;
    run: Promise<number>;
    leftOut: () => number;
  };
  const held: Held[] = [];
  let reached: ((h: Omit<Held, "repo" | "run" | "leftOut">) => void) | undefined;
  const holdWrite: WriteFacts = (...args) =>
    new Promise((resolve, reject) => reached?.({ args, resolve, reject }));
  /** A repo the file system kept from being verified or written: said with its own command. */
  const notDone = (repo: string, e: unknown) => {
    io.err(
      `${repo}: not ${each.write ? "applied" : "verified"}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)} Run it once that is put right: atticus verify ${repo}${each.write ? " --write" : ""}`,
    );
    return 1;
  };
  const began = clock();
  let spent = 0;
  // The job this runs in, if any: its Stop is heard between repos, and inside a repo until
  // that repo's write starts (writeProgress).
  const signal = currentSignal();
  let stoppedAt: number | undefined;
  for (const [i, repo] of repos.entries()) {
    if (signal?.aborted) {
      stoppedAt = i;
      break;
    }
    // The estimate is the repos done so far, nothing else: said as "at this rate", since a big
    // repo after small ones takes longer than it says.
    if (repos.length > 1)
      (io.progress ?? io.err)(
        `Repo ${i + 1} of ${repos.length}: ${repo}…${i ? ` (${i} done in ${durationWords(spent)}; ${timeLeftWords((spent / i) * (repos.length - i))} left at this rate${oneBuild ? ", then one catalog build" : ""})` : ""}`,
      );
    onStart?.(repo, i, repos.length);
    let leftOut = 0;
    let code: number | undefined;
    try {
      const at = new Promise<Omit<Held, "repo" | "run" | "leftOut">>((r) => (reached = r));
      const run = verifyCommand(
        root,
        repo,
        {
          ...each,
          ...(upgradeChecked ? { upgradeChecked: true } : {}),
          ...(up === "ran" ? { upgradedFirst: true } : {}),
          onLeftOut: (l) => (leftOut = l.length),
          ...(oneBuild ? { writeFacts: holdWrite, pair: false } : {}),
        },
        io,
      );
      const first = await Promise.race([run, at]);
      if (typeof first === "number") code = first;
      else held.push({ ...first, repo, run, leftOut: () => leftOut });
    } catch (e) {
      // Beta.28.5 (the owner's field report: a run of forty repos ended on one file another
      // program held): that repo is said, with its own command, and the run goes on. Its files
      // are a consistent set (the rejected file is written before the facts file, and a held
      // file is left as it was); a catalog written before the error is whole.
      // The review: any error of the file system's (a file that can't be removed, no room),
      // and no other: a bug is thrown as before, never said as a repo not verified.
      if (isFileSystemError(e)) code = notDone(repo, e);
      else {
        // Stop asked while this repo was read or built: its write never started (the write's
        // own steps stop there and free the lock). Any other error is the command's, as before.
        if (!(e instanceof CancelledError) || !signal?.aborted) throw e;
        stoppedAt = i;
        break;
      }
    }
    spent = clock() - began;
    if (code === undefined) continue;
    onRepo?.(repo, code, leftOut);
    if (code !== 0) failed.push(repo);
    // This repo's write has ended whole, and another repo follows: Stop is heard again here, and
    // a Stop asked during that write is acted on now (the loop's next turn sees it). Never after
    // the last repo: there a Stop came too late, and the run is done.
    if (i < repos.length - 1) releaseCurrent();
  }
  /** A held repo's write given its result (or its error), and its verify run to its end. */
  const ended = new Set<Held>();
  const finish = async (h: Held, r: ReturnType<WriteFacts> | Error) => {
    ended.add(h);
    if (r instanceof Error) h.reject(r);
    else h.resolve(r);
    let code: number;
    try {
      code = await h.run;
    } catch (e) {
      if (!isFileSystemError(e)) throw e;
      code = notDone(h.repo, e);
    }
    onRepo?.(h.repo, code, h.leftOut());
    if (code !== 0) failed.push(h.repo);
  };
  /** The held repos not written when Stop ended the run. */
  let notWritten: string[] | undefined;
  /** A step after every repo's write failed (the review of PR #10): the run exits 1. */
  let runFault = false;
  /** ADR 0210 part 4: what the one build's pairing did, said at the end. */
  let paired: PairResult | undefined;
  if (stoppedAt === undefined && held.length) {
    const { writeFactsIntoCatalog, writeManyFactsIntoCatalog } =
      await import("./map-render-commands.js");
    try {
      if (held.length > 1) {
        (io.progress ?? io.err)(`Writing the catalog once for ${held.length} repos…`);
        const [, , , first, out] = held[0]!.args;
        // ADR 0210 part 4: the model asked before the one write takes its lock.
        const pairs = await (
          await import("./apply-pair.js")
        ).pairBeforeWrite(
          root,
          await loadOrgPack(orgPackDirOf(root)),
          held.map((h) => ({ repo: h.repo, facts: h.args[2] })),
        );
        try {
          await writeManyFactsIntoCatalog(
            root,
            held.map((h) => ({ repo: h.repo, facts: h.args[2], o: h.args[3] })),
            {
              ...first,
              command: "atticus verify --all --write",
              onRunFault: () => (runFault = true),
              ...(pairs ? { pairs, onPaired: (r: PairResult) => (paired ??= r) } : {}),
            },
            out,
            (i, r) => finish(held[i]!, r instanceof Error ? r : Promise.resolve(r)),
          );
        } catch (e) {
          // Beta.28.5's rule for the one write: a file another program holds (or no room) ends
          // it, nothing more is written, and each repo not written is said with its own command.
          if (!isFileSystemError(e)) throw e;
          for (const h of held) if (!ended.has(h)) await finish(h, e as Error);
        }
      }
      // A prototype (left out of the one build), one repo held, or the one build refused (each
      // repo's own write says its own refusal): each repo's own write, Stop heard between them.
      const own = held.filter((h) => !ended.has(h));
      for (const [k, h] of own.entries()) {
        if (signal?.aborted) throw new CancelledError();
        notWritten = own.slice(k).map((x) => x.repo);
        await finish(h, writeFactsIntoCatalog(...h.args));
        if (k < own.length - 1) releaseCurrent();
      }
      notWritten = undefined;
    } catch (e) {
      // Stop before a write: that repo and those after it are not written.
      if (!(e instanceof CancelledError) || !signal?.aborted) throw e;
      notWritten ??= held.map((h) => h.repo);
    }
  } else if (stoppedAt !== undefined && oneBuild) notWritten = held.map((h) => h.repo);
  if (notWritten) {
    for (const h of held) h.reject(new CancelledError());
    await Promise.allSettled(held.map((h) => h.run));
    const notReached = [...notWritten, ...repos.slice(stoppedAt ?? repos.length)];
    onStopped?.(notReached);
    const not = [...failed.filter((r) => !notReached.includes(r)), ...notReached].sort();
    io.out(
      [...ended].some((h) => !notWritten!.includes(h.repo))
        ? `Stopped after ${repos.length - notReached.length} of ${repos.length} repos. Not applied: ${not.join(", ")}.`
        : `Stopped before the catalog was written: none of the ${repos.length} repos was applied. Not applied: ${not.join(", ")}.`,
    );
    return 1;
  }
  if (stoppedAt !== undefined) {
    const notReached = repos.slice(stoppedAt);
    onStopped?.(notReached);
    const not = [...failed, ...notReached].sort();
    io.out(
      `Stopped after ${stoppedAt} of ${repos.length} repos. ${each.write ? "Not applied" : "Not verified"}: ${not.join(", ")}.`,
    );
    return 1;
  }
  const passed = repos.length - failed.length;
  if (paired) await sayPaired(paired, each.json ? io.err : io.out);
  io.out(
    `Verified ${repos.length === 1 ? "1 repo" : `${repos.length} repos`}: ${passed} passed${failed.length ? `, ${failed.length} with something to fix (${failed.join(", ")})` : ""}.`,
  );
  return failed.length || runFault ? 1 : 0;
}

/** ADR 0210 part 4: the lines of the write's pairing, when it did or said anything. */
async function sayPaired(r: PairResult, say: (l: string) => void) {
  if (!r.paired.length && !r.loose.length && !r.dropped.length && !r.withdrawn.length) return;
  for (const l of (await import("./apply-pair.js")).pairLines(r)) say(l);
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

/**
 * ADR 0124 addendum E-ids, its dated part of 2026-11-22 (the coordinator's decision for the
 * owner, option b): a repo's facts file checked exactly as `atticus verify <repo> --write` checks
 * it before it writes (the same reading of the file, the same verifier and inputs, the same commit
 * stamp), with nothing written: what `atticus upgrade`'s loose ends step takes as the repo's facts
 * slot when that read would name a loose end your changes name with its repo, and verify's build
 * waits for the step. `ok: false` says why in verify's words; the step then refuses.
 */
export async function verifiedReadOf(
  root: string,
  repo: string,
): Promise<
  | {
      ok: true;
      facts: import("@maycombhq/core").Fact[];
      /** The snapshot's commit, as verify --write stamps it. */
      commit: string;
      readComplete: boolean;
      contracts: import("@maycombhq/core").ContractsFileT | null;
    }
  | { ok: false; lines: string[] }
> {
  const rel = factsRelOf(root);
  const file = join(factsDirOf(root), `${repo}.jsonl`);
  const again = `run atticus verify ${repo} to see why, fix it, then run atticus upgrade again`;
  if (!existsSync(file))
    return { ok: false, lines: [`No facts for ${repo} at ${rel}/${repo}.jsonl.`] };
  const off = stackHelpersOff();
  let parsed;
  try {
    parsed = await streamFacts(file, roomGuard({ what: `${repo}'s facts` }));
  } catch (e) {
    if (!(e instanceof NoRoomError)) throw e;
    return { ok: false, lines: [`atticus verify ${repo}: ${e.message}`] };
  }
  const repaired = repairFormSlips(parsed.facts, parsed.bad);
  const dir = await checkoutOf(root, repo);
  if (!dir) return { ok: false, lines: [noCheckoutLine(repo)] };
  const ownGit = dir === root || existsSync(join(dir, ".git"));
  const commit = ownGit ? await headOf(dir) : undefined;
  const { carry } = await carryOf(dir, repaired.facts, commit);
  const inputs = await verifyInputsOf(root, repo, dir);
  const report = await verifyFacts({
    facts: repaired.facts,
    source: dirSource(dir),
    ...(off.has("derived-names") ? { derivedNames: false } : {}),
    ...(off.has("readers") ? { readers: false } : {}),
    ...(commit ? { commit, carry } : {}),
    exclude: inputs.exclude,
    corrections: inputs.corrections.corrections,
    reviewed: inputs.reviewed.entries,
    ...(inputs.estate ? { estate: inputs.estate } : {}),
    conventions: inputs.conventions,
    notes: inputs.notes,
    componentTypes: inputs.componentTypes,
    notReached: inputs.notReached,
  });
  const reviewedBad = reviewedProblemsOf(inputs.reviewed.bad, report);
  const n = report.rejected.length;
  if (repaired.bad.length || n || reviewedBad.length || !report.accepted.length)
    return {
      ok: false,
      lines: [
        `${repo}'s facts (${rel}/${repo}.jsonl) don't verify as atticus verify ${repo} --write checks them: ${
          n
            ? `${n} ${n === 1 ? "fact was" : "facts were"} rejected`
            : repaired.bad.length
              ? `${repaired.bad.length} ${repaired.bad.length === 1 ? "line isn't a fact" : "lines aren't facts"}`
              : reviewedBad.length
                ? `${rel}/${repo}.reviewed.jsonl has lines that were refused`
                : "no fact was kept"
        }. Nothing of this step was written: ${again}.`,
      ],
    };
  const { repoContractsOf } = await import("./link-evidence-files.js");
  const contracts = await repoContractsOf(root, repo, dir, report.accepted);
  const commits = [...new Set(report.accepted.map((f) => f.commit))];
  return {
    ok: true,
    facts: report.accepted,
    commit: commit ?? (commits.length === 1 ? commits[0]! : "unknown"),
    readComplete: report.coverage.unknown.length === 0,
    contracts: contracts.entries.length ? contracts : null,
  };
}

/** The facts the repo's stored read has and this read doesn't (by id, and by kind, file and line). */
async function leftOutOfThisRead(
  root: string,
  repo: string,
  now: readonly Fact[],
): Promise<Fact[]> {
  const { readFactsSlot } = await import("@maycombhq/scanner");
  const last = await readFactsSlot(root, repo).catch(() => undefined);
  if (!last?.ok) return [];
  const ids = new Set(now.map((f) => f.id));
  const at = (f: Fact) => `${f.kind}\u0000${f.cite.file}\u0000${f.cite.line}`;
  const where = new Set(now.map(at));
  return last.facts.filter((f) => !ids.has(f.id) && !where.has(at(f)));
}

/**
 * ADR 0210 part 3 (beta.32 said it and stopped): an upgrade a write needs first is run, and said:
 * "ran" when it ran, "stopped" when it was owed and failed (the write stops on the upgrade's own
 * words), undefined when none was owed.
 */
async function upgradeRefusal(
  root: string,
  io: Output,
  json?: boolean,
): Promise<"ran" | "stopped" | undefined> {
  const { upgradeBeforeWrite, runUpgradeFirst } = await import("./upgrade.js");
  if (!(await upgradeBeforeWrite(root))) return undefined;
  if (await runUpgradeFirst(root, io)) return "ran";
  if (json) io.out(JSON.stringify({ written: false, upgradeFirst: true }, null, 2));
  return "stopped";
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
  /** ADR 0210 part 3: this write ran the upgrade owed first (--json's `upgraded`). */
  let upgradedHere = o.upgradedFirst === true;
  // Beta.28.2 (ADR 0197): a --write over a catalog a newer Atticus built writes nothing, not
  // even the facts file's repairs: it refuses first, as the build's guard does, and says so.
  if (o.write) {
    const { newerAtticusRefusal, newerCatalogFiles, undoDirOf, writeRefusedReport } =
      await import("@maycombhq/scanner");
    const newer = await newerCatalogFiles(root, { undoDir: await undoDirOf(root) });
    if (newer.length) {
      const genRel = relative(root, join(catalogDirOf(root), "generated")).replace(/\\/g, "/");
      const refusal = newerAtticusRefusal(genRel, newer).refused!;
      await writeRefusedReport(root, `atticus verify ${repo} --write`, refusal);
      for (const l of refusal.message.split("\n")) io.err(l);
      await refusalEnds(root, refusal);
      if (o.json) io.out(JSON.stringify({ written: false, refused: refusal }, null, 2));
      return 1;
    }
    if (!o.upgradeChecked) {
      const up = await upgradeRefusal(root, io, o.json);
      if (up === "stopped") return 1;
      if (up === "ran") upgradedHere = true;
    }
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
    const many = parsed.newer.length === 1 ? "fact" : "facts";
    // beta.32 (the owner's estate, 2026-11-23): an assistant added `note` to calls and `secret` to
    // config facts, and this said "a newer Atticus" wrote them. A newer Atticus's stamp on the
    // metarepo, or one this Atticus can't read (only a newer one writes that), says one has
    // worked here; without it, the assistant most likely added them. A teammate on a newer
    // Atticus who never ran the upgrade leaves no stamp, so the words keep that open.
    const { readStampFile } = await import("./upgrade.js");
    const st = await readStampFile(root).catch(
      () => ({}) as Awaited<ReturnType<typeof readStampFile>>,
    );
    const stamped = st.stamp?.atticus;
    if ((stamped && newerThan(stamped, VERSION)) || st.unread) {
      io.err(
        `${parsed.newer.length} ${many} of ${rel}/${repo}.jsonl ${parsed.newer.length === 1 ? "is" : "are"} written by a newer Atticus: kept in the file as written, not read here. Install that version (a team upgrades together):`,
      );
      for (const n of parsed.newer.slice(0, SHOWN)) io.err(`  line ${n.line}: ${n.message}`);
    } else {
      const one = parsed.newer.length === 1;
      io.err(
        `${parsed.newer.length} ${many} of ${rel}/${repo}.jsonl ${one ? "has" : "have"} a field or kind no Atticus up to ${VERSION} writes, and no newer Atticus has upgraded this metarepo, so the assistant most likely added ${one ? "it" : "them"} as it read: kept in the file as written, not read here. Unless someone on your team uses a newer Atticus, take what is named out of each line (or read ${repo} again), then verify again:`,
      );
      for (const n of parsed.newer.slice(0, SHOWN))
        io.err(`  line ${n.line}: fact ${n.factId}: ${n.unknown ?? n.message}`);
    }
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
  // ADR 0210 part 3: a write keeps what the last read stored and this one left out, while every
  // file it cites is unchanged (the carry below checks its lines again): a second read that
  // misses a fact doesn't remove its record. A fact in a changed file goes with the change.
  // They are checked with this read's facts, but they are not this read's: they go into the
  // catalog's slot only (never into the facts file the read wrote), and the commits, coverage and
  // completeness said are this read's alone.
  const keptFromLast = o.write ? await leftOutOfThisRead(root, repo, parsed.facts) : [];
  const keptIds = new Set(keptFromLast.map((f) => f.id));
  const checked = keptFromLast.length ? [...parsed.facts, ...keptFromLast] : parsed.facts;
  // ADR 0124 addendum A-incremental: facts read at an earlier commit are carried to this one
  // where every file they cite is unchanged since, and read again where one changed.
  const { carry, missing: missingAll } = await carryOf(dir, checked, commit, o.git);
  const ownCommits = new Set(parsed.facts.map((f) => f.commit));
  const missing = missingAll.filter((c) => ownCommits.has(c));
  // ADR 0124 addendum D-app: a person's corrections from the Map, applied on every run.
  const inputs = await verifyInputsOf(root, repo, dir);
  const { corrections, reviewed, estate, conventions } = inputs;
  for (const b of corrections.bad.slice(0, SHOWN))
    io.err(`${rel}/${repo}.corrections.jsonl line ${b.line} isn't a correction: ${b.message}`);
  if (corrections.bad.length > SHOWN)
    io.err(
      `... and ${corrections.bad.length - SHOWN} more lines of ${rel}/${repo}.corrections.jsonl that aren't corrections`,
    );
  const verifyThese = (facts: readonly Fact[], held: ReadonlySet<string>) =>
    verifyFacts({
      facts: [...facts],
      source,
      ...(held.size ? { heldOver: held } : {}),
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
  let report: Awaited<ReturnType<typeof verifyFacts>>;
  try {
    report = await verifyThese(checked, keptIds);
    // A kept fact that no longer verifies (its file changed) goes; the read is checked again
    // without it, so nothing of it (a correction it met, a reference) stands in this read.
    const dropped = new Set([...keptIds].filter((id) => !report.accepted.some((f) => f.id === id)));
    if (dropped.size) {
      for (const id of dropped) keptIds.delete(id);
      report = await verifyThese(
        checked.filter((f) => !dropped.has(f.id)),
        keptIds,
      );
    }
  } catch (e) {
    if (!(e instanceof NoRoomError)) throw e;
    io.err(`atticus verify ${repo}: ${e.message}`);
    return 2;
  }
  /** The kept facts that still verify: written into the catalog's slot beside this read's. */
  let kept: Fact[] = [];
  if (keptIds.size) {
    const ids = keptIds;
    kept = report.accepted.filter((f) => ids.has(f.id));
    // This read's own report: the kept facts are out of what it accepted, rejected or carried.
    report.accepted = report.accepted.filter((f) => !ids.has(f.id));
    report.carried = report.carried.filter((c) => !ids.has(c.id));
    if (kept.length)
      io.err(
        `Kept ${kept.length} ${kept.length === 1 ? "fact" : "facts"} of the last read that this read left out, every file ${kept.length === 1 ? "it cites" : "they cite"} unchanged: ${kept
          .slice(0, 5)
          .map((f) => f.id)
          .join(
            ", ",
          )}${kept.length > 5 ? ` and ${kept.length - 5} more` : ""}. To remove one, delete it on the map.`,
      );
    // The rest (a cited file changed) are not this read's: they go, and aren't rejections of it.
    report.rejected = report.rejected.filter((x) => !ids.has(x.fact.id));
  }
  // ADR 0208: a person's correction gone stale under a learned rule refuses the write.
  if (o.write) {
    const { staleUnderLearned } = await import("./learn-corrections.js");
    const refused = await staleUnderLearned(root, repo, dir, report);
    for (const l of refused) io.err(l);
    if (refused.length) return 1;
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
  /** What goes into the catalog's slot: this read's facts, then the facts kept from the last. */
  const ownIds = new Set((partial?.facts ?? report.accepted).map((f) => f.id));
  const toCatalog = [
    ...(partial?.facts ?? report.accepted),
    ...kept.filter((f) => !ownIds.has(f.id)),
  ];
  /** ADR 0210 part 4: the write pairs the loose calls before its build (the first round's said). */
  let paired: PairResult | undefined;
  // The model is asked before the write takes its lock; what it said is applied inside it.
  const pairing = async () => {
    if (o.pair === false) return {};
    const { pairBeforeWrite } = await import("./apply-pair.js");
    const op = await loadOrgPack(orgPackDirOf(root));
    const pairs = await pairBeforeWrite(root, op, [{ repo, facts: toCatalog }]);
    return pairs ? { pairs, onPaired: (r: PairResult) => (paired ??= r) } : {};
  };
  /** ADR 0210 part 3: what the write went past to write (--json says it). */
  let went: import("./map-render-commands.js").WentPast | undefined;
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
      const writeFactsIntoCatalog =
        o.writeFacts ?? (await import("./map-render-commands.js")).writeFactsIntoCatalog;
      written = await writeFactsIntoCatalog(
        root,
        repo,
        toCatalog,
        {
          dir,
          command: `atticus verify ${repo} --write`,
          ...(await pairing()),
          ...(o.now ? { now: o.now() } : {}),
          onWentPast: (w) => (went = w),
          ...(commit ? { commit } : {}),
          ...(complete ? { readComplete: true } : {}),
          ...(o.allowRemovals !== undefined ? { allowRemovals: o.allowRemovals } : {}),
          ...(o.discardEdits !== undefined ? { discardEdits: o.discardEdits } : {}),
          ...(o.plan !== undefined ? { plan: o.plan } : {}),
          ...(o.cachesAfterResult ? { cachesAfterResult: true } : {}),
          onRefused: (r) => {
            refusedBuild = r.guard.refused;
            if (r.guard.refused) o.onBuildRefused?.(r.guard.refused);
          },
        },
        { ...io, out: () => undefined },
      );
      if (!written) for (const l of refusedLeftOut()) io.err(l);
      if (!written && !refusedBuild) return 1;
      if (paired) await sayPaired(paired, io.err);
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
          // ADR 0210 part 3, additive: what the write kept, removed and ran first.
          ...(kept.length || went?.editsKept?.length
            ? {
                kept: {
                  facts: kept.map((f) => f.id),
                  edits: went?.editsKept?.length ?? 0,
                },
              }
            : {}),
          ...(written && went?.removed?.length ? { removed: went.removed } : {}),
          ...(upgradedHere || went?.upgraded ? { upgraded: true } : {}),
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
  // v31 gate 0: no deploy fact and deploy or pipeline files not read: a change that moves or
  // ships the repo would have nothing to stand on. A note: it blocks nothing.
  const deployNote = noDeployNote(repo, report.accepted, cov.unknown);
  if (deployNote) io.out(deployNote);
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
    // v30 slice 8: what to do first, then what happened (with the list), then what it leaves.
    io.out(
      [
        `To record ${noAuth.length === 1 ? "it" : "them"}, give each entry below an authCite (the file and line that sets the auth, and what it writes there), then run: atticus verify ${repo}`,
        `${noAuth.length} ${noAuth.length === 1 ? "entry's" : "entries'"} auth rests on no cited line (all under authUncited in ${verifyYaml}):`,
      ].join("\n"),
    );
    show(
      noAuth.map((a) => `${a.id} (${a.auth}, ${a.cite})`),
      `(authUncited in ${verifyYaml})`,
    );
    io.out(
      `${noAuth.length === 1 ? "It is" : "They are"} kept in ${rel}/${repo}.jsonl as the reader wrote ${noAuth.length === 1 ? "it" : "them"}, and left out of the catalog: the map never says an auth nothing shows.`,
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
  // ADR 0164, addendum of 2026-11-17: a payload's class no field of it reaches.
  const loose = report.fieldsUnplaced ?? [];
  if (loose.length) {
    io.out(
      `${loose.length} ${loose.length === 1 ? "class of a payload isn't" : "classes of payloads aren't"} reached from ${loose.length === 1 ? "its" : "their"} payload's fields (a note, not a rejection; under fieldsUnplaced in ${verifyYaml}): the contract check can't say where ${loose.length === 1 ? "its" : "their"} fields sit, so a difference on them stays unconfirmed. Record the field that holds each, with its type as declared:`,
    );
    show(
      loose.map(
        (l) => `${l.class} (${l.file}), ${l.fields.length} of ${l.owner}'s ${l.side}: ${l.why}`,
      ),
      `(fieldsUnplaced in ${verifyYaml})`,
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
  const writeFactsIntoCatalog =
    o.writeFacts ?? (await import("./map-render-commands.js")).writeFactsIntoCatalog;
  const written = await writeFactsIntoCatalog(
    root,
    repo,
    toCatalog,
    {
      dir,
      command: `atticus verify ${repo} --write`,
      ...(await pairing()),
      ...(o.now ? { now: o.now() } : {}),
      verbose: o.verbose === true,
      ...(commit ? { commit } : {}),
      ...(complete ? { readComplete: true } : {}),
      ...(o.allowRemovals !== undefined ? { allowRemovals: o.allowRemovals } : {}),
      ...(o.discardEdits !== undefined ? { discardEdits: o.discardEdits } : {}),
      ...(o.plan !== undefined ? { plan: o.plan } : {}),
      ...(o.cachesAfterResult ? { cachesAfterResult: true } : {}),
      ...(o.onBuildRefused
        ? {
            onRefused: (r: { guard: { refused?: BuildRefusal } }) =>
              r.guard.refused && o.onBuildRefused!(r.guard.refused),
          }
        : {}),
    },
    io,
  );
  if (paired) await sayPaired(paired, io.out);
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
