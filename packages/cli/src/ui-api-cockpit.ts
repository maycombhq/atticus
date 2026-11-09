import { Api, RecordId } from "@maycombhq/core";
import { badRequest, HttpError, notFound, type Router } from "@maycombhq/server";
import type { ServerContext } from "@maycombhq/server";

/**
 * Review round 48: a change id from the address, checked before it is used: a path (../..) or
 * anything that isn't an id is a 400, never a read outside openspec/changes or a 500.
 */
function changeIdOf(v: string): string {
  if (!RecordId.safeParse(v).success)
    throw badRequest(`${JSON.stringify(v.slice(0, 120))} isn't a change id.`);
  return v;
}

/**
 * The change cockpit (WP7.1) through the local API: one change at a glance; and the archived
 * changes nearest a new brief (WP7.6), to start from one. Files only.
 */
export function uiCockpitRoutes(r: Router, ctx: ServerContext): Router {
  return r
    .add("GET", "/api/changes/{changeId}/cockpit", async ({ params }) => {
      const id = changeIdOf(params.changeId!);
      const { cockpit } = await import("./cockpit.js");
      try {
        return {
          status: 200,
          body: Api.ChangeCockpit.parse(await cockpit(ctx.root, id, { user: ctx.user })),
        };
      } catch (e) {
        if (e instanceof Error && e.name === "ChangeFileError")
          throw notFound(`There is no change ${params.changeId}.`);
        throw e;
      }
    })
    .add("GET", "/api/past-changes", async ({ query }) => {
      const { changeAboutText, similarChanges } = await import("./similar-changes.js");
      const given = query.get("change");
      const change = given ? changeIdOf(given) : undefined;
      const text = change ? await changeAboutText(ctx.root, change) : query.get("text")?.trim();
      if (change && !text) throw notFound(`There is no change ${change}.`);
      if (!text)
        throw badRequest(
          "Say what the new change is about: ?text=<its title or brief>, or ?change=<a change's id>.",
        );
      const limit = Number(query.get("limit") ?? 5);
      return {
        status: 200,
        body: Api.SimilarChanges.parse(
          await similarChanges(ctx.root, text.slice(0, 20000), {
            limit: Number.isInteger(limit) && limit > 0 && limit <= 20 ? limit : 5,
          }),
        ),
      };
    })
    .add("POST", "/api/changes/{changeId}/like", async ({ params, body }) => {
      const b = Api.AttachPastChangeRequest.safeParse(body ?? {});
      if (!b.success) throw badRequest("Say which archived change: { like: <its folder or id> }.");
      const { attachPastChange, findPastChange } = await import("./similar-changes.js");
      const folder = await findPastChange(ctx.root, b.data.like);
      if (!folder) throw notFound(`There is no archived change ${b.data.like}.`);
      const { AttachError } = await import("./attach-commands.js");
      try {
        const name = await attachPastChange(ctx.root, params.changeId!, folder, ctx.user);
        ctx.events.publish({ type: "file.changed", path: `inputs/${name}` });
        return {
          status: 201,
          body: Api.AttachPastChangeResult.parse({ like: folder, file: `inputs/${name}` }),
        };
      } catch (e) {
        if (e instanceof AttachError)
          throw e.code === "not-found"
            ? notFound(e.message)
            : new HttpError(422, "Atticus can't attach that", e.message);
        throw e;
      }
    });
}
