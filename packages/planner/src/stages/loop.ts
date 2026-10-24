import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  AgentDefinition,
  answerWords,
  changesRelOf,
  raiseQuestions,
  readQuestion,
  runsDirOf,
  toCanonicalYaml,
  type Question,
  type QuestionDraft,
  type RunSummary,
} from "@maycombhq/core";
import {
  buildContextPack,
  fitBudget,
  quarantineItems,
  toRunSummary,
  type AiRuntime,
  type Run,
  type SourceInput,
} from "@maycombhq/ai";
import {
  changeFolder,
  changeStore,
  loadChangeContext,
  phaseGates,
  writeFileAtomic,
  type ChangeContext,
} from "@maycombhq/changes";
import {
  completeLensRun,
  CriticError,
  failLens,
  fingerprint as criticFingerprint,
  readRound,
  readRoundMeta,
  runCritic,
  waitingLenses,
  writeQuarantineItems,
  type StoredFinding,
} from "@maycombhq/naysayer";
import type { ChangeLifecycle } from "@maycombhq/core";
import { PlannerError } from "../errors.js";
import { citeFiles } from "./cite.js";
import { questionsOnFile, stepQuestionJudge } from "./questions-on-file.js";
import type { ContextOptions, ContextReport } from "../engine.js";
import { askGaps, type ContextGap } from "../gaps.js";
import {
  criticFindingKind,
  criticRuleChecks,
  stageRuleKind,
  type FindingKind,
} from "./finding-kind.js";
import {
  STAGE_PHASE,
  STAGE_SCHEMA_VERSION,
  StageLoop,
  type LoopFinding,
  type Stage,
} from "./schema.js";

/**
 * The loop every stage runs (ADR 0087, plan principle 4): the assistant drafts through the AI
 * runtime; the stage's own checks and a critic round review the draft: the critic's rules, then,
 * once the draft passes the rules, its AI lenses on the draft against the estate and the brief
 * (ADR 0115; in hand-off mode each lens is a further hand-off, offered one at a time, and the
 * draft's findings wait until every lens is in). Findings go back for another draft, with no cap on
 * model calls. Each finding has a fingerprint of its rule, target and evidence. One that comes
 * back unchanged twice (three drafts in a row), or comes back after it was gone, stops the
 * loop: a finding a person can decide becomes a question (ADR 0078); a drafting finding (the
 * shape of what the assistant wrote, finding-kind.ts) stops it with a plain message naming
 * the finding and the file to fix. A stage is done when nothing blocking is open and no
 * question it raised is open; then a person approves its PR.
 */

/** A problem the stage's checks found in a draft. */
export interface StageIssue {
  rule: string;
  /** What it is about: a flow, a step, a design element, an id. */
  target: string;
  /** path:line (metarepo-relative) when there is one. */
  evidence?: string;
  message: string;
  blocking: boolean;
  /** The repo it is about, for the question's repo. */
  repo?: string;
  /** decision (a person can decide it) or drafting (finding-kind.ts). Left out: by its rule. */
  kind?: FindingKind;
  /** A decision's choices, when the check knows them (the org pack's classification levels). */
  options?: { label: string; means: string; changes: string }[];
  /** The question to ask a person, in plain words, when the check knows it. */
  ask?: string;
}

export const issueFingerprint = (rule: string, target: string, evidence = "") =>
  createHash("sha256").update([rule, target, evidence].join("\n")).digest("hex").slice(0, 12);

/** What a stage plugs into the loop. */
export interface StageSpec<A> {
  stage: Stage;
  /** The agent that drafts, e.g. feature-placer. */
  agent: string;
  description: string;
  /** The answer's file name in the hand-off run folder. */
  output: string;
  /**
   * The change-folder file a person edits to fix a draft the assistant couldn't, e.g.
   * feature.yaml. A rerun after a stop checks it before drafting again.
   */
  source: string;
  /** Atticus's instructions: what to write and how. */
  instructions: string;
  /** The data the assistant reads: the input, the estate index, the knowledge. */
  sources: SourceInput[];
  /** Read the assistant's answer; problems are blocking issues. */
  parse(text: string): { answer?: A; issues: StageIssue[] };
  /**
   * The stage's deterministic checks of a parsed answer. `onFile`: the answer is the stage's
   * result on file, checked again after the stage was done, against a catalog that may since
   * hold what the change itself adds (its own code, merged and scanned).
   */
  check(answer: A, o?: { onFile?: boolean }): Promise<StageIssue[]>;
  /** Write the answer's files into the change folder; change-folder-relative paths. */
  write(answer: A): Promise<string[]>;
  /** The stage's result as it is in the change folder now, for a rerun with nothing to draft. */
  current(): Promise<A | undefined>;
  /** The questions the assistant raised in its answer. */
  questions?(answer: A): QuestionDraft[];
  /**
   * The names the change uses that nothing Atticus has read says anything about (ADR 0107
   * point 5): each one the answer relies on becomes a question to a person, never a guess.
   */
  gaps?: ContextGap[];
  /**
   * The gate the critic runs at, when the stage doesn't take its phase's first gate: the fast
   * path's gate from its change type (ADR 0113). Null: no gate in gates.yaml is for it.
   */
  gate?: string | null;
}

