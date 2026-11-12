import { stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { Api, ChangeArtifact, changesRelOf, runsRelOf } from "@maycombhq/core";
import {
  artifactWritten,
  changeFolder,
  loadChangeContext,
  personWrittenPlanning,
} from "@maycombhq/changes";
import {
  commentOnFinding,
  keepDroppedQuestion,
  PlannerError,
  readCorrections,
  readStageLoop,
  replyInStage,
  stageGate,
  threadReplies,
  type Stage,
} from "@maycombhq/planner";
import {
  badRequest,
  conflict,
  HttpError,
  notFound,
  type Router,
  type ServerContext,
} from "@maycombhq/server";
import { checkedByApp } from "./handoff-autodone.js";
import { missingChangeWords } from "./change-problems.js";
import { allRuns, answerOf, item, type Stored } from "./runs-view.js";
import { stageReviewView } from "./ui-api-stages.js";

/**
 * ADR 0189: a stage is one conversation. GET /api/changes/{id}/stages/{stage}/thread assembles a
 * stage's thread from what is on file: its runs (each prompt handed to the person's assistant,
 * the answer and what its checks said, and whether the app checked it when it arrived), the
 * critic's latest round with each finding's options and comments, the stage's questions, the
 * person's replies and corrections, and the questions the assistant raised that couldn't be
 * kept. No store of its own: the proposal step's replies are listed in its small thread file.
 * POST .../thread writes a reply, a comment on a finding, or keeps a dropped question, each
 * through the mechanism that already carries a person's words to the next round. The thread is a
 * view: the AI runs where it ran (the person's editor, unattended Copilot, a server model).
 */

type ThreadStage = Api.ThreadStageT;
type Item = Api.ThreadItemT;

const ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** The agent that drafts each stage. */
export const STAGE_AGENT: Record<ThreadStage, string> = {
  proposal: "change-drafter",
  feature: "feature-placer",
  architecture: "flow-architect",
  stories: "story-writer-flows",
  small: "small-change-planner",
};
const DRAFTERS = new Map(Object.entries(STAGE_AGENT).map(([s, a]) => [a, s as ThreadStage]));
const isLens = (agent: string) => agent === "critic-lenses" || /^[a-z]+-critic$/.test(agent);

/** The step's words, as the app prepares it (POST /api/runs/handoff). */
export const stageStep = (stage: ThreadStage, change: string): string[] =>
  stage === "proposal"
    ? ["change", "draft", change]
    : stage === "stories"
      ? ["plan", "stories", change]
      : ["change", stage, change];

const agentOf = (s: Stored) => {
  const a = s.run.request.agent as unknown as string | { id: string };
  return typeof a === "string" ? a : a.id;
};

/**
 * The runs of a stage: its drafter's, and the critic's lenses that came after one of its drafts
 * and before any other stage's next draft (a lens reviews the draft just before it).
 */
export function stageRuns(all: Stored[], stage: ThreadStage): Stored[] {
  const sorted = [...all].sort(
    (a, b) =>
      a.run.startedAt.localeCompare(b.run.startedAt) || a.run.runId.localeCompare(b.run.runId),
  );
  const out: Stored[] = [];
  let current: ThreadStage | undefined;
  for (const s of sorted) {
    const agent = agentOf(s);
    const of = DRAFTERS.get(agent);
    if (of) current = of;
    if (of === stage || (isLens(agent) && current === stage)) out.push(s);
  }
  return out;
}

/** An answer in a few lines: what a YAML answer holds, else its first lines. */
export function answerSummary(text: string): string[] {
  const body = text.replace(/^\s*```(?:ya?ml)?\s*\n/, "").replace(/\n```\s*$/, "\n");
  try {
    const y = parse(body) as unknown;
    if (y && typeof y === "object" && !Array.isArray(y)) {
      const out: string[] = [];
      for (const [k, v] of Object.entries(y as Record<string, unknown>)) {
        if (Array.isArray(v)) {
          if (v.length) out.push(`${k}: ${v.length}`);
        } else if (typeof v === "string" && v.trim() && v.length <= 120)
          out.push(`${k}: ${v.trim()}`);
        if (out.length >= 8) break;
      }
      if (out.length) return out;
    }
  } catch {
    // not YAML: its first lines
  }
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("<!--"))
    .slice(0, 6);
}

