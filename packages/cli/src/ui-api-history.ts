import type { Api } from "@maycombhq/core";
import { badRequest, notFound, type Router, type ServerContext } from "@maycombhq/server";
import { historyEntry, listHistory } from "./history.js";

/**
 * ADR 0110: the prompt and response history, read from .atticus/history/ only: the turns (a
 * prompt with the response that followed it in its session), newest first, and one record with
 * its pair. Read-only: only `atticus history add` writes it. Text is data, shown as text.
 */
export function uiHistoryRoutes(r: Router, ctx: ServerContext): Router {
  const root = ctx.root;
  return r
    .add("GET", "/api/history", async ({ query }) => {
      const limitText = query.get("limit");
      const limit = limitText === null ? 200 : Number(limitText);
      if (!Number.isInteger(limit) || limit < 1)
        throw badRequest("limit is a whole number of 1 or more.");
      const opt = (k: string) => {
        const v = query.get(k)?.trim();
        return v ? v : undefined;
      };
      const change = opt("change");
      const session = opt("session");
      const filter = opt("q");
      const body = await listHistory(root, {
        ...(change ? { change } : {}),
        ...(session ? { session } : {}),
        ...(filter ? { filter } : {}),
        limit,
      });
      return { status: 200, body: body satisfies Api.HistoryList };
    })
    .add("GET", "/api/history/{historyId}", async ({ params }) => {
      const e = await historyEntry(root, params.historyId!);
      if (!e) throw notFound(`There is no record ${params.historyId}.`);
      return { status: 200, body: e satisfies Api.HistoryEntry };
    });
}
