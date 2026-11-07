import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stringify, parse } from "yaml";
import {
  Api,
  catalogDirOf,
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
import { checkoutOf } from "./facts-files.js";
import { filesUnder, memoByFiles, recheckNow } from "./file-memo.js";

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

/**
 * A file and line as VS Code's link to open it: each path segment encoded (a # or ? in a folder
 * name would end the path), the slashes and a Windows drive's colon kept.
 */
export function vscodeFileLink(path: string, line: number): string {
  const posix = path.replace(/\\/g, "/");
  const segs = (posix.startsWith("/") ? posix.slice(1) : posix)
    .split("/")
    .map((x) => (/^[A-Za-z]:$/.test(x) ? x : encodeURIComponent(x)));
  return `vscode://file/${segs.join("/")}:${line}`;
}

export function uiGraphRoutes(r: Router, ctx: ServerContext): Router {
  // beta.21: the estate is built once per catalog state, not on every box opened. The files are
  // checked at most once a second, and at once when the app sees a catalog file change.
  const memoKey = `estate:${ctx.root}`;
  ctx.events.listen((e) => {
    if (e.type === "file.changed" && typeof e.path === "string" && /^catalog[\\/]/.test(e.path))
      recheckNow(memoKey);
  });
  const estate = async (): Promise<Estate> =>
    memoByFiles(memoKey, () => filesUnder(catalogDirOf(ctx.root)), buildFromCatalog, {
      recheckAfterMs: 1000,
    });
  const buildFromCatalog = async (): Promise<Estate> => {
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
  // Built while the app opens, so the first canvas doesn't wait on reading every record.
  setTimeout(() => void estate().catch(() => undefined), 0).unref?.();
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
  return (
    r
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
      // G6 (ADR 0175): a canvas's named filters and layers, kept in the metarepo for review.
      .add("GET", "/api/graph/views", async () => {
        const dir = join(ctx.root, "diagrams", "views");
        const names = (await readdir(dir).catch(() => [] as string[]))
          .filter((n) => n.endsWith(".yaml"))
          .sort();
        const views: Api.SavedCanvasViewT[] = [];
        for (const n of names) {
          const v = Api.SavedCanvasView.safeParse(
            parse(await readFile(join(dir, n), "utf8").catch(() => "")),
          );
          if (v.success) views.push(v.data);
        }
        return {
          status: 200,
          body: { views, dir: "diagrams/views" } satisfies Api.SavedCanvasViewsT,
        };
      })
      .add("PUT", "/api/graph/views/{name}", async ({ params, body }) => {
        const b = Api.SavedCanvasView.safeParse({ ...(body as object), name: params.name });
        if (!b.success)
          throw badRequest(
            "Name the view (lower case, digits and dashes) and give its lens and node.",
            {
              errors: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
            },
          );
        const v = { ...b.data, by: ctx.user, at: new Date().toISOString() };
        const rel = `diagrams/views/${v.name}.yaml`;
        await writeFileAtomic(join(ctx.root, rel), stringify(v));
        ctx.events.publish({ type: "file.changed", path: rel });
        return { status: 200, body: v };
      })
      // G6: a cited line as a file to open in an editor (the checkout in the metarepo's workspace).
      .add("GET", "/api/code-link", async ({ query }) => {
        const repo = query.get("repo") ?? "";
        const at = query.get("at") ?? "";
        const m = /^(.+):(\d+)$/.exec(at);
        if (!/^[A-Za-z0-9._-]{1,200}$/.test(repo) || !m || m[1]!.includes(".."))
          throw badRequest("Say repo=<repo> and at=<file>:<line>.");
        const line = Number(m[2]);
        const dir = await checkoutOf(ctx.root, repo);
        if (!dir || !existsSync(dir))
          return {
            status: 200,
            body: {
              line,
              missing: `There is no checkout of ${repo} here (atticus sync clones it into the workspace).`,
            } satisfies Api.CodeLinkT,
          };
        const path = join(dir, ...m[1]!.split("/"));
        return {
          status: 200,
          body: {
            path,
            line,
            vscode: vscodeFileLink(path, line),
            idea: `idea://open?file=${encodeURIComponent(path)}&line=${line}`,
          } satisfies Api.CodeLinkT,
        };
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
      })
  );
}
