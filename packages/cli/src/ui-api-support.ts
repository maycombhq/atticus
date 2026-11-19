import { basename, relative, resolve } from "node:path";
import type { Api } from "@maycombhq/core";
import { badRequest, type Router, type ServerContext } from "@maycombhq/server";
import type { DoctorDeps } from "./doctor.js";

/**
 * ADR 0202 point 1: Save a support bundle from the app. POST /api/support/bundle runs the steps
 * `atticus support bundle` runs (`writeSupportBundle`) and writes the same zip in the same
 * place, `.atticus/logs/`, then gives it back for the person to save a copy. It is not a job. It
 * makes no network call and takes nothing that names a destination (a body with anything in it
 * is 400), so nothing is sent anywhere: a person reads every file before it leaves.
 */

/** Above this the zip's bytes are left out of the answer (the file is on disk either way). */
export const BUNDLE_INLINE_MAX = 8 * 1024 * 1024;

export interface SupportDeps {
  /** Tests: the machine's checks' inputs (otherwise this machine's). */
  doctor?: DoctorDeps;
  /** Tests: the time in the file's name. */
  now?: string;
}

export function uiSupportRoutes(r: Router, ctx: ServerContext, deps: SupportDeps = {}): Router {
  return r.add("POST", "/api/support/bundle", async ({ body }) => {
    if (
      body !== undefined &&
      (typeof body !== "object" || body === null || Object.keys(body).length)
    )
      throw badRequest(
        "Save a support bundle takes no body: the zip is written under .atticus/logs/ and sent nowhere.",
      );
    const { writeSupportBundle } = await import("./support.js");
    const made = await writeSupportBundle(
      ctx.root,
      deps.now ? { now: new Date(deps.now) } : {},
      deps.doctor ?? {},
    );
    const view: Api.SupportBundleViewT = {
      file: relative(resolve(ctx.root), made.file).split("\\").join("/"),
      name: basename(made.file),
      bytes: made.data.length,
      files: made.files.map((f) => f.name),
      ...(made.data.length <= BUNDLE_INLINE_MAX ? { zip: made.data.toString("base64") } : {}),
    };
    return { status: 200, body: view };
  });
}
