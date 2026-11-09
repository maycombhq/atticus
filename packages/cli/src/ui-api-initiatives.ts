import { printToCurrent } from "@maycombhq/core";
import { Api } from "@maycombhq/core";
import { readView } from "@maycombhq/initiatives";
import {
  badRequest,
  conflict,
  HttpError,
  notFound,
  type Router,
  type ServerContext,
} from "@maycombhq/server";
import type { z } from "zod";
import type { Output } from "./commands.js";

/**
 * UX review: initiatives start, are planned and have their commitments recorded in the app.
 * Each route runs the same function `atticus initiative new|plan|commit` runs, with the
 * signed-in person as `by`, and writes only in the metarepo (catalog/curated and
 * initiatives/<id>/). The person proposes the files for review afterwards (ADR 0183).
 */

const ID = /^[a-z0-9][a-z0-9._-]*$/;

interface Ran {
  code: number;
  out: string[];
  err: string[];
}

async function run(f: (io: Output) => Promise<number>): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  // ADR 0187: inside a job, each line also goes to its Console entry as it is printed.
  const code = await f({
    out: (l) => {
      out.push(l);
      printToCurrent(l);
    },
    err: (l) => {
      err.push(l);
      printToCurrent(l);
    },
  });
  return { code, out, err };
}

function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success)
    throw badRequest("Some fields aren't right.", {
      errors: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  return r.data;
}

/** The command's refusal in its own words: missing is 404, taken is 409, usage is 400. */
function refused(r: Ran): HttpError {
  const detail = [...r.err, ...r.out].join("\n") || "Atticus refused.";
  if (/^There is no (initiative|commitment) /m.test(detail)) return notFound(detail);
  if (/already exists/.test(detail)) return conflict(detail);
  return r.code === 2 ? badRequest(detail) : new HttpError(422, "Atticus refused", detail);
}

export function uiInitiativeRoutes(r: Router, ctx: ServerContext): Router {
  const commands = () => import("./initiative-commands.js");
  const changed = () => ctx.events.publish({ type: "file.changed", path: "catalog/curated" });
  return r
    .add("POST", "/api/initiatives", async ({ body }) => {
      const b = parseBody(Api.NewInitiativeRequest, body);
      const { initiativeNew } = await commands();
      const res = await run((io) =>
        initiativeNew(
          ctx.root,
          {
            title: b.title,
            journey: b.journey,
            by: ctx.user,
            ...(b.id ? { id: b.id } : {}),
            ...(b.release ? { release: b.release } : {}),
            ...(b.epic ? { epic: b.epic } : {}),
            json: true,
          },
          io,
        ),
      );
      if (res.code !== 0) throw refused(res);
      const made = JSON.parse(res.out.join("\n")) as {
        initiative: { id: string; journey: string };
        written: string;
      };
      changed();
      return {
        status: 201,
        body: {
          initiative: made.initiative.id,
          lines: [
            `Started ${made.initiative.id} (${made.initiative.journey}). Wrote ${made.written}.`,
          ],
        },
      };
    })
    .add("POST", "/api/initiatives/{initiativeId}/plan", async ({ params, body }) => {
      const id = params.initiativeId!;
      if (!ID.test(id)) throw badRequest(`${id} isn't an id.`);
      const b = parseBody(Api.InitiativePlanRequest, body);
      const { initiativePlan } = await commands();
      const res = await run((io) =>
        initiativePlan(
          ctx.root,
          id,
          {
            by: ctx.user,
            ...(b.target ? { target: b.target } : {}),
            ...(b.release ? { release: b.release } : {}),
            ...(b.systems?.length ? { systems: b.systems } : {}),
          },
          io,
        ),
      );
      if (res.code !== 0) throw refused(res);
      changed();
      return { status: 200, body: { initiative: id, lines: res.out } };
    })
    .add("POST", "/api/commitments/{commitmentId}/status", async ({ params, body }) => {
      const id = params.commitmentId!;
      if (!ID.test(id)) throw badRequest(`${id} isn't an id.`);
      const b = parseBody(Api.CommitmentStatusRequest, body);
      const c = (await readView(ctx.root)).get("Commitment", id);
      if (!c) throw notFound(`There is no commitment ${id}.`);
      const { initiativeCommitment } = await commands();
      const res = await run((io) =>
        initiativeCommitment(
          ctx.root,
          id,
          b.status,
          { by: ctx.user, ...(b.note ? { note: b.note } : {}) },
          io,
        ),
      );
      if (res.code !== 0) throw refused(res);
      changed();
      return { status: 200, body: { initiative: c.initiative, lines: res.out } };
    });
}
