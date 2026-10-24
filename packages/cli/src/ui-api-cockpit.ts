import { Api } from "@maycombhq/core";
import { notFound, type Router } from "@maycombhq/server";
import type { ServerContext } from "@maycombhq/server";

/** The change cockpit (WP7.1) through the local API: one change at a glance. Files only. */
export function uiCockpitRoutes(r: Router, ctx: ServerContext): Router {
  return r.add("GET", "/api/changes/{changeId}/cockpit", async ({ params }) => {
    const { cockpit } = await import("./cockpit.js");
    try {
      return {
        status: 200,
        body: Api.ChangeCockpit.parse(await cockpit(ctx.root, params.changeId!)),
      };
    } catch (e) {
      if (e instanceof Error && e.name === "ChangeFileError")
        throw notFound(`There is no change ${params.changeId}.`);
      throw e;
    }
  });
}
