import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { personOnlyWhy } from "@maycombhq/ai";
import { Api, assistantActor, runsDirOf, type Finding } from "@maycombhq/core";
import { changeFolder, type ChangeContext } from "@maycombhq/changes";
import { assistantOf, readRound, roundsOf, stageGateOf } from "@maycombhq/naysayer";
import {
  acceptableStageRule,
  readAccepted,
  readStageLoop,
  wayOnKind,
  type Stage,
} from "@maycombhq/planner";
import type { StepRunner } from "./handoff-resume.js";

/**
 * ADR 0203 A, the app's half: a stage's own blocking findings (the built-in gate
 * `stage-<stage>`, written when a stage's run ends) as the stage's thread shows them. Each open
 * one says whether the person using the app may accept it and, if not, why, as a kind the app
 * words in its copy file; an accepted one says who, why and when, as the stages read it
 * (readAccepted: never an assistant's resolution). Accept itself is the command line's own
 * `atticus finding <change> <id> waive` (findingAction), in ui-api-thread.ts.
 */

type FindingView = Api.StageFindingViewT;

/** Who the app records as acting, and the environment it runs in. */
export interface AppPerson {
  user: string;
  env?: Record<string, string | undefined>;
}

/**
 * Why a person's act is refused here: the app runs inside a Copilot session Atticus started
 * (ATTICUS_ACP_SESSION), where the command line refuses every act a person's name is recorded
 * with (person-only.ts), in the command line's own words.
 */
export function sessionRefusal(env: Record<string, string | undefined>, change: string) {
  if (!env.ATTICUS_ACP_SESSION) return undefined;
  const why = personOnlyWhy(["finding", change, "stage-000000000000", "waive"]);
  return `This runs inside a Copilot session that Atticus started, so it is refused: ${why}. The person runs it, in the app or their own terminal.`;
}

