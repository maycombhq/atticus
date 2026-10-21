import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { Api, ensureLocalIgnore, loadOrgPack, orgPackDirOf } from "@maycombhq/core";
import { badRequest, HttpError, type Router, type ServerContext } from "@maycombhq/server";
import { digestCommand, type DigestDeps } from "./digest-commands.js";

/**
 * Who is using the app (ADR 0073): the metarepo's Git user. There are no roles, views or
 * in-app approvals: everyone sees the same screens, and a gate is approved when its hand-off
 * PR merges on the Git host.
 */

/** The person's own file, never committed: their digest settings. */
export const ME_FILE = ".atticus/me.yaml";

const MeNotify = z.object({
  /** Where the digest goes; default a direct message to the person. */
  channel: z.string().min(1).optional(),
  /** How often the person wants the digest; Atticus sends it only when they (or their own scheduled job) ask. */
  digest: z.enum(["off", "daily", "weekly"]).default("off"),
});

/** Older files may still hold `view` and `groups` (ADR 0044); they are ignored and dropped on the next save. */
const MeFile = z.object({ notify: MeNotify.optional() });
type MeFile = z.infer<typeof MeFile>;

async function readMe(root: string): Promise<MeFile> {
  try {
    const r = MeFile.safeParse(parse(await readFile(join(root, ME_FILE), "utf8")) ?? {});
    return r.success ? r.data : {};
  } catch {
    return {};
  }
}

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
  };
}

async function writeMe(root: string, me: MeFile) {
  await ensureLocalIgnore(root);
  const file = join(root, ME_FILE);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, stringify({ ...(me.notify ? { notify: me.notify } : {}) }), "utf8");
}

export function uiMeRoutes(r: Router, ctx: ServerContext, deps: DigestDeps = {}): Router {
  return r
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
    });
}
