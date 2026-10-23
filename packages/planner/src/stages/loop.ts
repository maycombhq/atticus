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
  fingerprint as criticFingerprint,
  runCritic,
  writeQuarantineItems,
} from "@maycombhq/naysayer";
import type { ChangeLifecycle } from "@maycombhq/core";
import { PlannerError } from "../errors.js";
import type { ContextOptions, ContextReport } from "../engine.js";
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
 * runtime; the stage's own checks and a critic round (its rules, and its AI lenses when the
 * runtime can run them) review the draft; findings go back for another draft, with no cap on
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
  /** The stage's deterministic checks of a parsed answer. */
  check(answer: A): Promise<StageIssue[]>;
  /** Write the answer's files into the change folder; change-folder-relative paths. */
  write(answer: A): Promise<string[]>;
  /** The stage's result as it is in the change folder now, for a rerun with nothing to draft. */
  current(): Promise<A | undefined>;
  /** The questions the assistant raised in its answer. */
  questions?(answer: A): QuestionDraft[];
}

export interface StageOptions {
  runtime: AiRuntime;
  /**
   * The runtime for the critic's AI lenses. Default: the stage's runtime, except hand-off,
   * where the lenses wait for `atticus critic --resume` and the loop runs the critic's rules.
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
  waiting?: { runId: string };
  /** The command that opens the stage's PR, once it is done. */
  pr?: string;
  notes: string[];
  runs: RunSummary[];
  /** What the stage sent as context: selected (and what was left out), or the whole lists (ADR 0107). */
  context?: ContextReport;
}

