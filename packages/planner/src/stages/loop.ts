import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  AgentDefinition,
  answerWords,
  changesRelOf,
  raiseQuestions,
  readQuestion,
  retrievalOf,
  runsDirOf,
  toCanonicalYaml,
  type HeldQuestion,
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
  checkFindings,
  checkStage,
  loadChangeContext,
  phaseGates,
  stageCommand,
  writeFileAtomic,
  type ChangeContext,
} from "@maycombhq/changes";
import {
  checkRoundRule,
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
import type { ChangeLifecycle, RunRetrieval } from "@maycombhq/core";
import { PlannerError } from "../errors.js";
import { citeFiles } from "./cite.js";
import { unfence, YAML_QUOTE_RULE } from "./answer.js";
import { questionsOnFile, stepJudges } from "./questions-on-file.js";
import type { ContextOptions, ContextReport, RetrievalAi } from "../engine.js";
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
  /** The answer isn't YAML at all (S5): handed back to the drafter once, spending no draft. */
  syntax?: boolean;
  /** The line of the answer it is at, when it is about the answer's text (S5). */
  line?: number;
  /**
   * A doubt the drafter gets once more, with its reason, before it becomes a person's question
   * (U3, the way the answered-by hold works).
   */
  holdOnce?: boolean;
  /** Words to find in the stage's files, for the line a question about it cites (U3). */
  locateText?: string;
  /** What a judge refused, kept on the finding so a person's answer settles exactly that (V1). */
  judged?: { field: string; criterion: string; task: string }[];
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
  /** What in the stage's files doesn't read, as "path: problem" (a file current() left out). */
  currentProblems?(): Promise<string[]>;
  /** Where in the stage's files a finding is, as metarepo path:line, when it can be pointed at. */
  locate?(issue: StageIssue): Promise<string | undefined>;
  /** The questions the assistant raised in its answer. */
  questions?(answer: A): QuestionDraft[];
  /**
   * Data the critic's lenses get with the draft, worked out from the answer (S3): the target
   * flows merged with today's, numbered in their final order. Data, never instructions.
   */
  reviewSources?(answer: A): SourceInput[];
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
  /** How the stage's context was retrieved, when a model helped (ADR 0116): in its run record. */
  retrieval?: RunRetrieval;
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
  /**
   * Check this text as the stage's answer and stop (W3a): its reader's and checks' problems come
   * back in `checked`; nothing is drafted, written or kept.
   */
  checkDraft?: string;
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
  /**
   * A stop for questions that also ended on drafting findings the assistant kept getting wrong:
   * those findings, and the file a person may fix instead. One stop, one end report (stageEnd).
   */
  stopped?: {
    source: string;
    findings: { rule: string; message: string; evidence?: string }[];
  };
  /** The result is a person's edit, checked as the stage's draft (P1). */
  byPerson?: boolean;
  /** With `checkDraft`: what the stage's reader and checks found in the text (W3a). */
  checked?: StageIssue[];
  /** Questions due that this stop didn't ask, over the change policy's questionsPerStop (U3). */
  moreQuestions?: number;
  /**
   * The files this run changed on disk, of those it wrote (`files`): a write whose hashes match
   * what was there is no change ("kept your target flows").
   */
  changed?: string[];
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

/**
 * A stage's loop file (`stage/<stage>.yaml`) and whether it is there, for what reads or adds to it
 * outside a run: the app's stage tab and a person's comment on a finding (ADR 0124 addendum D-app).
 */
export async function readStageLoop(
  dir: string,
  change: string,
  stage: Stage,
): Promise<{ loop: StageLoop; present: boolean; file: string }> {
  const present = await stat(join(dir, loopRel(stage))).then(
    (s) => s.isFile(),
    () => false,
  );
  return { loop: await readLoop(dir, change, stage), present, file: loopRel(stage) };
}

/** Write a stage's loop file as the loop does. */
export const writeStageLoop = (dir: string, l: StageLoop): Promise<void> => writeLoop(dir, l);

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
/** The states past design, where the change's own code is being built or is out. */
const BUILT: ReadonlySet<string> = new Set([
  "build",
  "qa",
  "release-ready",
  "released",
  "post-release-review",
  "archived",
]);

export const stagePr = (change: string) => `atticus change handoff ${change} --approve`;

/**
 * Refuse a stage while an earlier stage of the path isn't finished (ADR 0087, ADR 0115
 * addendum): each stage reads what the one before wrote, so the earlier stage's loop must be
 * done and nothing may block its gate (an open knowledge gap waits for its owner and doesn't). A stage may still run before the earlier phase's hand-off PR
 * merges (the stage says so); a merged hand-off means a person approved that gate. An earlier
 * stage that never ran here (its file written by a person, or the change-draft path) is the
 * earlier stage's own check: the later stage refuses when its input is missing.
 */
export async function refuseWhileEarlierStuck(
  root: string,
  ctx: ChangeContext,
  change: ChangeLifecycle,
  stage: Stage,
): Promise<void> {
  const path = ctx.policy.stages;
  const at = path.findIndex((x) => x.stage === stage);
  if (at < 1) return;
  const dir = changeFolder(root, change.id);
  for (const earlier of path.slice(0, at)) {
    if (change.handoffs.some((h) => h.phase === earlier.phase && h.state === "merged")) continue;
    const ran = await readFile(join(dir, ...earlier.loop.split("/"))).then(
      () => true,
      () => false,
    );
    if (!ran) continue;
    const gate = phaseGates(ctx, earlier.phase)[0];
    const why = (await checkStage(root, change, earlier)).map((r) => r.message);
    // What stops the gate: an open blocking finding, a lens not in or that didn't review. A
    // knowledge gap waits for its owner's answer and doesn't hold the next stage up.
    if (gate)
      why.push(
        ...(await checkFindings(root, change, [gate]))
          .filter((r) => r.code !== "open-gap")
          .map((r) => r.message),
      );
    if (!why.length) continue;
    throw new PlannerError(
      "refused",
      [
        `The ${stage} stage can't run yet: the ${earlier.stage} stage isn't finished${gate ? ` at the ${gate} gate` : ""}. ${why[0]}`,
        ...why.slice(1).map((w) => `  - ${w}`),
        `Each stage reads what the one before wrote: finish the ${earlier.stage} stage (${stageCommand(earlier, change.id)}${gate ? `; atticus findings ${change.id} shows the ${gate} gate's findings` : ""}), then run ${rerunOf(stage, change.id)}.`,
      ].join("\n"),
    );
  }
}

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
  // W3a: each draft checks itself with the stage's checks before it is handed in.
  const selfCheck = {
    command: `atticus stage check ${change.id} ${spec.stage}`,
    limit: ctx.policy.draftSelfChecks,
  };
  // W3a: a draft's self-check runs the stage's reader and checks on its text, and nothing else.
  if (o.checkDraft !== undefined) {
    const p = spec.parse(o.checkDraft);
    const checked = [...p.issues, ...(p.answer !== undefined ? await spec.check(p.answer) : [])];
    return {
      change: change.id,
      stage: spec.stage,
      state: "waiting",
      iteration: 0,
      drafts: 0,
      findings: [],
      questions: [],
      files: [],
      notes: [],
      runs: [],
      checked,
    };
  }
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
  /** The files this run's writes changed on disk. */
  const changed = new Set<string>();

  let checks: Map<string, string> | undefined;
  const kindOf = async (f: { rule: string; kind: "issue" | "knowledge-gap" }) =>
    criticFindingKind(f, (checks ??= await criticRuleChecks(root).catch(() => new Map())));

  const questionsOf = async (ids: string[]) =>
    (await Promise.all(ids.map((id) => readQuestion(root, id).catch(() => undefined)))).filter(
      (q): q is Question => !!q,
    );
  // The drafting findings the last draft stopped on, while questions are open too (A2).
  const stoppedOn = () =>
    loop.findings.filter((f) => f.stoppedAt === loop.iteration && f.kind === "drafting");
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
      changed: [...changed].sort(),
      ...(state === "done" ? { pr: stagePr(change.id) } : {}),
      ...(state === "questions" && stoppedOn().length
        ? {
            stopped: {
              source: `${rel}/${loop.failedAnswer ?? spec.source}`,
              findings: stoppedOn().map((f) => ({
                rule: f.rule,
                message: f.message,
                ...(f.evidence ? { evidence: f.evidence } : {}),
              })),
            },
          }
        : {}),
      ...extra,
    };
  };

  // A critic round waiting for its AI lenses: the stage waits for the first one (ADR 0115).
  const handedToLens = async (
    w: LensWait,
    draft: {
      draft?: string;
      by?: "person";
      files: string[];
      issues: StageIssue[];
      questions?: QuestionDraft[];
    },
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

  // What the lenses read with the draft: the drafter's sources and what the stage works out (S3).
  const reviewSources = (a: A | undefined): SourceInput[] => [
    ...spec.sources,
    ...(a !== undefined && spec.reviewSources ? spec.reviewSources(a) : []),
  ];
  // Every write of the stage's files keeps their hashes, so a person's edit is a fact (P1).
  const write = async (a: A): Promise<string[]> => {
    // What was on disk before, so a write that changes nothing says so.
    const before = await hashFiles(dir, [
      ...new Set([...Object.keys(loop.written ?? {}), ...(await sourceFiles(dir, spec.source))]),
    ]);
    const files = await spec.write(a);
    loop.written = await hashFiles(dir, [
      ...new Set([...files, ...(await sourceFiles(dir, spec.source))]),
    ]);
    for (const f of files) if (before[f] !== loop.written[f]) changed.add(f);
    // An answer that read was written: a copy of one that didn't is no longer the stage's (S5).
    if (loop.failedAnswer) {
      if (loop.failedAnswer !== spec.source)
        await rm(join(dir, ...loop.failedAnswer.split("/")), { force: true });
      delete loop.failedAnswer;
    }
    return files;
  };
  // A stop on a person's own draft: what still fails, with file and line; never drafted over.
  const personStop = async (
    edited: string[],
    kept: string,
    failing: StageIssue[],
    problems: string[],
    by: "check" | "critic",
  ): Promise<never> => {
    const lines: string[] = [];
    for (const p of problems) lines.push(`  - ${rel}/${p}`);
    for (const i of failing) {
      const where = (await spec.locate?.(i)) ?? i.evidence ?? `${rel}/${spec.source}`;
      lines.push(`  - ${i.message} (rule ${i.rule.replace(/^critic:/, "")}; at ${where})`);
    }
    const n = failing.length + problems.length;
    lines.push(
      `Fix ${n === 1 ? "it" : "them"} in your files and run ${rerunOf(spec.stage, change.id)} again: Atticus checks your files again and never drafts over them. A copy of your files as they are now is in ${kept}. To have your assistant draft again from your edited files instead, run ${rerunOf(spec.stage, change.id)} --force; it starts from your files.`,
    );
    return stopNow(
      `The ${spec.stage} stage checked your edit of ${edited.map((f) => `${rel}/${f}`).join(", ")} as its draft${by === "critic" ? ", and the critic found" : ", and found"} ${n === 1 ? "a problem" : `${n} problems`}; it stopped rather than draft over your work.`,
      lines,
    );
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
    // A draft whose self-check failed (handoff done listed its problems) is still being fixed (W3a).
    const out = ["waiting", "prepared", "produced", "unreadable", "failed"];
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

  // ---- a person's edit of the stage's files (P1). Which files differ from what Atticus last
  // wrote is a fact (their hashes). The person's version is the stage's answer: it is checked
  // and reviewed as their draft, and never drafted over unless they ask (--force) or answered a
  // question since, and then the assistant starts from their files. A copy is kept first.
  let personDraft: string | undefined;
  const unreadAnswers = (await questionsOf(loop.questions)).filter(
    (q) => q.state === "answered" && !loop.read.includes(q.id),
  );
  const edited =
    !o.resume && !carried && loop.state !== "waiting" && loop.iteration > 0
      ? await editedFiles(dir, loop, spec.source)
      : [];
  if (edited.length) {
    const kept = await keepFiles(dir, rel, spec.stage, loop.iteration + 1, edited);
    if (o.force || unreadAnswers.length) {
      personDraft = await draftText(dir, edited);
      (loop.byPerson ??= []).push({
        iteration: loop.iteration + 1,
        at,
        files: edited,
        kept,
        how: "redrafted",
      });
      notes.push(
        `A person edited ${edited.join(", ")}; a copy is in ${kept}, and your assistant drafts again from those files${o.force ? " (--force)" : ", with the answers"}.`,
      );
    } else {
      loop.iteration++;
      (loop.byPerson ??= []).push({
        iteration: loop.iteration,
        at,
        files: edited,
        kept,
        how: "checked",
      });
      let cur: A | undefined = await spec.current();
      let problems = (await spec.currentProblems?.()) ?? [];
      // S6: the answer a person fixed is their draft. The file the stop named (a copy of the
      // answer that didn't read), or the stage's answer file when its result was never written,
      // is read as the model's answer is, and gets the same checks.
      const answerFile =
        loop.failedAnswer && edited.includes(loop.failedAnswer)
          ? loop.failedAnswer
          : cur === undefined && !spec.source.endsWith("/") && edited.includes(spec.source)
            ? spec.source
            : undefined;
      if (answerFile) {
        const text = await readFile(join(dir, ...answerFile.split("/")), "utf8").catch(
          () => undefined,
        );
        if (text !== undefined) {
          const p = spec.parse(text);
          const bad = p.issues.filter((i) => i.blocking);
          if (p.answer !== undefined && !bad.length) {
            cur = p.answer;
            problems = [];
          } else
            problems = bad.map(
              (i) =>
                `${answerFile}:${i.line ?? 1}: ${i.message.replace(/^In your answer at line \d+: /, "")}`,
            );
        }
      }
      // Never "nothing in it reads": a stage that can't take the edit says how to go on.
      if (cur === undefined && !problems.length)
        await stopNow(
          `The ${spec.stage} stage can't take your edit of ${edited.map((f) => `${rel}/${f}`).join(", ")} as its draft: there is no answer in it to check.`,
          [
            `Run ${rerunOf(spec.stage, change.id)} --force to have your assistant draft again from your files; a copy of them is in ${kept}.`,
          ],
        );
      const failing = cur === undefined ? [] : (await spec.check(cur)).filter((i) => i.blocking);
      if (cur === undefined || problems.length || failing.length)
        await personStop(edited, kept, failing, problems, "check");
      notes.push(
        `Checked your edit of ${edited.join(", ")} as the ${spec.stage} stage's draft (a copy is in ${kept}).`,
      );
      const files = await write(cur!);
      const c = await criticRound(root, ctx, change, spec, o, loop, notes, kindOf, {
        files,
        sources: reviewSources(cur!),
      });
      if (c.stop) await stopNow(c.stop.message, c.stop.lines);
      if (c.waiting)
        return handedToLens(
          c.waiting,
          { by: "person", files, issues: [] },
          { files, answer: cur! },
        );
      const blocking = c.issues.filter((i) => i.blocking);
      if (blocking.length) await personStop(edited, kept, blocking, [], "critic");
      loop.state = "done";
      loop.updatedAt = at;
      await writeLoop(dir, loop);
      return result("done", { files, answer: cur!, byPerson: true });
    }
  }

  // Issues to hand back with the next draft. A stop for questions that also ended on drafting
  // findings hands those back with the answers, so the next draft fixes them too (A2).
  let issues: StageIssue[] =
    !o.resume && loop.state === "questions"
      ? stoppedOn().map((f) => ({
          rule: f.rule,
          target: f.target,
          ...(f.evidence ? { evidence: f.evidence } : {}),
          message: f.message,
          blocking: true,
        }))
      : [];
  // Nothing new to draft: a person's answers all read, the result on file, no --force. Check it
  // again without AI; draft only if the check finds something.
  const answers = await questionsOf(loop.questions);
  const unread = answers.filter((q) => q.state === "answered" && !loop.read.includes(q.id));
  if (!o.resume && !o.force && loop.state === "done" && unread.length === 0) {
    const cur = await spec.current();
    if (cur !== undefined) {
      issues = (await spec.check(cur, { onFile: true })).filter((i) => i.blocking);
      // Past design, the change's own code is what moves today's flow: a design that was built
      // isn't drafted again because a rescan reads the code it led to. Before build, a moved
      // flow means the step numbers may point at other steps, so it is drafted again.
      if (BUILT.has(change.state))
        issues = issues.filter((i) => {
          if (i.rule !== "delta.stale") return true;
          notes.push(
            `Today's flow ${i.target} changed since this design; the change is in ${change.state}, so the design stays as it was.`,
          );
          return false;
        });
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
        const files = await write(cur);
        const c = await criticRound(root, ctx, change, spec, o, loop, notes, kindOf, {
          files,
          sources: reviewSources(cur),
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
    let reviewed: QuestionDraft[] | undefined;
    /** This draft's answer, when it didn't read (S5). */
    let failedOutput: string | undefined;
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
      // The lenses of a checking round past the gate's limit found something: a person decides.
      if (
        lenses.issues.some((i) => i.blocking) &&
        (await readRoundMeta(root, change.id, review.gate, review.round))?.checkRound
      ) {
        const stop = checkRoundStop(spec.stage, change.id, review.gate, review.round, [
          ...review.issues,
          ...lenses.issues,
        ]);
        await stopNow(stop.message, stop.lines);
      }
      // A person's draft the lenses blocked goes back to that person, never to a redraft (P1).
      const blockingLens = [...review.issues, ...lenses.issues].filter((i) => i.blocking);
      if (review.by === "person" && blockingLens.length) {
        const mine = loop.byPerson?.at(-1);
        await personStop(mine?.files ?? review.files, mine?.kept ?? "", blockingLens, [], "critic");
      }
      delete loop.review;
      delete loop.run;
      answered = (await questionsOf(loop.questions)).filter((q) => q.state === "answered");
      if (review.draft) run = await o.runtime.result(review.draft).catch(() => undefined);
      answer = await spec.current();
      files = review.files;
      found.push(...review.issues, ...lenses.issues);
      reviewed = review.questions;
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
          text: [
            instructionsWith(spec.instructions, fix, answered),
            ...(personDraft
              ? [
                  "",
                  `A person edited the stage's files; the "${PERSON_DRAFT}" data block holds them as they are now. Start from them: keep every change the person made, and change only what the problems and answers need.`,
                ]
              : []),
          ].join("\n"),
          classification: "public",
          trusted: true,
        },
        // A person's edited files, given as the current draft (P1): data, never instructions.
        ...(personDraft
          ? [
              {
                id: PERSON_DRAFT,
                kind: "artifact" as const,
                origin: "the stage's files as a person edited them",
                text: personDraft,
                classification: "internal",
                priority: 990,
              },
            ]
          : []),
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
          selfCheck,
          outputIn: "run",
          ...(spec.retrieval ? { retrieval: spec.retrieval } : {}),
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
      // S5: an answer that isn't YAML at all goes back to the drafter once, with its line and how
      // to quote, before it counts as a draft (the lens read-again of naysayer's ai.ts). Its
      // answer stands as the draft, whatever it is: once only.
      const wasReadAgain = loop.readAgain !== undefined && loop.readAgain === run.runId;
      delete loop.readAgain;
      const slip =
        !wasReadAgain && run.output !== undefined && run.state !== "failed"
          ? spec.parse(citeFiles(run.output, sources)).issues.find((i) => i.syntax)
          : undefined;
      if (slip) {
        const again = await o.runtime.prepare({
          change: change.id,
          agent,
          pack: buildContextPack({
            change: change.id,
            agent: agent.id,
            budget: agent.tokenBudget,
            sources: [
              ...sources,
              {
                id: "0-read-again",
                kind: "instruction",
                origin: "atticus",
                text: READ_AGAIN_RULE,
                classification: "public",
                trusted: true,
              },
              // The problem quotes the model's own line, so it goes as data with the answer.
              {
                id: "last-answer",
                kind: "artifact",
                origin: "your last answer, which isn't YAML",
                text: `The problem: ${slip.message}\n\nYour last answer:\n${unfence(run.output!)}`,
                classification: "internal",
                priority: 995,
              },
            ],
            levels,
            maxClassification: levels.includes("internal") ? "internal" : levels[0]!,
            now,
            step: `${spec.stage === "stories" ? "plan" : "change"} ${spec.stage} ${change.id} (read again)`,
          }),
          outputPath: spec.output,
          selfCheck,
          outputIn: "run",
        });
        const second = await o.runtime.run(again.runId);
        runs.push(toRunSummary(second));
        if (second.state === "waiting" || second.state === "prepared") {
          loop.state = "waiting";
          loop.run = second.runId;
          loop.readAgain = second.runId;
          loop.updatedAt = at;
          await writeLoop(dir, loop);
          notes.push(
            `Your assistant's answer isn't YAML; it is handed back once to be written again, without counting as a draft (run ${second.runId}).`,
          );
          return result("waiting", { waiting: { runId: second.runId } });
        }
        if (second.output !== undefined && second.state !== "failed") run = second;
      }
      delete loop.run;
      drafts++;
      personDraft = undefined;
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
        // Kept to copy into the change folder if the loop stops on it (S5).
        if (answer === undefined) failedOutput = unfence(run.output);
        if (answer !== undefined) {
          found.push(...(await spec.check(answer)));
          files = await write(answer);
        }
      }
      // ---- the critic, on each draft that passes the stage's own checks: its rules and its AI
      // lenses (ADR 0115). A draft with a blocking finding of its own goes back first, using no
      // critic round (a gate's round limit counts reviews of drafts worth reviewing).
      if (answer !== undefined && !found.some((i) => i.blocking)) {
        const c = await criticRound(root, ctx, change, spec, o, loop, notes, kindOf, {
          files,
          sources: reviewSources(answer),
        });
        if (c.stop) await stopNow(c.stop.message, c.stop.lines);
        if (c.waiting)
          return handedToLens(
            c.waiting,
            {
              draft: run.runId,
              files,
              issues: found,
              // The draft's questions wait with it: the stage's file doesn't keep them.
              ...(answer !== undefined && spec.questions?.(answer).length
                ? { questions: spec.questions(answer) }
                : {}),
            },
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
      if (i.judged?.length) f.judged = i.judged;
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
    // U3: a doubt the drafter gets once more, with its reason, before a person is asked.
    const doubts = new Set(loop.handedBack ?? []);
    let heldDoubts = 0;
    for (const { f, issue } of toAsk) {
      if (issue.holdOnce && !doubts.has(f.fingerprint)) {
        loop.handedBack = [...new Set([...(loop.handedBack ?? []), f.fingerprint])].sort();
        heldDoubts++;
        continue;
      }
      // The line the question is about: the stage's files, where the check can point at it.
      const at = issue.locateText ? await spec.locate?.(issue) : undefined;
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
          evidence: [at && (await lineExists(root, at)) ? at : await evidenceFor(f.evidence)],
          scope: "repo",
        },
      });
    }
    if (heldDoubts)
      notes.push(
        `Handed back ${heldDoubts === 1 ? "a doubt" : `${heldDoubts} doubts`} to your assistant once more, with the judge's reason, before asking a person.`,
      );
    // A draft read back after its lenses: its questions waited with it (the file has none).
    const own = reviewed ?? (answer !== undefined && spec.questions ? spec.questions(answer) : []);
    for (const q of own) {
      const ok: string[] = [];
      for (const e of q.evidence) if (await lineExists(root, e)) ok.push(e);
      if (ok.length) drafted.push({ repo: change.id, q: { ...q, evidence: ok } });
      else
        notes.push(
          `Left out the assistant's question "${q.question}": none of its evidence (${q.evidence.join(", ")}) is a line in the metarepo.`,
        );
    }
    // A question an answer on file may decide, that nothing settled: handed back to the drafter
    // once, with the answer, rather than put to the person again (ADR 0117 addendum).
    const held: HeldQuestion[] = [];
    // U3: at most the change policy's questionsPerStop go to a person at one stop; the rest wait
    // as findings, handed back with the next draft and asked once these are answered.
    const cap = ctx.policy.questionsPerStop;
    const waitingMore = Math.max(0, drafted.length - cap);
    if (waitingMore) drafted.splice(cap);
    if (drafted.length) {
      const qs: Question[] = [];
      const judges = stepJudges(root, o.runtime, change.id, now);
      const handedBack = new Set(loop.handedBack ?? []);
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
          { ...judges, hold: (q) => !handedBack.has(q.id) },
        );
        held.push(...raised.held);
        for (const [i, a] of raised.decidedBy)
          notes.push(
            `Your assistant asked again what ${a.id} answered ("${mine[i]!.q.question.trim()}"); the stage reads ${a.answer?.by ?? "the person"}'s answer instead of asking again.`,
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
    let open = (await questionsOf(loop.questions)).filter((q) => q.state === "open");
    // The stage waits for a person anyway: what was held back goes to them too, with the rest.
    const heldIssues: StageIssue[] = [];
    if (held.length && open.length) {
      for (const repo of [...new Set(held.map((h) => h.question.repo))]) {
        const r = await raiseQuestions(
          root,
          held.filter((h) => h.question.repo === repo).map((h) => h.draft),
          {
            step: `change-${spec.stage}`,
            repo,
            command: rerunOf(spec.stage, change.id),
            rerun: rerunOf(spec.stage, change.id),
            ...(run?.runId ? { run: run.runId } : {}),
            at,
          },
          stepJudges(root, o.runtime, change.id, now),
        );
        loop.questions = [
          ...new Set([...loop.questions, ...[...r.raised, ...r.known].map((q) => q.id)]),
        ].sort();
      }
      open = (await questionsOf(loop.questions)).filter((q) => q.state === "open");
    } else if (held.length) {
      loop.handedBack = [
        ...new Set([...(loop.handedBack ?? []), ...held.map((h) => h.question.id)]),
      ].sort();
      for (const h of held) heldIssues.push(askedAnswered(h));
      notes.push(
        `Handed back ${held.length === 1 ? "a question" : `${held.length} questions`} that a person's answer on file may already decide, rather than ask them again.`,
      );
      await writeLoop(dir, loop);
    }
    // S5: a stop on an answer that didn't read copies it where the stop says to fix it, keeping
    // the stage's answer that read aside when it is the same file. Lines are the answer's.
    const keepFailed = async (): Promise<StopFile | undefined> => {
      if (failedOutput === undefined) return undefined;
      const to = failedAnswerRel(spec);
      let kept: string | undefined;
      if (to === spec.source) {
        const valid = await readFile(join(dir, ...to.split("/")), "utf8").catch(() => undefined);
        if (valid !== undefined && valid !== failedOutput) {
          await writeFileAtomic(join(dir, ...lastValidRel(spec).split("/")), valid);
          kept = `${rel}/${lastValidRel(spec)}`;
        }
      }
      await writeFileAtomic(join(dir, ...to.split("/")), failedOutput);
      loop.failedAnswer = to;
      // Recorded as Atticus wrote it, so a person's fix of it is seen as their edit (S6).
      loop.written = { ...(loop.written ?? {}), [to]: sha(failedOutput) };
      const lines = new Map(
        found
          .filter((i) => i.line)
          .map((i) => [issueFingerprint(i.rule, i.target, i.evidence ?? ""), i.line!]),
      );
      return { file: `${rel}/${to}`, ...(kept ? { lastValid: kept } : {}), lines };
    };
    if (ignored.length && !open.length) {
      for (const f of ignored) f.stoppedAt = n;
      const stop = stopMessage(spec, rel, n, ignored, rerunOf(spec.stage, change.id), {
        ...(await keepFailed().then((x) => (x ? { failed: x } : {}))),
        repeated: loop.findings,
      });
      // V1: say what is wrong: the answer asked for a change, quoted, and the draft hasn't made it.
      const said = await Promise.all(
        [...new Set(ignored.map((f) => f.question!))].map(async (id) => {
          const q = await readQuestion(root, id).catch(() => undefined);
          const w = q ? answerWords(q) : undefined;
          return w ? `${id} ("${w}")` : id;
        }),
      );
      await stopNow(
        `The ${spec.stage} stage stopped after ${n} draft${n === 1 ? "" : "s"}: a person answered ${said.join(", ")}, and your assistant's draft still doesn't make the change it asks for.`,
        stop.lines,
      );
    }
    if (toStop.length) {
      for (const f of toStop) f.stoppedAt = n;
      const failed = await keepFailed();
      const stop = stopMessage(spec, rel, n, toStop, rerunOf(spec.stage, change.id), {
        ...(failed ? { failed } : {}),
        repeated: loop.findings,
      });
      if (failed) await writeLoop(dir, loop);
      // With questions open too, the stop is one end report (stageEnd): the questions first,
      // then these findings, which the next draft is handed with the answers.
      if (!open.length) {
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
      return result("questions", {
        files,
        ...(answer !== undefined ? { answer } : {}),
        ...(waitingMore ? { moreQuestions: waitingMore } : {}),
      });
    }
    if (blocking.length === 0 && heldIssues.length === 0) {
      loop.state = "done";
      await writeLoop(dir, loop);
      return result("done", { files, ...(answer !== undefined ? { answer } : {}) });
    }
    issues = [
      ...blocking.map((f) => ({
        rule: f.rule,
        target: f.target,
        ...(f.evidence ? { evidence: f.evidence } : {}),
        message: f.message,
        blocking: true,
      })),
      ...heldIssues,
    ];
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
  findings: (Pick<LoopFinding, "message" | "rule" | "evidence"> & { fingerprint?: string })[],
  rerun: string,
  o: {
    /** The answer that didn't read, copied where a person fixes it (S5), and its lines. */
    failed?: StopFile;
    /** Every finding of the loop, for what the drafts kept failing on (S5). */
    repeated?: LoopFinding[];
  } = {},
): { message: string; lines: string[] } {
  const source = o.failed?.file ?? `${rel}/${spec.source}`;
  const one = findings.length === 1;
  const elsewhere = findings.some((f) => f.evidence && !f.evidence.startsWith(source));
  const where = (f: (typeof findings)[number]) => {
    const line = f.fingerprint ? o.failed?.lines.get(f.fingerprint) : undefined;
    return f.evidence ?? (line ? `${source}:${line}` : source);
  };
  return {
    message: `The ${spec.stage} stage stopped after ${drafts} draft${drafts === 1 ? "" : "s"}: your assistant kept getting ${one ? "this" : "these"} wrong, and ${one ? "it isn't a question" : "they aren't questions"} for a person to decide.`,
    lines: [
      ...findings.map(
        (f) => `  - ${f.message} (rule ${f.rule.replace(/^critic:/, "")}; in ${where(f)})`,
      ),
      // What else kept failing: the rules the stop names above are left out.
      ...(o.repeated
        ? repeatedFindings(o.repeated.filter((f) => !findings.some((x) => x.rule === f.rule)))
        : []),
      o.failed
        ? `Fix ${source}, the answer that doesn't read, or tell your assistant how; then run ${rerun} again. Atticus checks your fix before it drafts again.${o.failed.lastValid ? ` The last answer that read is kept in ${o.failed.lastValid}.` : ""}`
        : `Fix ${source}${elsewhere ? " (the stage writes the files above from it)" : ""}, or tell your assistant how; then run ${rerun} again. Atticus checks your fix before it drafts again.`,
    ],
  };
}

/** The copy of an answer that didn't read (S5): where it is, the answer kept aside, its lines. */
export interface StopFile {
  file: string;
  lastValid?: string;
  /** Each finding's line in the file, by fingerprint. */
  lines: Map<string, number>;
}

/**
 * What the drafts kept failing on (S5): each rule whose blocking findings were seen in two drafts
 * or more, with the drafts, how many findings, and one finding's words as the example (for the
 * judge's covers-field refusals, the criterion it refused). Counted from the loop's record.
 */
export function repeatedFindings(findings: LoopFinding[]): string[] {
  const by = new Map<string, LoopFinding[]>();
  for (const f of findings.filter((x) => x.blocking))
    by.set(f.rule, [...(by.get(f.rule) ?? []), f]);
  const rows = [...by.entries()]
    .map(([rule, fs]) => {
      const drafts = [...new Set(fs.flatMap((f) => f.seenIn))].sort((a, b) => a - b);
      const example = [...fs].sort((a, b) => b.seenIn.length - a.seenIn.length)[0]!;
      return { rule, fs, drafts, example };
    })
    .filter((r) => r.drafts.length >= 2)
    .sort((a, b) => b.drafts.length - a.drafts.length || a.rule.localeCompare(b.rule));
  if (!rows.length) return [];
  return [
    "What the drafts kept failing on:",
    ...rows.map(
      (r) =>
        `  - ${r.rule.replace(/^critic:/, "")}: in ${r.drafts.length} drafts (${r.drafts[0]} to ${r.drafts.at(-1)})${r.fs.length > 1 ? `, ${r.fs.length} findings` : ""}, for example: ${r.example.message}`,
    ),
  ];
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const STAGE_NAMES: Record<Stage, string> = {
  feature: "feature",
  architecture: "architecture",
  stories: "stories",
  small: "fast path",
};

/**
 * The one end report of a stage that stopped for a person (A2): its questions, and the drafting
 * findings it also stopped on, in that order, with one next step. Open questions come first
 * because a person's answers change the next draft; the drafting findings go to the assistant
 * with those answers, or a person fixes the stage's file instead. Empty unless state is
 * questions.
 */
export function stageEnd(r: StageResult<unknown>, rerun: string): string[] {
  if (r.state !== "questions") return [];
  const problems = r.stopped?.findings ?? [];
  const out = [
    `The ${STAGE_NAMES[r.stage]} stage stopped after ${plural(r.iteration, "draft")}: ${plural(r.questions.length, "question")} for a person to answer${problems.length ? `, and ${plural(problems.length, "problem")} your assistant kept getting wrong` : ""}.`,
    ...r.questions.map((q) => `  ${q.id}: ${q.question}`),
    ...(r.moreQuestions
      ? [
          `${r.moreQuestions} more question${r.moreQuestions === 1 ? " waits; it is" : "s wait; they are"} asked once these are answered.`,
        ]
      : []),
    `Answer each with atticus questions answer <id> --option <n> (or --text "..."), or with /atticus-answer.`,
  ];
  if (problems.length)
    out.push(
      `What your assistant kept getting wrong (not questions for a person):`,
      ...problems.map(
        (f) =>
          `  - ${f.message} (rule ${f.rule.replace(/^critic:/, "")}; in ${f.evidence ?? r.stopped!.source})`,
      ),
      `Answer the questions first, then run ${rerun} again: the next draft gets your answers and the problems above. To fix the problems yourself instead, edit ${r.stopped!.source}; Atticus checks your fix before it drafts again.`,
    );
  else out.push(`Then run ${rerun} again.`);
  return out;
}

export function rerunOf(stage: Stage, change: string): string {
  return stage === "stories"
    ? `atticus plan stories ${change}`
    : `atticus change ${stage} ${change}`;
}

/**
 * What the drafter is told when its answer isn't YAML (S5), in Atticus's words; the problem and
 * the answer go with it as data.
 */
export const READ_AGAIN_RULE = `Your last answer isn't YAML, so it doesn't count as a draft yet; the "last-answer" data block holds the problem, the line it is at, and the answer. Write the same answer again as the YAML asked for, with that line fixed: ${YAML_QUOTE_RULE}, and in a flow list such as [a, b] quote each item that holds one.`;

/** What every stage's drafter is told about checking its own draft (W3a), in Atticus's words. */
export const SELF_CHECK_RULE =
  "Check your answer with the stage's own checks before you hand it in: call the check_draft tool with your whole answer if you have it, or follow the finishing step below. Fix every problem it lists, and check again, until it says the draft is clean.";

/** Where an answer that didn't read is copied when the loop stops on it (S5). */
export const failedAnswerRel = (spec: Pick<StageSpec<unknown>, "output">) => `stage/${spec.output}`;
/** Where the stage's own answer file is kept aside when a failing answer is copied over it. */
export const lastValidRel = (spec: Pick<StageSpec<unknown>, "stage">) =>
  `stage/${spec.stage}-answer.last-valid.yaml`;

/** The data block that carries a person's edited files when the assistant drafts from them. */
export const PERSON_DRAFT = "current-draft";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** The files under a stage's source (a folder, "target-flows/", or one file), change-folder relative. */
async function sourceFiles(dir: string, source: string): Promise<string[]> {
  if (!source.endsWith("/"))
    return (await stat(join(dir, source)).then(
      (s) => s.isFile(),
      () => false,
    ))
      ? [source]
      : [];
  const sub = source.replace(/\/$/, "");
  return (await readdir(join(dir, sub)).catch(() => [] as string[]))
    .filter((f) => !f.startsWith("."))
    .sort()
    .map((f) => `${sub}/${f}`);
}

/** The sha-256 of each file as it is now; a missing file is left out. */
async function hashFiles(dir: string, files: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of [...files].sort()) {
    const b = await readFile(join(dir, ...f.split("/"))).catch(() => undefined);
    if (b) out[f] = sha(b);
  }
  return out;
}

/**
 * The stage's files a person changed since Atticus wrote them (P1): a file whose hash differs,
 * one Atticus wrote that is gone, and one under the stage's source it didn't write. A loop file
 * from before the hashes were kept has none: then a source file changed after the loop file was
 * last written is a person's edit (the loop file is written after the stage's files, always).
 */
async function editedFiles(dir: string, loop: StageLoop, source: string): Promise<string[]> {
  const on = await sourceFiles(dir, source);
  if (loop.written) {
    const now = await hashFiles(dir, [...new Set([...Object.keys(loop.written), ...on])]);
    const out = new Set<string>();
    for (const [f, h] of Object.entries(loop.written)) if (now[f] !== h) out.add(f);
    for (const f of on) if (!(f in loop.written)) out.add(f);
    return [...out].sort();
  }
  const since = await stat(join(dir, loopRel(loop.stage))).then(
    (s) => s.mtimeMs,
    () => undefined,
  );
  if (since === undefined) return [];
  const out: string[] = [];
  for (const f of on) {
    const m = await stat(join(dir, ...f.split("/"))).then(
      (s) => s.mtimeMs,
      () => 0,
    );
    if (m > since + 1000) out.push(f);
  }
  return out;
}

/** Copy a person's edited files before anything is written: stage/<stage>-by-person/<n>/. */
async function keepFiles(
  dir: string,
  rel: string,
  stage: Stage,
  n: number,
  files: string[],
): Promise<string> {
  const to = `stage/${stage}-by-person/${n}`;
  for (const f of files) {
    const from = join(dir, ...f.split("/"));
    const dest = join(dir, ...to.split("/"), ...f.split("/"));
    await mkdir(join(dest, ".."), { recursive: true });
    await copyFile(from, dest).catch(() => undefined);
  }
  return `${rel}/${to}/`;
}

/** A person's edited files as one text, each under its own path, for the next draft to start from. */
async function draftText(dir: string, files: string[]): Promise<string> {
  const out: string[] = [];
  for (const f of files) {
    const t = await readFile(join(dir, ...f.split("/")), "utf8").catch(() => undefined);
    out.push(
      `# ${f}${t === undefined ? " (deleted by the person)" : ""}`,
      ...(t === undefined ? [] : [t.replace(/\r\n/g, "\n")]),
    );
  }
  return out.join("\n");
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
      `People answered questions; the "${HAND_BACKS}" data block lists each question with its answer. Their answers are part of the brief: follow them, and never ask any of those questions again, in any words, or ask what an answer already says.`,
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

/**
 * The hand-back for a question held back (ADR 0117 addendum): the answered questions that may
 * already decide it, with their answers. The words quote people and the model, so the message
 * goes in the hand-backs data block, never the instructions.
 */
function askedAnswered(h: HeldQuestion): StageIssue {
  const answers = h.answered
    .map((a) => `${a.id} "${a.question.trim()}", answered: "${answerWords(a) ?? ""}"`)
    .join("; ");
  return {
    rule: "stage.asks-answered",
    target: h.question.id,
    message: `Your question "${h.question.question.trim()}" may ask again what a person already answered: ${answers}. That answer is part of the brief: follow it and leave the question out. If it decides your question, give sameAs with verdict answered and the answer's words; if it leaves something open, ask only that, with sameAs verdict narrower.`,
    blocking: true,
    kind: "drafting",
  };
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
  const issues = await criticIssues(root, change.id, r.findings, kindOf);
  // A checking round past the limit reviewed what a person did: what it finds goes to a person,
  // not to another draft no round is left to review (ADR 0115 addendum).
  if (r.checkRound && issues.some((i) => i.blocking))
    return { issues, stop: checkRoundStop(spec.stage, change.id, gate, r.round, issues) };
  return { issues };
}

/** The stop when a checking round past a gate's limit finds something blocking: a person decides. */
function checkRoundStop(
  stage: Stage,
  change: string,
  gate: string,
  round: number,
  issues: StageIssue[],
): { message: string; lines: string[] } {
  const blocking = issues.filter((i) => i.blocking);
  return {
    message: `The ${stage} stage stopped: round ${round} at the ${gate} gate, the checking round past its limit, found ${blocking.length === 1 ? "a blocking finding" : `${blocking.length} blocking findings`} in what was done. A person decides now.`,
    lines: [
      ...blocking.map((i) => `  - ${i.message}${i.evidence ? ` (${i.evidence})` : ""}`),
      `See atticus findings ${change}. Fix each by hand and apply it, waive it with a reason, or dismiss it as not relevant; once every one is acted on, ${checkRoundRule(round)}: run ${rerunOf(stage, change)} again. Or return the change.`,
    ],
  };
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

/**
 * The stage's model, for its retrieval's expansion and rerank (ADR 0116): its runtime and the run
 * it was resumed with, the org pack's switches and classification levels.
 */
export function stageRetrievalAi(ctx: ChangeContext, o: StageOptions, step: string): RetrievalAi {
  const r = retrievalOf(ctx.orgPack.runtime);
  return {
    runtime: o.runtime,
    ...(o.resume ? { resume: o.resume } : {}),
    now: o.now ?? new Date(),
    levels: ctx.orgPack.pack?.classification ?? [
      "public",
      "internal",
      "confidential",
      "restricted",
    ],
    settings: { expansion: r.expansion, rerank: r.rerank },
    step,
  };
}

/** A stage waiting on its retrieval's hand-off (the expansion or the rerank, ADR 0116). */
export function retrievalWaiting<A>(
  change: string,
  stage: Stage,
  w: { waiting: { runId: string }; summary: RunSummary },
): StageResult<A> {
  return {
    change,
    stage,
    state: "waiting",
    iteration: 0,
    drafts: 0,
    findings: [],
    questions: [],
    files: [],
    notes: [
      `Your assistant first reads what the change is about, for its context (run ${w.waiting.runId}).`,
    ],
    runs: [w.summary],
    waiting: w.waiting,
  };
}

/** The stage's options without the resumed run, once its retrieval read that run in. */
export const withoutResume = (o: StageOptions): StageOptions => {
  const { resume: _r, ...rest } = o;
  return rest;
};