export interface StageOptions {
  runtime: AiRuntime;
  /**
   * The runtime for the critic's AI lenses. Default: the stage's runtime; in hand-off mode each
   * lens is handed off in turn (ADR 0115). Null: the critic's rules only.
   */
  criticRuntime?: AiRuntime | null;
  now?: Date;
  /** Finish a hand-off run: the run id `atticus handoff done` completed. */
  resume?: string;
  /** Draft again even when the stage is done. */
  force?: boolean;
  /** The context engine (ADR 0107): select what the stage sends, or send the whole lists (engine: false). */
  context?: ContextOptions;
}

export interface StageResult<A> {
  change: string;
  stage: Stage;
  state: "done" | "waiting" | "questions";
  /** Drafts so far, over every run of the stage. */
  iteration: number;
  /** Drafts this run made. */
  drafts: number;
  /** The findings of the last iteration. */
  findings: LoopFinding[];
  /** Open questions the stage raised. */
  questions: Question[];
  files: string[];
  answer?: A;
  /** The run handed off: a draft, or one of the critic's AI lenses reviewing it (ADR 0115). */
  waiting?: { runId: string; lens?: string };
  /** The command that opens the stage's PR, once it is done. */
  pr?: string;
  notes: string[];
  runs: RunSummary[];
  /** What the stage sent as context: selected (and what was left out), or the whole lists (ADR 0107). */
  context?: ContextReport;
}

const loopRel = (stage: Stage) => `stage/${stage}.yaml`;

/** What a person calls each stage's answer, for the questions the loop asks them. */
const STAGE_WORDS: Partial<Record<string, string>> = {
  feature: "feature placement",
  architecture: "target flows",
  stories: "stories",
  small: "small change's plan",
};

async function readLoop(dir: string, change: string, stage: Stage): Promise<StageLoop> {
  const text = await readFile(join(dir, loopRel(stage)), "utf8").catch(() => undefined);
  if (text !== undefined) {
    const r = StageLoop.safeParse(parse(text));
    if (r.success) return r.data;
  }
  return StageLoop.parse({
    schemaVersion: STAGE_SCHEMA_VERSION,
    change,
    stage,
    iteration: 0,
    state: "drafting",
    updatedAt: new Date(0).toISOString(),
  });
}

async function writeLoop(dir: string, l: StageLoop): Promise<void> {
  await writeFileAtomic(
    join(dir, loopRel(l.stage)),
    `# The ${l.stage} stage's loop (ADR 0087): drafts, the findings each one had, and the questions it raised. Atticus writes this file.\n${toCanonicalYaml(StageLoop.parse(l), ["schemaVersion", "change", "stage", "iteration", "state", "updatedAt", "run"])}`,
  );
}

/**
 * The tokens a stage's pack may take: its agent's budget, as the loop builds the pack with,
 * fitted to the model's limit when the step was given one (ADR 0112).
 */
export function stageBudget(ctx: ChangeContext, agent: string): number {
  return fitBudget(
    ctx.orgPack.agents.find((a) => a.id === agent)?.tokenBudget ??
      ctx.orgPack.runtime.budgets.defaultTokens,
  );
}

function agentFor(ctx: ChangeContext, spec: StageSpec<unknown>): AgentDefinition {
  return (
    ctx.orgPack.agents.find((a) => a.id === spec.agent) ??
    AgentDefinition.parse({
      schemaVersion: 1,
      id: spec.agent,
      role: "architect",
      description: spec.description,
      inputs: ["brief", "catalog-slice"],
      outputArtifact: "proposal",
      tokenBudget: ctx.orgPack.runtime.budgets.defaultTokens,
      allowedRuntimes: ["hand-off", "model", "headless-claude-code", "mock", "replay"],
    })
  );
}

/** The gate the stage's critic runs at: the first gate of the stage's phase. */
export function stageGate(ctx: ChangeContext, stage: Stage): string | undefined {
  return phaseGates(ctx, STAGE_PHASE[stage])[0];
}

/** What a person reads to finish the stage: the hand-off PR of its phase. */
export const stagePr = (change: string) => `atticus change handoff ${change} --approve`;