/** The fix in words, without the command line's own way to accept it or why it can't be. */
export const stageFixWords = (text: string) =>
  text.replace(/ (?:Or accept it:|It can't be accepted:)[\s\S]*$/, "");

/** Whether the app's person may accept this open blocking stage finding, and if not, why. */
export function acceptOf(
  f: Finding,
  ctx: Pick<ChangeContext, "orgPack"> | undefined,
  who: AppPerson,
): FindingView["accept"] {
  const as = who.user;
  const no = (why: Api.StageAcceptRefusalT) => ({ can: false, why, as });
  // Rule 6 first: a constitution rule is never accepted, by anyone.
  if (f.layer === "constitution") return no("constitution");
  if (!f.waivable || !acceptableStageRule(f.rule))
    return no(wayOnKind(f.rule) ?? "next-stage-needs");
  if (who.env?.ATTICUS_ACP_SESSION) return no("assistant-session");
  if (ctx ? assistantOf(ctx, who.user) : assistantActor(who.user)) return no("assistant");
  return { can: true, as };
}

/**
 * The newest round of the stage's own gate, each finding as the thread shows it: its options
 * (a fix, a comment, Accept; never Not relevant, which the stage's next run would raise again),
 * whether it may be accepted, and its acceptance.
 */
export async function stageGateViews(
  root: string,
  change: string,
  stage: string,
  o: {
    rel: string;
    ctx: ChangeContext | undefined;
    who: AppPerson | undefined;
    comments: (file: string) => FindingView["comments"];
  },
): Promise<{ findings: FindingView[]; problems: { file: string; message: string }[] }> {
  const gate = stageGateOf(stage);
  const round = (await roundsOf(root, change, gate).catch(() => [] as number[])).at(-1);
  if (round === undefined) return { findings: [], problems: [] };
  const r = await readRound(root, change, gate, round);
  const accepted = o.ctx
    ? await readAccepted(root, change, o.ctx, [stage]).catch(() => undefined)
    : undefined;
  const byId = new Map([...(accepted?.values() ?? [])].map((a) => [a.finding, a]));
  const findings = r.findings.map((s): FindingView => {
    const f = s.finding;
    const open = f.state === "open";
    const issue = f.kind === "issue";
    const a = byId.get(f.id);
    const file = `${o.rel}/${s.path}`;
    return {
      finding: f,
      file,
      options: {
        fix: stageFixWords(f.fix.text),
        apply: open && issue,
        dismiss: false,
        waive: open && issue && f.severity === "blocking" && f.waivable,
      },
      comments: o.comments(file),
      ...(open && issue && f.severity === "blocking" && o.who
        ? { accept: acceptOf(f, o.ctx, o.who) }
        : {}),
      ...(a && !open ? { accepted: { by: a.by, why: a.why, at: a.at } } : {}),
    };
  });
  return {
    findings,
    problems: r.bad.map((b) => ({ file: `${o.rel}/${b.path}`, message: b.message })),
  };
}

/**
 * The app's own Done of a run (ui-api.ts's doneRun: the answer checked, and the step's kept
 * resume run), by server, so the accept route checks an answer again through the same function
 * as Done and the app's own check, never a copy of it.
 */
const appDones = new WeakMap<object, (runId: string) => Promise<unknown>>();
export function setAppDone(ctx: object, done: (runId: string) => Promise<unknown>): void {
  appDones.set(ctx, done);
}
export const appDoneOf = (ctx: object) => appDones.get(ctx);

/** A run's state, read off its run.json; undefined when it isn't there or doesn't read. */
async function runState(root: string, change: string, runId: string) {
  const text = await readFile(join(runsDirOf(root), change, runId, "run.json"), "utf8").catch(
    () => undefined,
  );
  try {
    return text === undefined ? undefined : (JSON.parse(text) as { state?: string }).state;
  } catch {
    return undefined;
  }
}

/**
 * ADR 0203 A (addendum 2026-11-22): after an Accept the app goes on with the stage, whoever
 * started it, so the person presses nothing else. While another open blocking finding or open
 * question holds the stage it doesn't (a new round would draft over what the person is still
 * deciding), but the stage's resume is kept for a prompt still with the assistant. Otherwise it
 * runs the stage's step as Start the next round does (prepareStep): a draft handed in and not yet
 * read in is read in, a stage that stopped is run again (done with no new draft when nothing else
 * blocks), and the stage's resume is kept for the run it waits on, so the app finishes the run
 * once its answer passes. An answer that failed its checks is checked again at once, by Done.
 */
export async function goOnAfterAccept(
  root: string,
  change: string,
  stage: Stage,
  thread: Api.StageThreadViewT,
  o: { runStep: StepRunner; done?: (runId: string) => Promise<unknown> },
): Promise<Api.StageAcceptThenT> {
  if (thread.state === "done") return { kind: "done" };
  const held = thread.items.filter(
    (i) =>
      (i.kind === "finding" &&
        i.view.finding.state === "open" &&
        i.view.finding.severity === "blocking") ||
      (i.kind === "question" && i.question.state === "open"),
  ).length;
  const dir = changeFolder(root, change);
  const before = await readStageLoop(dir, change, stage).catch(() => undefined);
  const waitedOn = before?.present && before.loop.state === "waiting" ? before.loop.run : undefined;
  const was = waitedOn ? await runState(root, change, waitedOn) : undefined;
  // A prompt still with the assistant, or an answer to fix: going on only keeps its resume.
  const withAssistant = was === "waiting" || was === "prepared" || was === "failed";
  if (held && !withAssistant) return { kind: "held", held };
  const { prepareStep } = await import("./handoff-resume.js");
  let lines: string[];
  try {
    lines = (await prepareStep(root, o.runStep, thread.step)).prepared.lines;
  } catch (e) {
    return { kind: "not-resumed", lines: [(e as Error).message] };
  }
  if (held) return { kind: "held", held };
  if (waitedOn && was === "failed" && o.done) await o.done(waitedOn).catch(() => undefined);
  const after = await readStageLoop(dir, change, stage).catch(() => undefined);
  const said = lines.length ? { lines } : {};
  if (!after?.present) return { kind: "not-resumed", ...said };
  const state = after.loop.state;
  if (state === "done") return { kind: "done", ...said };
  if (state === "questions") return { kind: "questions", ...said };
  if (state === "stopped") return { kind: "stopped", ...said };
  const run = state === "waiting" ? after.loop.run : undefined;
  if (!run) return { kind: "not-resumed", ...said };
  if (run !== waitedOn) return { kind: "drafting", runId: run, ...said };
  return (await runState(root, change, run)) === "failed"
    ? { kind: "failed", runId: run, ...said }
    : { kind: "waiting", runId: run, ...said };
}
