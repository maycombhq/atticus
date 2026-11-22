import { HandoffRuntime, ToolError, type AiRequest, type ToolBox } from "@maycombhq/ai";
import { changeFolder } from "@maycombhq/changes";
import { acceptableStageRule, readAccepted, writeStageGate, type Accepted } from "./accept.js";
import { architectureStage, TARGET_DIR } from "./architecture.js";
import { featureStage } from "./feature.js";
import { issueFingerprint, readStageLoop, type StageIssue } from "./loop.js";
import type { LoopFinding, Stage } from "./schema.js";
import { smallStage } from "./small.js";
import { storiesStage } from "./stories.js";
import { rerunOf } from "./waiting.js";

/**
 * The drafter checks its own draft (ADR 0087 addendum, W3a). A stage's checks were right, but a
 * drafter that couldn't see them spent a whole draft on each failure: in 20 runs over two real
 * changes, neither reached stories without a person who could read the planner's code. So the
 * same deterministic checks the stage runs on an answer run on a draft's text before it is handed
 * in: as the `check_draft` tool in model mode, `atticus stage check` for headless Claude Code, and
 * in `atticus handoff done` for a hand-off. Nothing is written; no model is asked.
 */

/** The tool's name, as the model calls it. */
export const CHECK_DRAFT_TOOL = "check_draft";

/** The stage whose drafter writes an answer file, by the file's name. */
export function stageOfOutput(output: string): Stage | undefined {
  const m = /^(feature|architecture|stories|small)-answer\.yaml$/.exec(output);
  return m ? (m[1] as Stage) : undefined;
}

/**
 * The stage's checks on a draft's text: its reader's problems and its checks' blocking findings,
 * as the loop would hand them back. Runs the stage with nothing drafted and nothing written (the
 * whole lists, so no retrieval asks a model), and no judge (a hand-off runtime is never called).
 */
export async function checkStageDraft(
  root: string,
  change: string,
  stage: Stage,
  text: string,
): Promise<StageIssue[]> {
  return (await stageDraftIssues(root, change, stage, text)).filter((i) => i.blocking);
}

/**
 * Every finding the stage's checks make of a draft's text, blocking or not: one a person accepted
 * is there, no longer blocking, so a gate written from them keeps the acceptance.
 */
export async function stageDraftIssues(
  root: string,
  change: string,
  stage: Stage,
  text: string,
): Promise<StageIssue[]> {
  const o = {
    runtime: new HandoffRuntime({ root, validate: async () => [] }),
    checkDraft: text,
    context: { engine: false },
  };
  const r =
    stage === "feature"
      ? await featureStage(root, change, o)
      : stage === "architecture"
        ? await architectureStage(root, change, o)
        : stage === "stories"
          ? await storiesStage(root, change, o)
          : await smallStage(root, change, o);
  return r.checked ?? [];
}

/**
 * ADR 0203 A (addendum 2026-11-22): a hand-off draft goes to a person, not back to its drafter,
 * when it has a blocking finding and every blocking finding is one a person may accept
 * (ACCEPTABLE_STAGE_RULES). Only a person can say the map is behind; another draft can't.
 */
export const draftForAPerson = (issues: readonly Pick<StageIssue, "rule" | "blocking">[]) =>
  issues.some((i) => i.blocking) && issues.every((i) => !i.blocking || acceptableStageRule(i.rule));

/** Each stage's source in the change folder, when its loop file doesn't say. */
const STAGE_SOURCE: Record<Stage, string> = {
  feature: "feature.yaml",
  architecture: `${TARGET_DIR}/`,
  stories: "stage/stories-answer.yaml",
  small: "stage/small-answer.yaml",
};

/**
 * ADR 0203 A (addendum 2026-11-22): `atticus handoff done` writes a draft's findings on the
 * stage's own gate at once, as the stage does when its run ends, so a person may accept them
 * before the stage reads the draft in. `issues` are the draft's, blocking or not (an accepted one
 * keeps its file). Returns the blocking ones with the id each has on the gate.
 */