const fileTime = (p: string) =>
  stat(p).then(
    (s) => s.mtime.toISOString(),
    () => undefined,
  );

/** The app's editor's address for a finding's file, when it is one artifact's file. */
function editOf(
  artifact: string,
  line: number | undefined,
): { artifact: string; line?: number } | undefined {
  const m = /^([a-z]+)\.md$/.exec(artifact);
  if (!m || !ChangeArtifact.safeParse(m[1]).success) return undefined;
  return { artifact: m[1]!, ...(line ? { line } : {}) };
}

export async function stageThreadView(
  root: string,
  change: string,
  stage: ThreadStage,
): Promise<Api.StageThreadViewT> {
  const rel = `${changesRelOf(root)}/${change}`;
  const dir = changeFolder(root, change);
  const problems: { file: string; message: string }[] = [];
  const items: Item[] = [];
  const runs = stageRuns(await allRuns(root, change).catch(() => []), stage);
  let waiting: Api.StageThreadViewT["waiting"];
  let lastFailed = false;
  for (const s of runs) {
    const r = s.run;
    const who = isLens(agentOf(s)) ? "critic" : "drafter";
    const listed = await item(root, s);
    items.push({
      kind: "prompt",
      at: r.startedAt,
      runId: r.runId,
      who,
      prompt: s.prompt,
      state: r.state,
      details: {
        agent: listed.agent,
        runtime: r.runtime,
        promptPath: `${runsRelOf(root)}/${change}/${r.runId}/prompt.md`,
        ...(listed.output ? { output: listed.output } : {}),
        ...(listed.promptTokens !== undefined ? { promptTokens: listed.promptTokens } : {}),
        ...(listed.model ? { model: listed.model } : {}),
        attempt: listed.attempt,
      },
    });
    if (r.state === "waiting" || r.state === "prepared") {
      if (!r.batch) waiting = { runId: r.runId, prompt: s.prompt };
      continue;
    }
    if (r.state === "cancelled") continue;
    const answer = await answerOf(root, s);
    const passed = r.state === "validated";
    if (who === "drafter") lastFailed = r.state === "failed";
    items.push({
      kind: "answer",
      at: r.finishedAt ?? r.startedAt,
      runId: r.runId,
      who,
      checked: passed ? "passed" : r.state === "failed" ? "failed" : "checking",
      ...(r.state === "validated" || r.state === "failed"
        ? {
            by: (await checkedByApp(root, change, r.runId))
              ? ("app" as const)
              : ("person" as const),
          }
        : {}),
      summary: answer !== undefined ? answerSummary(answer) : [],
      problems: r.errors ?? [],
    });
  }
  let state: Api.StageThreadViewT["state"] = runs.length ? "drafting" : "not-started";
  let replyOpen = stage === "proposal";
  let replyWhy: string | undefined;
  if (stage !== "proposal") {
    const loopStage = stage as Stage;
    const { loop, present } = await readStageLoop(dir, change, loopStage);
    replyOpen = present;
    if (!present)
      replyWhy = `The ${stage} stage hasn't run for ${change} yet: start it, then reply to its assistant here.`;
    if (present) state = loop.state === "waiting" ? "waiting" : loop.state;
    // The critic's latest round at the stage's gate, its findings with their options, and the
    // stage's own questions (as the stage tab showed them, ADR 0124 addendum D-app).
    const review = await stageReviewView(root, change, loopStage as Api.StageReviewViewT["stage"]);
    problems.push(...review.problems);
    const writes = new Set(Object.keys(loop.written ?? {}));
    const source = loop.source;
    for (const f of review.findings) {
      const at =
        f.finding.createdAt ?? (await fileTime(join(root, ...f.file.split("/")))) ?? loop.updatedAt;
      const art = f.finding.artifact;
      const assistantWrites =
        writes.has(art) ||
        (!!source && (art === source || art.startsWith(`${source.replace(/\/$/, "")}/`)));
      const edit = assistantWrites ? undefined : editOf(art, f.finding.locator.line);
      items.push({ kind: "finding", at, view: f, assistantWrites, ...(edit ? { edit } : {}) });
    }
    for (const q of review.questions)
      items.push({ kind: "question", at: q.askedBy.at, question: q });
    for (const f of review.findings)
      for (const c of f.comments)
        items.push({
          kind: "reply",
          at: c.at,
          text: c.text,
          by: c.by,
          read: c.read,
          about: f.finding.id,
        });
    for (const d of loop.dropped ?? [])
      items.push({
        kind: "dropped",
        at: d.at,
        key: d.key,
        question: d.question,
        evidence: d.evidence,
        ...(d.nearest ? { nearest: d.nearest } : {}),
      });
    for (const c of (await readCorrections(dir, change).catch(() => [])).filter(
      (x) => x.stage === loopStage,
    ))
      items.push({
        kind: "correction",
        at: c.at,
        text: c.text,
        label: c.label,
        by: c.by,
        state: c.state,
      });
    if (present && Object.keys(loop.written ?? {}).length)
      items.push({
        kind: "changed",
        at: loop.updatedAt,
        files: Object.keys(loop.written ?? {})
          .sort()
          .map((f) => `${rel}/${f}`),
      });
    // App-only audit: findings at another gate are said, never a quiet "0 open" here.
    try {
      const ctx = await loadChangeContext(root);
      const own = stageGate(ctx, loopStage);
      const elsewhere = review.gate && own && review.gate !== own ? review.gate : undefined;
      if (elsewhere)
        items.push({
          kind: "note",
          at: loop.updatedAt,
          text: `These findings are the ${elsewhere} gate's.`,
        });
    } catch {
      // the gate is said by the review's own problems
    }
  }
  for (const r of await threadReplies(root, change, stage))
    items.push({ kind: "reply", at: r.at, text: r.text, by: r.by, read: r.read });
  items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  if (waiting) state = "waiting";
  // Beta.27: a proposal written outside the app (by hand, or before the app drafted proposals)
  // is written, as the change's page says (artifactWritten, the check All changes reads): its
  // conversation is empty, not "hasn't started", and Start would only write it again.
  const writtenElsewhere =
    stage === "proposal" &&
    state === "not-started" &&
    (await artifactWritten(root, change, "proposal").catch(() => false));
  if (writtenElsewhere) state = "done";
  // Beta.27 review: stories a person wrote are the stage's work done by hand, as the plan gate and
  // the next step read them (personWrittenPlanning, the stage's own refusal): never "hasn't
  // started" with a Start the stage would refuse.
  const byPerson =
    stage === "stories" && state === "not-started" ? await personWrittenPlanning(dir) : [];
  if (byPerson.length) {
    state = "done";
    replyWhy = `A person wrote ${change}'s planning files outside the app, so no assistant waits for a reply: draft the stories again to start one.`;
  }
  const open = items.filter((i) => i.kind === "finding" && i.view.finding.state === "open").length;
  const questions = items.filter(
    (i) => i.kind === "question" && i.question.state === "open",
  ).length;
  const dropped = items.filter((i) => i.kind === "dropped").length;
  const waitingWho = waiting
    ? runs.find((s) => s.run.runId === waiting!.runId && isLens(agentOf(s)))
      ? "critic"
      : "drafter"
    : undefined;
  const headline = writtenElsewhere
    ? `The proposal is written (${rel}/proposal.md): it was written outside the app, so this conversation has nothing in it.`
    : byPerson.length
      ? `A person wrote ${byPerson.join(" and ").replace(/ and (?=.* and )/g, ", ")} outside the app, so the stories stage never ran and this conversation has nothing in it. The change goes on from them; to have the stage write them instead, draft the stories again (it replaces them).`
      : state === "not-started"
        ? `The ${stage} stage hasn't started for this change. Start it: Atticus writes the prompt for your assistant.`
        : waiting
          ? waitingWho === "critic"
            ? "The critic's prompt below waits for your assistant. Paste it in; the app checks the answer as soon as the file is written."
            : "The prompt below waits for your assistant. Paste it in; the app checks the answer as soon as the file is written."
          : lastFailed
            ? "Your assistant's last answer didn't pass its checks: the problems are below. Tell the assistant, or fix the file and the app checks it again."
            : state === "questions"
              ? `The stage waits on ${questions === 1 ? "the question" : `${questions} questions`} below.`
              : state === "stopped"
                ? "The stage stopped: its assistant couldn't fix what was found. Fix the file it names, or tell the assistant."
                : state === "done"
                  ? `The stage is done${open ? `, with ${open} open finding${open === 1 ? "" : "s"}` : ""}.`
                  : "Ready for the next round: tell the assistant what to change, or start the round.";
  if (dropped)
    items.push({
      kind: "note",
      at: items.at(-1)?.at ?? new Date(0).toISOString(),
      text: `${dropped} question${dropped === 1 ? "" : "s"} couldn't be kept: ${dropped === 1 ? "its line didn't" : "their lines didn't"} match.`,
    });
  return {
    change,
    stage,
    state,
    headline,
    items,
    ...(waiting ? { waiting } : {}),
    step: stageStep(stage, change),
    ...(byPerson.length ? { byPerson } : {}),
    reply: { open: replyOpen, ...(replyWhy ? { why: replyWhy } : {}) },
    problems,
  };
}

