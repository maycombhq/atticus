import { Api, loadOrgPack, orgPackDirOf, readersOn, runsRelOf } from "@maycombhq/core";
import {
  badRequest,
  conflict,
  HttpError,
  notFound,
  type Router,
  type ServerContext,
} from "@maycombhq/server";
import { correctDecision, decisionsView, DecideError, undoBatch } from "./ai-decide.js";
import { captured, type LocalJob } from "./ui-api-steps.js";

/**
 * ADR 0181 (C4 2.76.0): the AI's decisions in the app. GET /api/decisions is what every
 * "Detected by AI" chip, the three-way counts, the batches with Undo and Home's pause read; POST
 * /api/decisions/correct is the person's correction with "Apply to similar" (preview first);
 * POST /api/decisions/batches/{batchId}/undo undoes one batch. The app's user is the person.
 */

const BATCH = /^b-\d{8}-\d{6}-[0-9a-f]{6}$/;

function fail(e: unknown): never {
  if (e instanceof DecideError) {
    if (e.code === "not-found") throw notFound(e.message);
    if (e.code === "conflict") throw conflict(e.message);
    if (e.code === "refused") throw new HttpError(422, "Atticus can't do that", e.message);
    throw badRequest(e.message);
  }
  throw e;
}

export function uiDecisionRoutes(
  r: Router,
  ctx: ServerContext,
  deps: { now?: () => Date } = {},
): Router {
  const now = () => deps.now?.() ?? new Date();
  return (
    r
      .add("GET", "/api/decisions", async () => ({
        status: 200,
        body: await decisionsView(ctx.root),
      }))
      .add("POST", "/api/decisions/correct", async ({ body }) => {
        const b = Api.CorrectDecisionRequest.safeParse(body ?? {});
        if (!b.success)
          throw badRequest(
            "Say the item and the right answer: { item, option } for a question, { item, api, repo } or { item, none: true } for a pairing.",
            {
              errors: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
            },
          );
        let out: Api.CorrectDecisionResultT;
        try {
          out = await correctDecision(ctx.root, b.data, { by: ctx.user, now: now() });
        } catch (e) {
          fail(e);
        }
        if (out.written)
          for (const path of out.files) ctx.events.publish({ type: "file.changed", path });
        return { status: 200, body: out };
      })
      // Ninth UX walk (ADR 0181): Ask AI to propose answers, handed to the person's assistant as an
      // Atticus hand-off run; its Done (POST /api/runs/{runId}/done) decides from the proposals.
      .add("GET", "/api/propose-answers", async () => {
        const { openDecideRun, PROPOSE_CHANGE } = await import("./decide-handoff.js");
        const run = await openDecideRun(ctx.root, PROPOSE_CHANGE);
        const body: Api.QuestionsProposeViewT = run
          ? {
              state: "waiting",
              run: run.runId,
              line: "/atticus-propose",
              prompt: `${runsRelOf(ctx.root)}/${PROPOSE_CHANGE}/${run.runId}/prompt.md`,
              done: `atticus handoff done ${run.runId}`,
            }
          : { state: "none", line: "/atticus-propose" };
        return { status: 200, body };
      })
      .add("POST", "/api/propose-answers", async () => {
        const op = await loadOrgPack(orgPackDirOf(ctx.root));
        if (op.runtime.ai === "off")
          throw conflict(
            "runtime.yaml turns AI off here (ai: off): answer the questions yourself.",
          );
        const { startProposeHandoff } = await import("./copilot-acp-steps.js");
        const h = await startProposeHandoff(ctx.root, { now: now() });
        const body: Api.QuestionsProposeViewT = {
          state: "waiting",
          run: h.runId,
          line: h.line,
          prompt: h.promptRel,
          done: h.done,
        };
        return { status: 201, body };
      })
      .add("POST", "/api/decisions/batches/{batchId}/undo", async ({ params }) => {
        const id = params.batchId ?? "";
        if (!BATCH.test(id)) throw notFound(`There is no batch ${JSON.stringify(id)}.`);
        let out: Api.UndoBatchResultT;
        try {
          out = await undoBatch(ctx.root, id, { by: ctx.user, now: now() });
        } catch (e) {
          fail(e);
        }
        for (const path of out.files) ctx.events.publish({ type: "file.changed", path });
        return { status: 200, body: out };
      })
  );
}

/**
 * ADR 0208 (C4, additive): POST /api/reading-rules/learn, Learn from my corrections, one local
 * job (one at a time with Apply); its result's `extra` is Api.LearnCorrectionsResult. Refused
 * (409) where runtime.yaml turns AI off or doesn't allow the assistant's unattended runs.
 */
export function uiLearnRoutes(r: Router, ctx: ServerContext, asJob: LocalJob): Router {
  // ADR 0210 part 2 (C4, additive): each type's recipes, proven or a draft and why.
  r.add("GET", "/api/reading-rules/recipes", async () => {
    const op = await loadOrgPack(orgPackDirOf(ctx.root));
    const { typeRecipes } = await import("./reading-rules.js");
    const body: Api.ReadingRecipesViewT = {
      readers: readersOn(op) ? "on" : "off",
      recipes: await typeRecipes(ctx.root, op),
    };
    return { status: 200, body };
  });
  return r.add("POST", "/api/reading-rules/learn", async () => {
    const op = await loadOrgPack(orgPackDirOf(ctx.root));
    const { learnFromCorrections, learnRefusal } = await import("./learn-corrections.js");
    const refused = learnRefusal(op);
    if (refused) throw conflict(refused);
    const { acpStepRunner } = await import("./copilot-acp-steps.js");
    return asJob("Learn from my corrections", async () => {
      let extra: Api.LearnCorrectionsResultT | undefined;
      const res = await captured(async (io) => {
        const runner = await acpStepRunner(ctx.root, { op });
        extra = await learnFromCorrections(ctx.root, { by: ctx.user, runner }, io);
        return 0;
      });
      return { ...res, ...(extra ? { extra } : {}) };
    });
  });
}
