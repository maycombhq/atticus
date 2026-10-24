import { Api, loadOrgPack, orgPackDirOf } from "@maycombhq/core";
import { badRequest, HttpError, type Router, type ServerContext } from "@maycombhq/server";
import { digestCommand, type DigestDeps } from "./digest-commands.js";
import { readMe, writeMe } from "./me-file.js";

export { ME_FILE } from "./me-file.js";

/**
 * Who is using the app (ADR 0073): the metarepo's Git user. There are no roles, views or
 * in-app approvals: everyone sees the same screens, and a gate is approved when its hand-off
 * PR merges on the Git host.
 */

export async function meView(ctx: Pick<ServerContext, "root" | "user" | "person">) {
  const op = await loadOrgPack(orgPackDirOf(ctx.root));
  const me = await readMe(ctx.root);
  const p = ctx.person;
  return {
    user: ctx.user,
    ...(p?.name ? { name: p.name } : {}),
    ...(p?.email ? { email: p.email } : {}),
    source: p?.source ?? "given",
    ...(p?.warning ? { warning: p.warning } : {}),
    ai: op.runtime.ai,
    notify: {
      digest: me.notify?.digest ?? "off",
      ...(me.notify?.channel ? { channel: me.notify.channel } : {}),
    },
    // WP7.5: the changes the person follows.
    watching: me.watch,
  };
}

export function uiMeRoutes(r: Router, ctx: ServerContext, deps: DigestDeps = {}): Router {
  return (
    r
      .add("GET", "/api/me", async () => ({ status: 200, body: await meView(ctx) }))
      .add("PUT", "/api/me/notify", async ({ body }) => {
        const b = Api.SaveNotifyRequest.safeParse(body ?? {});
        if (!b.success)
          throw badRequest("Say how often: { digest: off | daily | weekly, channel?: <channel> }.");
        const me = await readMe(ctx.root);
        await writeMe(ctx.root, {
          ...me,
          notify: { digest: b.data.digest, ...(b.data.channel ? { channel: b.data.channel } : {}) },
        });
        return { status: 200, body: await meView(ctx) };
      })
      // WP7.5: follow a change, or stop following it.
      .add("PUT", "/api/me/watch", async ({ body }) => {
        const b = Api.WatchRequest.safeParse(body ?? {});
        if (!b.success) throw badRequest("Say which change and whether: { change, watch: true }.");
        const me = await readMe(ctx.root);
        const watch = b.data.watch
          ? [...me.watch, b.data.change]
          : me.watch.filter((c) => c !== b.data.change);
        await writeMe(ctx.root, { ...me, watch });
        return { status: 200, body: await meView(ctx) };
      })
      .add("POST", "/api/me/digest", async ({ body }) => {
        const b = Api.SendDigestRequest.safeParse(body ?? {});
        if (!b.success) throw badRequest("Send { send: true } to post it, or {} to see it.");
        const me = await readMe(ctx.root);
        const out: string[] = [];
        const err: string[] = [];
        const code = await digestCommand(
          ctx.root,
          {
            as: ctx.user,
            ...(me.notify?.channel ? { channel: me.notify.channel } : {}),
            send: b.data.send,
            json: true,
          },
          { out: (l) => out.push(l), err: (l) => err.push(l) },
          deps,
        );
        if (code === 2) throw new HttpError(400, "The request isn't valid", err.join("\n"));
        return { status: 200, body: JSON.parse(out.join("\n")) as unknown };
      })
  );
}
