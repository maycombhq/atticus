import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Api, changesRelOf, readQuestion, type Finding, type Question } from "@maycombhq/core";
import { changeFolder, loadChangeContext } from "@maycombhq/changes";
import {
  readProposals,
  readRound,
  reviewedGates,
  roundsOf,
  type StoredFinding,
} from "@maycombhq/naysayer";
import {
  commentOnFinding,
  PlannerError,
  readStageLoop,
  rerunOf,
  STAGE_PHASE,
  stageComments,
  stageGate,
  type StageCommentRecord,
} from "@maycombhq/planner";
import {
  badRequest,
  conflict,
  HttpError,
  notFound,
  type Router,
  type ServerContext,
} from "@maycombhq/server";

/**
 * A stage tab's findings with their options and a comment box (ADR 0124 addendum D-app, B10,
 * C4 2.23.0). GET /api/changes/{id}/stages/{stage} gives the critic's findings of the stage's
 * gate (its latest round), each with the options it allows (the fix's one action, not relevant,
 * waive where the rule allows it, a knowledge gap's question to its owner) and the comments on
 * it, the stage's own questions, and the stage's command. The options are acted on through
 * POST /api/findings/{change}/{finding}/action, as `atticus finding` does. POST .../comments
 * writes a person's comment as a question they answered, listed in the stage's loop file, so
 * the stage's next run hands it to the drafter (`commentOnFinding`). The app runs no stage and
 * no git: it shows both commands.
 */

type Tab = Api.StageReviewViewT["stage"];
type FindingView = Api.StageFindingViewT;

const ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** What a person may do with a finding, by the rules the finding's schema holds it to. */
export function findingOptions(f: Finding): FindingView["options"] {
  const open = f.state === "open";
  const issue = f.kind === "issue";
  return {
    fix: f.fix.text,
    apply: open && issue,
    dismiss: open && issue,
    waive: open && issue && f.severity === "blocking" && f.waivable,
    ...(open && f.question ? { ask: { text: f.question.text, owner: f.question.owner } } : {}),
  };
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

const slashOf = (stage: Tab, change: string) => `/atticus-${stage} ${change}`;

async function gateOf(root: string, change: string, stage: Tab) {
  const problems: { file: string; message: string }[] = [];
  let gate: string | undefined;
  try {
    gate = stageGate(await loadChangeContext(root), stage);
  } catch (e) {
    problems.push({
      file: "org-pack",
      message: `The org pack doesn't load, so the stage's gate isn't known: ${String((e as Error).message ?? e).split("\n")[0]}`,
    });
  }
  // No gate for the phase in gates.yaml: the review folder named for the phase, if there is one.
  if (!gate && (await reviewedGates(root, change)).includes(STAGE_PHASE[stage]))
    gate = STAGE_PHASE[stage];
  return { gate, problems };
}

async function latest(root: string, change: string, gate: string | undefined) {
  if (!gate) return { round: null, findings: [] as StoredFinding[], bad: [] };
  const rounds = await roundsOf(root, change, gate);
  const round = rounds.at(-1);
  if (round === undefined) return { round: null, findings: [] as StoredFinding[], bad: [] };
  const r = await readRound(root, change, gate, round);
  return { round, findings: r.findings, bad: r.bad };
}

const view = (
  c: StageCommentRecord,
): Api.StageReviewViewT["findings"][number]["comments"][number] => ({
  question: c.question,
  text: c.text,
  by: c.by,
  at: c.at,
  read: c.read,
});

export async function stageReviewView(
  root: string,
  change: string,
  stage: Tab,
): Promise<Api.StageReviewViewT> {
  const rel = `${changesRelOf(root)}/${change}`;
  const { gate, problems } = await gateOf(root, change, stage);
  const l = await latest(root, change, gate);
  for (const b of l.bad) problems.push({ file: `${rel}/${b.path}`, message: b.message });
  const comments = await stageComments(root, change, stage);
  const { loop, present, file } = await readStageLoop(changeFolder(root, change), change, stage);
  const order = { blocking: 0, gap: 1, risk: 2, idea: 3 } as const;
  // What an assistant proposed, waiting on a person (ADR 0115 addendum, 2026-10-25).
  const proposals =
    gate && l.round !== null ? await readProposals(root, change, gate, l.round) : [];
  const findings = l.findings
    .map((s) => {
      const fileRel = `${rel}/${s.path}`;
      const p =
        s.finding.state === "open" ? proposals.find((x) => x.finding === s.finding.id) : undefined;
      return {
        finding: s.finding,
        file: fileRel,
        options: findingOptions(s.finding),
        comments: comments.comments.filter((c) => c.about === fileRel).map(view),
        ...(p
          ? {
              proposal: {
                claim: p.claim,
                by: p.by,
                at: p.at,
                ...(p.reason ? { reason: p.reason } : {}),
              },
            }
          : {}),
      };
    })
    .sort(
      (a, b) =>
        Number(a.finding.state !== "open") - Number(b.finding.state !== "open") ||
        order[a.finding.severity] - order[b.finding.severity] ||
        a.finding.id.localeCompare(b.finding.id),
    );
  const questions: Question[] = [];
  for (const id of comments.others) {
    const q = await readQuestion(root, id).catch((e: unknown) => {
      problems.push({ file: `questions/${id}.yaml`, message: String((e as Error).message ?? e) });
      return undefined;
    });
    if (q && q.state !== "retired") questions.push(q);
  }
  questions.sort((a, b) => Number(a.state !== "open") - Number(b.state !== "open"));
  return {
    change,
    stage,
    gate: gate ?? null,
    round: l.round,
    loop: {
      file: `${rel}/${file}`,
      present,
      ...(present ? { state: loop.state, iteration: loop.iteration } : {}),
    },
    findings,
    questions,
    next: { command: rerunOf(stage, change), slash: slashOf(stage, change) },
    problems,
  };
}

function tabOf(v: string): Tab {
  const r = Api.StageTab.safeParse(v);
  if (!r.success)
    throw badRequest(`${JSON.stringify(v)} isn't a stage: feature, architecture or stories.`);
  return r.data;
}

export function uiStageRoutes(
  r: Router,
  ctx: ServerContext,
  deps: { now?: () => Date } = {},
): Router {
  const now = deps.now ?? (() => new Date());
  const changeOf = async (v: string) => {
    if (!ID.test(v)) throw badRequest(`${JSON.stringify(v)} isn't a change id.`);
    if (!(await exists(join(changeFolder(ctx.root, v), "change.yaml"))))
      throw notFound(`There is no change ${v}.`);
    return v;
  };
  return r
    .add("GET", "/api/changes/{changeId}/stages/{stage}", async ({ params }) => {
      const stage = tabOf(params.stage!);
      const change = await changeOf(params.changeId!);
      return { status: 200, body: await stageReviewView(ctx.root, change, stage) };
    })
    .add("POST", "/api/changes/{changeId}/stages/{stage}/comments", async ({ params, body }) => {
      const stage = tabOf(params.stage!);
      const change = await changeOf(params.changeId!);
      const b = Api.StageCommentRequest.safeParse(body ?? {});
      if (!b.success)
        throw badRequest("Say which finding and write the comment: { finding, text }.", {
          errors: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      const v = await stageReviewView(ctx.root, change, stage);
      const hits = v.findings.filter(
        (f) => f.finding.id === b.data.finding && (!b.data.gate || f.finding.gate === b.data.gate),
      );
      if (!hits.length)
        throw notFound(
          `The ${stage} stage of ${change} has no finding ${b.data.finding} in ${v.gate ? `the ${v.gate} gate's latest round` : "any gate"}.`,
        );
      const f = hits[0]!;
      let written;
      try {
        written = await commentOnFinding(ctx.root, {
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
          at: now().toISOString(),
        });
      } catch (e) {
        if (e instanceof PlannerError && e.code === "refused") throw conflict(e.message);
        if (e instanceof PlannerError) throw new HttpError(422, "Atticus refused", e.message);
        throw e;
      }
      for (const p of written.files) ctx.events.publish({ type: "file.changed", path: p });
      const q = written.question;
      const result: Api.StageCommentResultT = {
        comment: {
          question: q.id,
          text: q.answer!.text!,
          by: q.answer!.by,
          at: q.answer!.at,
          read: false,
        },
        files: written.files,
        commit: `git add ${written.files.join(" ")} && git commit -m "${change}: a comment on ${f.finding.id}"`,
        next: v.next,
      };
      return { status: 200, body: result };
    });
}
