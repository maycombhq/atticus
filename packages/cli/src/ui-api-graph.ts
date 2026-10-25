import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify, parse } from "yaml";
import {
  Api,
  DiagramLayout,
  LAYOUT_SCHEMA_VERSION,
  layoutPath,
  ViewKey,
  writeFileAtomic,
} from "@maycombhq/core";
import {
  buildEstate,
  focusView,
  NoSuchNode,
  nodeView,
  viewKey,
  type Estate,
} from "@maycombhq/diagrams";
import {
  badRequest,
  HttpError,
  notFound,
  type Router,
  type ServerContext,
} from "@maycombhq/server";
import { catalogRecords } from "./site-commands.js";

/**
 * The hierarchical graph API (ADR 0081): the estate as one model, opened a node at a time, and
 * the arrangements people keep, as files in the metarepo. Reads the catalog; the only file it
 * writes is diagrams/layouts/<view-key>.yaml.
 */

const lensOf = (v: string | null, fallback: Api.GraphLensT): Api.GraphLensT => {
  if (v === null) return fallback;
  const l = Api.GraphLens.safeParse(v);
  if (!l.success) throw badRequest(`${v} isn't a lens. Lenses: ${Api.GRAPH_LENSES.join(", ")}.`);
  return l.data;
};

const idOf = (id: string) => {
  if (!Api.HierId.safeParse(id).success)
    throw badRequest(
      `${id} isn't a node id. Use estate, or <kind>:<record id>, e.g. system:ledger.`,
    );
  return id;
};

const keyOf = (k: string) => {
  if (!ViewKey.safeParse(k).success)
    throw badRequest(`${k} isn't a view key. Use <lens>.<node>, e.g. architecture.estate.`);
  return k;
};

export function uiGraphRoutes(r: Router, ctx: ServerContext): Router {
  const estate = async (): Promise<Estate> => {
    const records = await catalogRecords(ctx.root);
    if (!records.length)
      throw new HttpError(
        422,
        "Atticus can't show that yet",
        "The catalog is empty: read the repos first (atticus map <repo>, then atticus verify <repo> --write).",
        { notYet: true },
      );
    return buildEstate(records);
  };
  const guard = <T>(f: () => T): T => {
    try {
      return f();
    } catch (e) {
      if (e instanceof NoSuchNode) throw notFound(e.message);
      throw e;
    }
  };
  const readLayout = async (view: string) => {
    try {
      const f = DiagramLayout.safeParse(
        parse(await readFile(join(ctx.root, layoutPath(view)), "utf8")),
      );
      if (!f.success)
        throw new HttpError(422, "Atticus refused", `${layoutPath(view)} isn't a layout file.`);
      return f.data;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  };
  return r
    .add("GET", "/api/graph/node/{id}", async ({ params, query }) => {
      const id = idOf(params.id!);
      const lens = lensOf(query.get("lens"), "architecture");
      const d = query.get("depth");
      if (d !== null && !/^[1-3]$/.test(d)) throw badRequest("depth is 1, 2 or 3.");
      const est = await estate();
      return {
        status: 200,
        body: guard(() =>
          nodeView(est, id, { lens, depth: d ? Number(d) : 1, all: query.get("all") === "1" }),
        ),
      };
    })
    .add("GET", "/api/graph/focus/{id}", async ({ params, query }) => {
      const id = idOf(params.id!);
      const lens = lensOf(query.get("lens"), "data");
      const est = await estate();
      return { status: 200, body: guard(() => focusView(est, id, { lens })) };
    })
    .add("GET", "/api/graph/layout/{viewKey}", async ({ params }) => {
      const view = keyOf(params.viewKey!);
      const f = await readLayout(view);
      return {
        status: 200,
        body: { view, saved: !!f, path: layoutPath(view), positions: f?.positions ?? {} },
      };
    })
    .add("PUT", "/api/graph/layout/{viewKey}", async ({ params, body }) => {
      const view = keyOf(params.viewKey!);
      const b = Api.PutLayoutRequest.safeParse(body ?? {});
      if (!b.success)
        throw badRequest("Some fields aren't right.", {
          errors: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      const { lens, node, positions } = b.data;
      if (view !== viewKey(lens, node) && view !== viewKey(lens, node, "focus"))
        throw badRequest(`${view} isn't the view key of ${node} in the ${lens} lens.`);
      if (Object.keys(positions).length > 5000) throw badRequest("At most 5000 boxes per view.");
      const sorted = Object.fromEntries(
        Object.entries(positions)
          .sort(([a], [b2]) => (a < b2 ? -1 : 1))
          .map(([k, p]) => [k, { x: Math.round(p.x), y: Math.round(p.y) }]),
      );
      const file = DiagramLayout.parse({
        schemaVersion: LAYOUT_SCHEMA_VERSION,
        view,
        lens,
        node,
        by: ctx.user,
        at: new Date().toISOString(),
        positions: sorted,
      });
      await writeFileAtomic(join(ctx.root, layoutPath(view)), stringify(file));
      ctx.events.publish({ type: "file.changed", path: layoutPath(view) });
      return {
        status: 200,
        body: { view, saved: true, path: layoutPath(view), positions: file.positions },
      };
    });
}