function stageOf(v: string): ThreadStage {
  const r = Api.ThreadStage.safeParse(v);
  if (!r.success)
    throw badRequest(`${JSON.stringify(v)} isn't a stage: ${Api.THREAD_STAGES.join(", ")}.`);
  return r.data;
}

export function uiThreadRoutes(
  r: Router,
  ctx: ServerContext,
  deps: { now?: () => Date } = {},
): Router {
  const now = deps.now ?? (() => new Date());
  const changeOf = async (v: string) => {
    if (!ID.test(v)) throw badRequest(`${JSON.stringify(v)} isn't a change id.`);
    if (!(await stat(join(changeFolder(ctx.root, v), "change.yaml")).catch(() => undefined)))
      throw notFound(await missingChangeWords(ctx.root, v));
    return v;
  };
  const refused = (e: unknown): never => {
    if (e instanceof PlannerError && e.code === "refused") throw conflict(e.message);
    if (e instanceof PlannerError) throw new HttpError(422, "Atticus refused", e.message);
    throw e;
  };
  return r
    .add("GET", "/api/changes/{changeId}/stages/{stage}/thread", async ({ params }) => {
      const stage = stageOf(params.stage!);
      const change = await changeOf(params.changeId!);
      return { status: 200, body: await stageThreadView(ctx.root, change, stage) };
    })
    .add("POST", "/api/changes/{changeId}/stages/{stage}/thread", async ({ params, body }) => {
      const stage = stageOf(params.stage!);
      const change = await changeOf(params.changeId!);
      const b = Api.StageThreadPost.safeParse(body ?? {});
      if (!b.success)
        throw badRequest(
          "Say what to write: { kind: reply, text }, { kind: finding, finding, text } or { kind: keep, key }.",
          { errors: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
        );
      const at = now().toISOString();
      let files: string[] = [];
      try {
        if (b.data.kind === "reply")
          files = (
            await replyInStage(ctx.root, { change, stage, text: b.data.text, by: ctx.user, at })
          ).files;
        else {
          if (stage === "proposal" || stage === "small")
            throw badRequest(`The ${stage} step's thread takes replies only.`);
          if (b.data.kind === "keep")
            files = (
              await keepDroppedQuestion(ctx.root, {
                change,
                stage,
                key: b.data.key,
                by: ctx.user,
                at,
              })
            ).files;
          else {
            const finding = b.data.finding;
            const gate = b.data.gate;
            const v = await stageReviewView(ctx.root, change, stage);
            const f = v.findings.find(
              (x) => x.finding.id === finding && (!gate || x.finding.gate === gate),
            );
            if (!f)
              throw notFound(
                `The ${stage} stage of ${change} has no finding ${finding} to reply to.`,
              );
            files = (
              await commentOnFinding(ctx.root, {
                change,
                stage,
                finding: {
                  id: f.finding.id,
                  rule: f.finding.rule,
                  summary: f.finding.summary,
                  artifact: f.finding.artifact,
                  ...(f.finding.locator.line ? { line: f.finding.locator.line } : {}),
                  file: f.file,
                },
                text: b.data.text,
                by: ctx.user,
                at,
              })
            ).files;
          }
        }
      } catch (e) {
        refused(e);
      }
      for (const p of files) ctx.events.publish({ type: "file.changed", path: p });
      const body2: Api.StageThreadPostResultT = {
        files,
        thread: await stageThreadView(ctx.root, change, stage),
      };
      return { status: 200, body: body2 };
    });
}
