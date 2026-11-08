import { Api } from "@maycombhq/core";
import {
  badRequest,
  conflict,
  HttpError,
  notFound,
  type Router,
  type ServerContext,
} from "@maycombhq/server";
import { correctDecision, decisionsView, DecideError, undoBatch } from "./ai-decide.js";

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
  return r
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
    });
}