const loopRel = (stage: Stage) => `stage/${stage}.yaml`;

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

  // A stage waiting for a person stays stopped until the questions are answered.
  if (!o.resume && loop.state === "questions") {
    const open = (await questionsOf(loop.questions)).filter((q) => q.state === "open");
    if (open.length) return result("questions");
  }
  if (!o.resume && loop.state === "waiting" && loop.run) {
    notes.push(`The draft is still with your assistant (run ${loop.run}).`);
    return result("waiting", { waiting: { runId: loop.run } });
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
      issues = (await spec.check(cur)).filter((i) => i.blocking);
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
        issues = (await criticRound(root, ctx, change, spec.stage, o, loop, notes, kindOf)).filter(
          (i) => i.blocking,
        );
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

  let resume = o.resume;
  for (;;) {
    // ---- draft
    const answered = (await questionsOf(loop.questions)).filter((q) => q.state === "answered");
    const decided = new Set(answered.map((q) => q.id));
    const fix = issues.filter((i) => i.blocking);
    const sources: SourceInput[] = [
      {
        id: "instructions",
        kind: "instruction",
        origin: "atticus",
        text: instructionsWith(spec.instructions, fix, answered),
        classification: "public",
        trusted: true,
      },
      ...spec.sources,
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
    let run: Run;
    if (resume) {
      run = await o.runtime.result(resume);
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
      run = await o.runtime.run(prepared.runId);
    }
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
    const n = loop.iteration;
    loop.read = [...new Set([...loop.read, ...answered.map((q) => q.id)])].sort();

    // ---- check
    let answer: A | undefined;
    const found: StageIssue[] = [];
    let files: string[] = [];
    if (run.output === undefined || run.state === "failed" || run.state === "cancelled")
      found.push({
        rule: "stage.no-answer",
        target: spec.stage,
        message: `The assistant gave no answer (${run.state}${run.errors.length ? `: ${run.errors.join("; ")}` : ""}).`,
        blocking: true,
      });
    else {
      const p = spec.parse(run.output);
      found.push(...p.issues);
      answer = p.answer;
      if (answer !== undefined) {
        found.push(...(await spec.check(answer)));
        files = await spec.write(answer);
      }
    }
    // ---- the critic, on every iteration
    if (answer !== undefined)
      found.push(...(await criticRound(root, ctx, change, spec.stage, o, loop, notes, kindOf)));

    // ---- fingerprints and the end rule
    const toAsk: { f: LoopFinding; issue: StageIssue }[] = [];
    const toStop: LoopFinding[] = [];
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

    const drafted: QuestionDraft[] = [];
    const evidenceFor = async (e: string | undefined) =>
      e && (await lineExists(root, e)) ? e : `${rel}/${loopRel(spec.stage)}:1`;
    for (const { f, issue } of toAsk)
      drafted.push({
        question: `${f.seenIn.at(-2)! < n - 1 ? "This came back after a draft had fixed it" : "Three drafts in a row had this problem"}: ${issue.message} What should the ${spec.stage} say?`,
        options: [],
        evidence: [await evidenceFor(f.evidence)],
        scope: "repo",
      });
    const own = answer !== undefined && spec.questions ? spec.questions(answer) : [];
    for (const q of own) {
      const ok: string[] = [];
      for (const e of q.evidence) if (await lineExists(root, e)) ok.push(e);
      if (ok.length) drafted.push({ ...q, evidence: ok });
      else
        notes.push(
          `Left out the assistant's question "${q.question}": none of its evidence (${q.evidence.join(", ")}) is a line in the metarepo.`,
        );
    }
    if (drafted.length) {
      const raised = await raiseQuestions(root, drafted, {
        step: `change-${spec.stage}`,
        repo: toAsk[0]?.issue.repo ?? change.id,
        command: rerunOf(spec.stage, change.id),
        rerun: rerunOf(spec.stage, change.id),
        ...(run.runId ? { run: run.runId } : {}),
        at,
      });
      const qs = [...raised.raised, ...raised.known];
      for (const { f } of toAsk) {
        const q = qs.find((x) => x.question.includes(f.message.slice(0, 40)));
        if (q) f.question = q.id;
      }
      loop.questions = [...new Set([...loop.questions, ...qs.map((q) => q.id)])].sort();
    }

    // ---- stop, or go round again
    const open = (await questionsOf(loop.questions)).filter((q) => q.state === "open");
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

function instructionsWith(base: string, fix: StageIssue[], answered: Question[]): string {
  const out = [base];
  if (fix.length)
    out.push(
      "",
      "Your last draft had these problems. Fix every one; a problem that comes back unchanged goes to a person:",
      ...fix.map((i) => `- ${i.message}${i.evidence ? ` (${i.evidence})` : ""}`),
    );
  if (answered.length)
    out.push(
      "",
      "People answered these questions. Follow their answers:",
      ...answered.map((q) => `- ${q.question} Answer: ${answerWords(q) ?? ""}`),
    );
  return out.join("\n");
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

/**
 * One critic round at the stage's gate: its rules, and its AI lenses when the runtime can run
 * them here. Open blocking findings come back as issues, fingerprinted by the critic's own
 * fingerprint, so an unchanged finding is the same finding in every round.
 */
async function criticRound(
  root: string,
  ctx: ChangeContext,
  change: ChangeLifecycle,
  stage: Stage,
  o: StageOptions,
  loop: StageLoop,
  notes: string[],
  kindOf: (f: { rule: string; kind: "issue" | "knowledge-gap" }) => Promise<FindingKind>,
): Promise<StageIssue[]> {
  const gate = stageGate(ctx, stage);
  if (!gate) {
    notes.push(`No gate in gates.yaml is for the ${STAGE_PHASE[stage]} phase, so no critic ran.`);
    return [];
  }
  const lensRuntime =
    o.criticRuntime === null
      ? undefined
      : (o.criticRuntime ?? (o.runtime.kind === "hand-off" ? undefined : o.runtime));
  if (!lensRuntime && o.criticRuntime === undefined && o.runtime.kind === "hand-off")
    notes.push(
      `The critic ran its rules at the ${gate} gate; its AI lenses run with /atticus-critic ${change.id} (atticus critic ${change.id} --mode hand-off) before the stage's PR.`,
    );
  try {
    const r = await runCritic(root, change.id, {
      gate,
      ...(lensRuntime ? { runtime: lensRuntime } : {}),
      now: (o.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    loop.critic = [...loop.critic, { gate, round: r.round }];
    const rel = `${changesRelOf(root)}/${change.id}`;
    const open = r.findings.filter(
      (f) => f.finding.state === "open" && f.finding.severity === "blocking",
    );
    const out: StageIssue[] = [];
    for (const f of open)
      out.push({
        rule: `critic:${f.finding.rule}`,
        target: criticFingerprint(f.finding),
        evidence: `${rel}/${f.finding.artifact}${f.finding.locator.line ? `:${f.finding.locator.line}` : ""}`,
        message: `The critic (${f.finding.rule}): ${f.finding.summary}`,
        blocking: true,
        kind: await kindOf(f.finding),
      });
    return out;
  } catch (e) {
    notes.push(`The critic didn't run at the ${gate} gate: ${(e as Error).message}`);
    return [];
  }
}