export async function recordDraftFindings(
  root: string,
  change: string,
  stage: Stage,
  issues: StageIssue[],
  now: string,
): Promise<{ id: string; rule: string; message: string }[]> {
  const { loop } = await readStageLoop(changeFolder(root, change), change, stage);
  const accepted = await readAccepted(root, change).catch(() => new Map<string, Accepted>());
  const findings: LoopFinding[] = issues.map((i) => ({
    fingerprint: issueFingerprint(i.rule, i.target, i.evidence ?? ""),
    rule: i.rule,
    target: i.target,
    ...(i.evidence ? { evidence: i.evidence } : {}),
    message: i.message,
    blocking: i.blocking,
    source: "stage",
    seenIn: [],
  }));
  const written = await writeStageGate(root, findings, accepted, {
    change,
    stage,
    source: loop.source ?? STAGE_SOURCE[stage],
    rerun: rerunOf(stage, change),
    now,
  });
  const ids = new Map(written.findings.map((s) => [s.finding.id.slice(0, 18), s.finding.id]));
  return findings
    .filter((f) => f.blocking)
    .map((f) => ({
      id: ids.get(`stage-${f.fingerprint}`) ?? `stage-${f.fingerprint}`,
      rule: f.rule,
      message: f.message,
    }));
}

/** The problems in a few short lines a small model can act on: each with its line, when known. */
export function formatDraftProblems(issues: StageIssue[]): string {
  if (!issues.length) return "The stage's checks find nothing to fix: hand the draft in.";
  const n = issues.length;
  return [
    `The stage's checks found ${n === 1 ? "1 problem" : `${n} problems`} in your draft:`,
    ...issues.slice(0, 12).map((i) => `- ${i.line ? `line ${i.line}: ` : ""}${i.message}`),
    ...(n > 12 ? [`- and ${n - 12} more`] : []),
    `Fix ${n === 1 ? "it" : "them"} in the file, then check again.`,
  ].join("\n");
}

/**
 * The `check_draft` tool for a stage's draft request (model mode), or none for any other
 * request. Each call counts against the run's tool rounds, as the context tools do; after the
 * request's self-check limit it says to hand the answer in as it is.
 */
export function draftCheckBox(root: string, request: AiRequest): ToolBox | undefined {
  const stage = stageOfOutput(request.outputPath);
  if (!request.selfCheck || !stage) return undefined;
  const limit = request.selfCheck.limit;
  let used = 0;
  return {
    definitions: [
      {
        name: CHECK_DRAFT_TOOL,
        description:
          "Check your draft the way the stage will: give your whole answer, as YAML. Returns each problem with its line and what is allowed, or that it is clean. Call it before you answer, and again after each fix, until it is clean.",
        inputSchema: {
          type: "object",
          properties: { draft: { type: "string", description: "Your whole answer, as YAML." } },
          required: ["draft"],
        },
      },
    ],
    async call(name, input) {
      if (name !== CHECK_DRAFT_TOOL) throw new ToolError(`There is no tool ${name}.`);
      const text = typeof input.draft === "string" ? input.draft : "";
      if (!text.trim()) throw new ToolError("Give your whole answer under draft.");
      if (used >= limit)
        return `You have used the ${limit} checks a draft may have: hand your answer in as it is.`;
      used++;
      return formatDraftProblems(await checkStageDraft(root, request.change, stage, text));
    },
  };
}

/** Two tool boxes as one: the context tools and the draft's own check. */
export function withTools(a: ToolBox | undefined, b: ToolBox | undefined): ToolBox | undefined {
  if (!a) return b;
  if (!b) return a;
  const own = new Set(b.definitions.map((d) => d.name));
  return {
    definitions: [...a.definitions.filter((d) => !own.has(d.name)), ...b.definitions],
    call: (name, input) => (own.has(name) ? b.call(name, input) : a.call(name, input)),
  };
}