export async function runStageLoop<A>(
  root: string,
  changeId: string,
  spec: StageSpec<A>,
  o: StageOptions,
): Promise<StageResult<A>> {
  const ctx = await loadChangeContext(root);
  const change = await changeStore(root)
    .read(changeId)
    .catch((e: Error) => {
      throw new PlannerError("not-found", e.message);
    });
  const dir = changeFolder(root, change.id);
  const rel = `${changesRelOf(root)}/${change.id}`;
  const now = o.now ?? new Date();
  const at = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const loop = await readLoop(dir, change.id, spec.stage);
  const agent = agentFor(ctx, spec as StageSpec<unknown>);
  const levels = ctx.orgPack.pack?.classification ?? [
    "public",
    "internal",
    "confidential",
    "restricted",
  ];
  const notes: string[] = [];
  const runs: RunSummary[] = [];
  let drafts = 0;

  let checks: Map<string, string> | undefined;
  const kindOf = async (f: { rule: string; kind: "issue" | "knowledge-gap" }) =>
    criticFindingKind(f, (checks ??= await criticRuleChecks(root).catch(() => new Map())));

  const questionsOf = async (ids: string[]) =>
    (await Promise.all(ids.map((id) => readQuestion(root, id).catch(() => undefined)))).filter(
      (q): q is Question => !!q,
    );
  const result = async (
    state: StageResult<A>["state"],
    extra: Partial<StageResult<A>> = {},
  ): Promise<StageResult<A>> => {
    const open = (await questionsOf(loop.questions)).filter((q) => q.state === "open");
    return {
      change: change.id,
      stage: spec.stage,
      state,
      iteration: loop.iteration,
      drafts,
      findings: loop.findings.filter((f) => f.seenIn.at(-1) === loop.iteration),
      questions: open,
      files: [],
      notes,
      runs,
      ...(state === "done" ? { pr: stagePr(change.id) } : {}),
      ...extra,
    };
  };

  // A critic round waiting for its AI lenses: the stage waits for the first one (ADR 0115).
  const handedToLens = async (
    w: LensWait,
    draft: { draft?: string; files: string[]; issues: StageIssue[] },
    extra: Partial<StageResult<A>> = {},
  ): Promise<StageResult<A>> => {
    loop.review = { gate: w.gate, round: w.round, ...draft };
    loop.state = "waiting";
    loop.run = w.runId;
    loop.updatedAt = at;
    await writeLoop(dir, loop);
    return result("waiting", { ...extra, waiting: { runId: w.runId, lens: w.lens } });
  };

  // A stage waiting for a person stays stopped until the questions are answered.
  if (!o.resume && loop.state === "questions") {
    const open = (await questionsOf(loop.questions)).filter((q) => q.state === "open");
    if (open.length) return result("questions");
  }
  // A stop a person must deal with: the loop says so, and a rerun starts from what is on file.
  const stopNow = async (message: string, lines: string[] = []): Promise<never> => {
    loop.state = "stopped";
    delete loop.review;
    delete loop.run;
    loop.updatedAt = at;
    await writeLoop(dir, loop);
    throw new PlannerError("stopped", [message, ...lines].join("\n"), lines);
  };

  let carried: string | undefined;
  // The critic's lenses on the draft are read in again: a lens run gone or cancelled (ADR 0115).
  let reviewAgain = false;
  if (!o.resume && loop.state === "waiting" && loop.run) {
    // Still waiting only while its run is: a run deleted, or finished without --resume, is
    // drafted again rather than waited on for ever. A run.json that doesn't read is one being
    // written (`handoff done` in another process): still waiting, never drafted twice.
    const run = await readFile(join(runsDirOf(root), change.id, loop.run, "run.json"), "utf8")
      .then(
        (t) => {
          try {
            return (JSON.parse(t) as { state?: string }).state ?? "unreadable";
          } catch {
            return "unreadable";
          }
        },
        (e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? undefined : "unreadable"),
      )
      .catch(() => undefined);
    // While the critic's lenses review the draft, the run waited on is a lens's.
    const lens = loop.review
      ? ((await readRoundMeta(root, change.id, loop.review.gate, loop.review.round))?.lenses.find(
          (l) => l.runId === loop.run,
        )?.lens ?? "AI")
      : undefined;
    // A lens whose answer failed its check is offered again, to be fixed (M6).
    const out = ["waiting", "prepared", "produced", "unreadable", ...(lens ? ["failed"] : [])];
    if (run !== undefined && out.includes(run)) {
      notes.push(
        lens
          ? `The ${lens} lens's review of the draft is still with your assistant (run ${loop.run}).`
          : `The draft is still with your assistant (run ${loop.run}).`,
      );
      return result("waiting", { waiting: { runId: loop.run, ...(lens ? { lens } : {}) } });
    }
    if (lens) {
      // The lenses on the same draft are read in again; a lens with no run left didn't review.
      reviewAgain = true;
      if (run !== "validated")
        notes.push(
          run === undefined
            ? `Run ${loop.run} is no longer there, so the ${lens} lens didn't review the draft.`
            : `Run ${loop.run} ended ${run}, so the ${lens} lens didn't review the draft.`,
        );
    } else if (run === "validated" && o.runtime.kind === "hand-off") {
      // atticus handoff done checked its answer, and nothing read it in: read it in now.
      carried = loop.run;
      notes.push(`Run ${loop.run} was checked; reading its answer in.`);
    } else
      notes.push(
        run === undefined
          ? `Run ${loop.run} is no longer there, so the draft is handed off again.`
          : run === "validated"
            ? `Run ${loop.run} was a hand-off and this run isn't, so the stage drafts again.`
            : `Run ${loop.run} ended ${run} without being read in, so the draft is handed off again.`,
      );
  }

  // Issues to hand back with the next draft.
  let issues: StageIssue[] = [];
  // Nothing new to draft: a person's answers all read, the result on file, no --force. Check it
  // again without AI; draft only if the check finds something.
  const answers = await questionsOf(loop.questions);
  const unread = answers.filter((q) => q.state === "answered" && !loop.read.includes(q.id));
  if (!o.resume && !o.force && loop.state === "done" && unread.length === 0) {
    const cur = await spec.current();
    if (cur !== undefined) {
      issues = (await spec.check(cur, { onFile: true })).filter((i) => i.blocking);
      if (issues.length === 0) return result("done", { answer: cur });
      notes.push("The stage's files changed since it was done; drafting again.");
    }
  }

  // Stopped on a drafting finding: a person may have fixed the stage's file. Check what is on
  // file (and write what comes from it) before drafting again.
  if (!o.resume && !o.force && loop.state === "stopped") {
    const cur = await spec.current();
    const stopped = loop.findings.filter((f) => f.stoppedAt === loop.iteration);
    if (cur !== undefined) {
      issues = (await spec.check(cur)).filter((i) => i.blocking);
      if (issues.length === 0) {
        const files = await spec.write(cur);
        const c = await criticRound(root, ctx, change, spec, o, loop, notes, kindOf, {
          files,
          sources: spec.sources,
        });
        if (c.stop) await stopNow(c.stop.message, c.stop.lines);
        if (c.waiting)
          return handedToLens(c.waiting, { files, issues: [] }, { files, answer: cur });
        issues = c.issues.filter((i) => i.blocking);
        if (issues.length === 0) {
          loop.state = "done";
          loop.updatedAt = at;
          await writeLoop(dir, loop);
          return result("done", { files, answer: cur });
        }
      }
    } else
      issues = stopped.map((f) => ({
        rule: f.rule,
        target: f.target,
        ...(f.evidence ? { evidence: f.evidence } : {}),
        message: f.message,
        blocking: true,
      }));
    notes.push(
      `The ${spec.stage} stage stopped last time on what your assistant couldn't fix; drafting again${issues.length ? ` with the ${issues.length === 1 ? "finding" : "findings"} still open` : ""}.`,
    );
  }

  let resume = o.resume ?? carried;
  for (;;) {
    let answered: Question[];
    let run: Run | undefined;
    let answer: A | undefined;
    const found: StageIssue[] = [];
    let files: string[] = [];
    let review = resume || reviewAgain ? loop.review : undefined;
    reviewAgain = false;
    // A resume names a lens of the round the draft waits on; a draft run resumed while an older
    // round's review is still on file starts a fresh draft's check, and the stale review goes.
    if (review && resume && !(await isLensOf(root, change.id, review, resume))) {
      delete loop.review;
      review = undefined;
    }
    if (review) {
      // ---- the critic's AI lenses on the last draft, handed off one at a time (ADR 0115)
      const lenses = await lensesIn(root, change.id, review, o, at, kindOf);
      resume = undefined;
      if (lenses.waiting) return handedToLens(lenses.waiting, review);
      if (lenses.failed.length) {
        const stop = lensStop(spec.stage, change.id, loop.iteration, lenses.failed);
        await stopNow(stop.message, stop.lines);
      }
      delete loop.review;
      delete loop.run;
      answered = (await questionsOf(loop.questions)).filter((q) => q.state === "answered");
      if (review.draft) run = await o.runtime.result(review.draft).catch(() => undefined);
      answer = await spec.current();
      files = review.files;
      found.push(...review.issues, ...lenses.issues);
    } else {
      // ---- draft (a review of an earlier draft no longer applies)
      delete loop.review;
      answered = (await questionsOf(loop.questions)).filter((q) => q.state === "answered");
      const fix = issues.filter((i) => i.blocking);
      const back = handBacks(fix, answered);
      const sources: SourceInput[] = [
        {
          id: "instructions",
          kind: "instruction",
          origin: "atticus",
          text: instructionsWith(spec.instructions, fix, answered),
          classification: "public",
          trusted: true,
        },
        // What the last draft got wrong and what people answered quote model-written and
        // ingested text, so they go as data, screened by the defences, never as instructions.
        ...(back
          ? [
              {
                id: HAND_BACKS,
                kind: "artifact" as const,
                origin: "atticus (the last draft's findings and people's answers)",
                text: back,
                classification: "public",
                priority: 1000,
              },
            ]
          : []),
        ...spec.sources,
        // ADR 0117: the questions on file, so the model says which one a question is the same as.
        ...(await questionsOnFile(root, change.id)),
      ];
      const pack = buildContextPack({
        change: change.id,
        agent: agent.id,
        budget: agent.tokenBudget,
        sources,
        levels,
        maxClassification: levels.includes("internal") ? "internal" : levels[0]!,
        now,
        step: `${spec.stage === "stories" ? "plan" : "change"} ${spec.stage} ${change.id}`,
      });
      let draftRun: Run;
      if (resume) {
        draftRun = await o.runtime.result(resume);
        // Only this stage's own draft is read in as its draft (two steps at once hand off two
        // runs; another change's answer must never be written as this change's).
        if (draftRun.request.change !== change.id || draftRun.request.outputPath !== spec.output)
          throw new PlannerError(
            "refused",
            `Run ${resume} isn't a draft or a lens of ${change.id}'s ${spec.stage} stage: resume with the run the stage handed off${loop.run ? ` (${loop.run})` : ""}.`,
          );
        resume = undefined;
      } else {
        const prepared = await o.runtime.prepare({
          change: change.id,
          agent,
          pack,
          outputPath: spec.output,
          outputIn: "run",
        });
        await writeQuarantineItems(
          root,
          change.id,
          prepared.runId,
          quarantineItems(pack.defences ?? []),
        );
        draftRun = await o.runtime.run(prepared.runId);
      }
      run = draftRun;
      runs.push(toRunSummary(run));
      if (run.state === "waiting" || run.state === "prepared") {
        loop.state = "waiting";
        loop.run = run.runId;
        loop.updatedAt = at;
        await writeLoop(dir, loop);
        return result("waiting", { waiting: { runId: run.runId } });
      }
      delete loop.run;
      drafts++;
      loop.iteration++;
      loop.read = [...new Set([...loop.read, ...answered.map((q) => q.id)])].sort();

      // ---- check
      if (run.output === undefined || run.state === "failed" || run.state === "cancelled")
        found.push({
          rule: "stage.no-answer",
          target: spec.stage,
          message: `The assistant gave no answer (${run.state}${run.errors.length ? `: ${run.errors.join("; ")}` : ""}).`,
          blocking: true,
        });
      else {
        // A line cited by the data block it was read in is read as that block's file (cite.ts).
        const p = spec.parse(citeFiles(run.output, sources));
        found.push(...p.issues);
        answer = p.answer;
        if (answer !== undefined) {
          found.push(...(await spec.check(answer)));
          files = await spec.write(answer);
        }
      }
      // ---- the critic, on each draft that passes the stage's own checks: its rules and its AI
      // lenses (ADR 0115). A draft with a blocking finding of its own goes back first, using no
      // critic round (a gate's round limit counts reviews of drafts worth reviewing).
      if (answer !== undefined && !found.some((i) => i.blocking)) {
        const c = await criticRound(root, ctx, change, spec, o, loop, notes, kindOf, {
          files,
          sources: spec.sources,
        });
        if (c.stop) await stopNow(c.stop.message, c.stop.lines);
        if (c.waiting)
          return handedToLens(
            c.waiting,
            { draft: run.runId, files, issues: found },
            { files, ...(answer !== undefined ? { answer } : {}) },
          );
        found.push(...c.issues);
      }
    }
    const n = loop.iteration;
    const decided = new Set(answered.map((q) => q.id));

    // ---- fingerprints and the end rule
    const toAsk: { f: LoopFinding; issue: StageIssue }[] = [];
    const toStop: LoopFinding[] = [];
    // A finding a person answered, back in a draft that was given the answer: the assistant
    // doesn't follow it, and drafting again won't change that.
    const ignored: LoopFinding[] = [];
    const byFp = new Map(loop.findings.map((f) => [f.fingerprint, f]));
    for (const i of found) {
      const fp = issueFingerprint(i.rule, i.target, i.evidence ?? "");
      const was = byFp.get(fp);
      const f: LoopFinding = was ?? {
        fingerprint: fp,
        rule: i.rule,
        target: i.target,
        ...(i.evidence ? { evidence: i.evidence } : {}),
        message: i.message,
        blocking: i.blocking,
        source: i.rule.startsWith("critic:") ? "critic" : "stage",
        seenIn: [],
      };
      if (f.seenIn.at(-1) === n) continue; // the same problem twice in one draft
      f.message = i.message;
      f.blocking = i.blocking;
      f.kind = i.kind ?? (f.source === "critic" ? "decision" : stageRuleKind(i.rule));
      f.seenIn = [...f.seenIn, n];
      byFp.set(fp, f);
      if (f.blocking && f.question && loop.read.includes(f.question)) {
        ignored.push(f);
        continue;
      }
      // Sightings up to a stop a person has since dealt with don't count again.
      const seen = f.seenIn.filter((x) => x > (f.stoppedAt ?? 0));
      const repeated = seen.length >= 3 && seen.at(-3) === n - 2 && seen.at(-2) === n - 1;
      const flipped = seen.length >= 2 && seen.at(-2)! < n - 1;
      if (!f.blocking || !(repeated || flipped)) continue;
      if (f.kind === "drafting") toStop.push(f);
      else if (!f.question) toAsk.push({ f, issue: i });
    }
    loop.findings = [...byFp.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
    loop.updatedAt = at;
    loop.state = "drafting";
    await writeLoop(dir, loop);

    // The loop's own questions are about the repo a finding names; the assistant's are the
    // change's. Each is raised for its own repo, so an answered one is found again (a question
    // filed under another repo was asked a third time on NadiEngine).
    const drafted: { repo: string; q: QuestionDraft; f?: LoopFinding }[] = [];
    const evidenceFor = async (e: string | undefined) =>
      e && (await lineExists(root, e)) ? e : `${rel}/${loopRel(spec.stage)}:1`;
    for (const { f, issue } of toAsk)
      drafted.push({
        f,
        repo: issue.repo ?? change.id,
        q: {
          // A check that knows the question to ask asks it plainly, so its answer reads as one
          // in the next prompt; else the finding, and what the stage's answer should say.
          question:
            issue.ask ??
            `${f.seenIn.at(-2)! < n - 1 ? "This came back after a draft had fixed it" : "Three drafts in a row had this problem"}: ${issue.message} What should the ${STAGE_WORDS[spec.stage] ?? spec.stage} say?`,
          options: issue.options ?? [],
          evidence: [await evidenceFor(f.evidence)],
          scope: "repo",
        },
      });
    const own = answer !== undefined && spec.questions ? spec.questions(answer) : [];
    for (const q of own) {
      const ok: string[] = [];
      for (const e of q.evidence) if (await lineExists(root, e)) ok.push(e);
      if (ok.length) drafted.push({ repo: change.id, q: { ...q, evidence: ok } });
      else
        notes.push(
          `Left out the assistant's question "${q.question}": none of its evidence (${q.evidence.join(", ")}) is a line in the metarepo.`,
        );
    }
    if (drafted.length) {
      const qs: Question[] = [];
      const judge = stepQuestionJudge(root, o.runtime, change.id, now);
      for (const repo of [...new Set(drafted.map((x) => x.repo))]) {
        const mine = drafted.filter((x) => x.repo === repo);
        const raised = await raiseQuestions(
          root,
          mine.map((x) => x.q),
          {
            step: `change-${spec.stage}`,
            repo,
            command: rerunOf(spec.stage, change.id),
            rerun: rerunOf(spec.stage, change.id),
            ...(run?.runId ? { run: run.runId } : {}),
            at,
          },
          judge ? { judge } : {},
        );
        qs.push(...raised.raised, ...raised.known);
        // Each finding asked is linked to the question it became, by id, never by its words (a
        // check's own question doesn't hold the finding's message).
        mine.forEach((x, i) => {
          if (x.f && raised.of[i]) x.f.question = raised.of[i]!.id;
        });
      }
      loop.questions = [...new Set([...loop.questions, ...qs.map((q) => q.id)])].sort();
    }
    // A gap the answer relies on goes to a person (ADR 0107 point 5).
    if (answer !== undefined && run?.output && spec.gaps?.length) {
      const asked = await askGaps(root, change.id, spec.gaps, run.output, {
        command: rerunOf(spec.stage, change.id),
        rerun: rerunOf(spec.stage, change.id),
        ...(run.runId ? { run: run.runId } : {}),
        at,
      });
      if (asked.length) {
        loop.questions = [...new Set([...loop.questions, ...asked.map((q) => q.id)])].sort();
        await writeLoop(dir, loop);
      }
    }

    // ---- stop, or go round again
    const open = (await questionsOf(loop.questions)).filter((q) => q.state === "open");
    if (ignored.length && !open.length) {
      for (const f of ignored) f.stoppedAt = n;
      const stop = stopMessage(spec, rel, n, ignored, rerunOf(spec.stage, change.id));
      await stopNow(
        `The ${spec.stage} stage stopped after ${n} draft${n === 1 ? "" : "s"}: a person answered ${[...new Set(ignored.map((f) => f.question!))].join(", ")}, and your assistant's draft still doesn't follow the answer.`,
        stop.lines,
      );
    }
    if (toStop.length) {
      for (const f of toStop) f.stoppedAt = n;
      const stop = stopMessage(spec, rel, n, toStop, rerunOf(spec.stage, change.id));
      if (open.length) notes.push(stop.message, ...stop.lines);
      else {
        loop.state = "stopped";
        await writeLoop(dir, loop);
        throw new PlannerError("stopped", [stop.message, ...stop.lines].join("\n"), stop.lines);
      }
    }
    const current = loop.findings.filter((f) => f.seenIn.at(-1) === n);
    const answeredNow = new Set(
      (await questionsOf(loop.questions)).filter((q) => q.state === "answered").map((q) => q.id),
    );
    const blocking = current.filter(
      (f) =>
        f.blocking && !(f.question && (answeredNow.has(f.question) || decided.has(f.question))),
    );
    if (open.length) {
      loop.state = "questions";
      await writeLoop(dir, loop);
      return result("questions", { files, ...(answer !== undefined ? { answer } : {}) });
    }
    if (blocking.length === 0) {
      loop.state = "done";
      await writeLoop(dir, loop);
      return result("done", { files, ...(answer !== undefined ? { answer } : {}) });
    }
    issues = blocking.map((f) => ({
      rule: f.rule,
      target: f.target,
      ...(f.evidence ? { evidence: f.evidence } : {}),
      message: f.message,
      blocking: true,
    }));
  }
}

/**
 * The plain message a drafting finding stops the loop with: what came back, where it is, and
 * the file a person fixes (or tells the assistant how to fix) before running the stage again.
 */
export function stopMessage(
  spec: Pick<StageSpec<unknown>, "stage" | "source">,
  rel: string,
  drafts: number,
  findings: Pick<LoopFinding, "message" | "rule" | "evidence">[],
  rerun: string,
): { message: string; lines: string[] } {
  const source = `${rel}/${spec.source}`;
  const one = findings.length === 1;
  const elsewhere = findings.some((f) => f.evidence && !f.evidence.startsWith(source));
  return {
    message: `The ${spec.stage} stage stopped after ${drafts} draft${drafts === 1 ? "" : "s"}: your assistant kept getting ${one ? "this" : "these"} wrong, and ${one ? "it isn't a question" : "they aren't questions"} for a person to decide.`,
    lines: [
      ...findings.map(
        (f) =>
          `  - ${f.message} (rule ${f.rule.replace(/^critic:/, "")}; in ${f.evidence ?? source})`,
      ),
      `Fix ${source}${elsewhere ? " (the stage writes the files above from it)" : ""}, or tell your assistant how; then run ${rerun} again. Atticus checks your fix before it drafts again.`,
    ],
  };
}

export function rerunOf(stage: Stage, change: string): string {
  return stage === "stories"
    ? `atticus plan stories ${change}`
    : `atticus change ${stage} ${change}`;
}

/** The data block that carries what the last draft got wrong and what people answered. */
export const HAND_BACKS = "hand-backs";

/**
 * Atticus's own instructions for the next draft: what to do with the hand-backs, in Atticus's
 * words only. The findings and answers themselves quote what a model wrote and what was read
 * from the repos and attachments, so they go in the hand-backs data block (handBacks), where
 * the defences screen them (rule 6), never in the trusted instructions.
 */
function instructionsWith(base: string, fix: StageIssue[], answered: Question[]): string {
  const out = [base];
  if (fix.length)
    out.push(
      "",
      `Your last draft had problems; the "${HAND_BACKS}" data block lists them. Fix every one; a problem that comes back unchanged goes to a person.`,
    );
  if (answered.length)
    out.push(
      "",
      `People answered questions; the "${HAND_BACKS}" data block lists each question with its answer. Follow their answers.`,
    );
  return out.join("\n");
}

/** The hand-backs data block's text: the last draft's problems and people's answers. */
function handBacks(fix: StageIssue[], answered: Question[]): string | undefined {
  const out: string[] = [];
  if (fix.length)
    out.push(
      "Problems in the last draft:",
      ...fix.map((i) => `- ${i.message}${i.evidence ? ` (${i.evidence})` : ""}`),
    );
  if (answered.length)
    out.push(
      ...(out.length ? [""] : []),
      "Questions people answered:",
      ...answered.map((q) => `- ${q.question} Answer: ${answerWords(q) ?? ""}`),
    );
  return out.length ? out.join("\n") : undefined;
}

/** Whether "path:line" is a line of a file under the metarepo. */
export async function lineExists(root: string, at: string): Promise<boolean> {
  const cut = at.lastIndexOf(":");
  if (cut < 1) return false;
  const path = at.slice(0, cut);
  const n = Number(at.slice(cut + 1));
  if (!Number.isInteger(n) || n < 1 || path.includes("..")) return false;
  const text = await readFile(join(root, ...path.split("/")), "utf8").catch(() => undefined);
  if (text === undefined) return false;
  return n <= text.replace(/\n$/, "").split(/\r?\n/).length;
}

/** A critic lens handed off and waiting for the person's assistant (ADR 0115). */
interface LensWait {
  runId: string;
  lens: string;
  gate: string;
  round: number;
}

/** The draft the critic's AI lenses review with the artifacts it was drafted from (ADR 0115). */
interface DraftReview {
  files: string[];
  sources: SourceInput[];
}

/** A lens of a round that didn't review: no answer, or an answer that isn't a review. */
interface LensFailed {
  lens: string;
  reason: string;
}

/** Whether a run is one of the lenses of the round a draft waits on. */
async function isLensOf(
  root: string,
  change: string,
  review: { gate: string; round: number },
  runId: string,
): Promise<boolean> {
  const meta = await readRoundMeta(root, change, review.gate, review.round);
  return !!meta?.lenses.some((l) => l.runId === runId);
}

/** The lenses of a round that failed, with why. */
async function failedLenses(
  root: string,
  change: string,
  gate: string,
  round: number,
): Promise<LensFailed[]> {
  const meta = await readRoundMeta(root, change, gate, round);
  return (meta?.lenses ?? [])
    .filter((l) => l.state === "failed")
    .map((l) => ({ lens: l.lens, reason: l.reason ?? "it gave no review" }));
}

/** The runtime the critic's AI lenses run with, or none (rules only; AI off). */
function lensRuntimeOf(ctx: ChangeContext, o: StageOptions): AiRuntime | undefined {
  if (o.criticRuntime === null || ctx.orgPack.runtime.ai === "off") return undefined;
  return o.criticRuntime ?? o.runtime;
}

/** A round's open blocking findings as the stage's issues, fingerprinted by the critic's own fingerprint. */
async function criticIssues(
  root: string,
  change: string,
  findings: StoredFinding[],
  kindOf: (f: { rule: string; kind: "issue" | "knowledge-gap" }) => Promise<FindingKind>,
): Promise<StageIssue[]> {
  const rel = `${changesRelOf(root)}/${change}`;
  const out: StageIssue[] = [];
  for (const f of findings.filter(
    (x) => x.finding.state === "open" && x.finding.severity === "blocking",
  ))
    out.push({
      rule: `critic:${f.finding.rule}`,
      target: criticFingerprint(f.finding),
      evidence: `${rel}/${f.finding.artifact}${f.finding.locator.line ? `:${f.finding.locator.line}` : ""}`,
      message: `The critic (${f.finding.rule}): ${f.finding.summary}`,
      blocking: true,
      kind: await kindOf(f.finding),
    });
  return out;
}

/**
 * The critic round a draft waits on, after a hand-off resume: a lens answer `atticus handoff
 * done` validated but didn't read in is read in now; the first lens still out is waited for
 * (one whose answer failed its check too: it is offered again, to be fixed); a lens whose run
 * is gone or was cancelled is recorded as failed. When every lens is in, the round's open
 * blocking findings come back as issues, and the lenses that didn't review as `failed`. The
 * round is the draft's own, whatever round ran at the gate since.
 */
async function lensesIn(
  root: string,
  change: string,
  review: { gate: string; round: number },
  o: StageOptions,
  at: string,
  kindOf: (f: { rule: string; kind: "issue" | "knowledge-gap" }) => Promise<FindingKind>,
): Promise<{ waiting?: LensWait; issues: StageIssue[]; failed: LensFailed[] }> {
  const rt = o.criticRuntime ?? o.runtime;
  for (const w of await waitingLenses(root, change, review.gate, review.round)) {
    const run = await rt.result(w.runId).catch(() => undefined);
    if (run?.state === "validated") {
      await completeLensRun(root, run, { now: at });
      continue;
    }
    if (!run || run.state === "cancelled") {
      await failLens(
        root,
        change,
        review.gate,
        review.round,
        w.runId,
        run ? `its run ${w.runId} was cancelled` : `its run ${w.runId} is no longer there`,
      );
      continue;
    }
    return { waiting: { ...w, gate: review.gate }, issues: [], failed: [] };
  }
  const { findings } = await readRound(root, change, review.gate, review.round);
  return {
    issues: await criticIssues(root, change, findings, kindOf),
    failed: await failedLenses(root, change, review.gate, review.round),
  };
}

/**
 * One critic round at the stage's gate on a draft that passed the stage's checks: its rules and
 * its AI lenses (ADR 0115). Open blocking findings come back as issues; a lens handed off to the
 * person's assistant comes back as the one to wait for. A stop comes back when no review can
 * be had: the gate's critic rounds are used up (a person decides now), or a lens didn't review.
 */
async function criticRound(
  root: string,
  ctx: ChangeContext,
  change: ChangeLifecycle,
  spec: { stage: Stage; gate?: string | null },
  o: StageOptions,
  loop: StageLoop,
  notes: string[],
  kindOf: (f: { rule: string; kind: "issue" | "knowledge-gap" }) => Promise<FindingKind>,
  draft: DraftReview,
): Promise<{
  issues: StageIssue[];
  waiting?: LensWait;
  stop?: { message: string; lines: string[] };
}> {
  const gate = spec.gate === undefined ? stageGate(ctx, spec.stage) : spec.gate;
  if (!gate) {
    notes.push(
      spec.gate === null
        ? `No gate in gates.yaml is for the ${spec.stage} step's change type, so no critic ran.`
        : `No gate in gates.yaml is for the ${STAGE_PHASE[spec.stage]} phase, so no critic ran.`,
    );
    return { issues: [] };
  }
  const lensRuntime = lensRuntimeOf(ctx, o);
  const draftNo = loop.iteration;
  let r;
  try {
    r = await runCritic(root, change.id, {
      gate,
      ...(lensRuntime ? { runtime: lensRuntime } : {}),
      review: { stage: spec.stage, files: draft.files, sources: draft.sources },
      now: (o.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
  } catch (e) {
    // The gate's rounds are used up: the draft on file has had no review, so the stage can't
    // say nothing blocks. A person decides, as the critic says.
    if (e instanceof CriticError && e.code === "round-limit")
      return {
        issues: [],
        stop: {
          message: `The ${spec.stage} stage stopped: draft ${draftNo} can't have a critic round. ${e.message}`,
          lines: [
            `  - Draft ${draftNo} is in the change folder without a review at the ${gate} gate; atticus findings ${change.id} shows the newest round's.`,
          ],
        },
      };
    notes.push(`The critic didn't run at the ${gate} gate: ${(e as Error).message}`);
    return { issues: [] };
  }
  loop.critic = [...loop.critic, { gate, round: r.round }];
  const first = r.lenses.find((l) => l.state === "waiting" && l.runId);
  if (first)
    return {
      issues: [],
      waiting: { runId: first.runId!, lens: first.lens, gate, round: r.round },
    };
  // A lens that didn't review (its model failed, or answered with no review) leaves the draft
  // unreviewed: the stage stops rather than count it as clean.
  const failed = r.lenses
    .filter((l) => l.state === "failed")
    .map((l) => ({ lens: l.lens, reason: l.reason ?? "it gave no review" }));
  if (failed.length) return { issues: [], stop: lensStop(spec.stage, change.id, draftNo, failed) };
  return { issues: await criticIssues(root, change.id, r.findings, kindOf) };
}

/** The stop when a lens didn't review a draft: which, why, and that a rerun reviews it again. */
function lensStop(
  stage: Stage,
  change: string,
  draft: number,
  failed: LensFailed[],
): { message: string; lines: string[] } {
  return {
    message: `The ${stage} stage stopped: the critic's ${failed.map((l) => l.lens).join(" and ")} ${failed.length === 1 ? "lens" : "lenses"} didn't review draft ${draft}, so nothing says it is sound.`,
    lines: [
      ...failed.map(
        (l) => `  - The critic's ${l.lens} lens didn't review draft ${draft}: ${l.reason}`,
      ),
      `Run ${rerunOf(stage, change)} again: the lenses review the same draft in a new critic round.`,
    ],
  };
}
