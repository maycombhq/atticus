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
  diagramsRelOf,
  factsDirOf,
  helperOn,
  isAdopted,
  joinConventions,
  joinDependencies,
  joinFacts,
  loadOrgPack,
  orgPackDirOf,
  type CatalogRecord,
  type DependencyLink,
  type FactsJoinResult,
  type JoinRepo,
} from "@maycombhq/core";
import {
  componentRenames,
  estateFacts,
  isPrototypeRepo,
  joinReposOf,
  outsideSystems,
} from "@maycombhq/scanner";
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
  conflict,
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
 * the arrangements people keep, as files in the metarepo. Reads the catalog; the files it
 * writes are diagrams/layouts/<view-key>.yaml and, for a kept view, diagrams/views/<name>.yaml.
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

/**
 * ADR 0192: the estate's build dependencies on its own libraries, joined from the verified facts
 * on file (each repo's `dependency` facts to the coordinates another's `artifact` facts publish),
 * with the components named as the catalog names them. No org pack, or no facts: none, and the
 * picture is the catalog's as before.
 */
export async function estateDependencies(
  root: string,
  records: readonly CatalogRecord[] = [],
): Promise<DependencyLink[]> {
  const op = await loadOrgPack(orgPackDirOf(root)).catch(() => undefined);
  if (!op) return [];
  const estate = await estateFacts(root, op, "");
  if (!estate.repos.some((r) => r.facts.some((f) => f.kind === "dependency"))) return [];
  const known = records.flatMap((r) =>
    r.kind === "Component" && r.repo ? [{ id: r.id, repo: r.repo }] : [],
  );
  const repos = joinReposOf(op, estate.repos, componentRenames(estate.repos, op, known));
  return joinDependencies({ repos }).links;
}

/**
 * Review of beta.24, round 3: the estate's join of the facts on file, as `atticus verify --write`
 * joins them (the answers' targets and pairings, the outside systems, the conventions, the walk
 * through gateways). No org pack: no join.
 */
export async function estateJoinOf(
  root: string,
): Promise<{ join: FactsJoinResult; repos: JoinRepo[] }> {
  const none = { join: { joins: [], asks: [], misses: [], lineage: [], gaps: [] }, repos: [] };
  const op = await loadOrgPack(orgPackDirOf(root)).catch(() => undefined);
  if (!op) return none;
  const estate = await estateFacts(root, op, "");
  const facts = estate.repos.filter((x) => !isPrototypeRepo(op, x.repo));
  if (!facts.some((r) => r.facts.length)) return none;
  const repos = joinReposOf(op, facts, componentRenames(facts, op));
  const join = joinFacts({
    repos,
    ...(Object.keys(estate.targets).length ? { targets: estate.targets } : {}),
    ...(Object.keys(estate.pairs).length ? { pairs: estate.pairs } : {}),
    ...(Object.keys(estate.aiTargets).length ? { aiTargets: estate.aiTargets } : {}),
    outside: outsideSystems(op),
    ...joinConventions(op),
    walkGateways: helperOn("gateway-walk"),
  });
  return { join, repos };
}

/** One call a link is made of: its repo, fact id and line (API 3.11.0, `HierJoin.calls`). */
type LinkCall = NonNullable<Api.HierJoinT["calls"]>[number];

/**
 * Review of beta.24, round 3: the call facts each Interface is made of, by its id, from the join
 * of the facts on file: what All calls on this arrow are wrong corrects, where a line holds
 * another arrow's call too. None with no org pack or no facts.
 */
export async function estateLinkCalls(root: string): Promise<Map<string, LinkCall[]>> {
  const out = new Map<string, LinkCall[]>();
  for (const j of (await estateJoinOf(root)).join.joins) {
    const calls = out.get(j.interface) ?? [];
    if (!calls.some((c) => c.repo === j.call.repo && c.fact === j.call.fact))
      calls.push({ repo: j.call.repo, fact: j.call.fact, at: j.call.at });
    out.set(j.interface, calls);
  }
  return out;
}

export function uiGraphRoutes(r: Router, ctx: ServerContext): Router {
  // beta.21: the estate is built once per catalog state, not on every box opened. The files are
  // checked at most once a second, and at once when the app sees a catalog file change. ADR
  // 0192: and the facts', which the dependency edges are joined from.
  const memoKey = `estate:${ctx.root}`;
  const callsKey = `link-calls:${ctx.root}`;
  ctx.events.listen((e) => {
    if (
      e.type === "file.changed" &&
      typeof e.path === "string" &&
      /^(\.atticus[\\/])?(catalog|facts)[\\/]/.test(e.path)
    ) {
      recheckNow(memoKey);
      recheckNow(callsKey);
    }
  });
  const stateFiles = async () => [
    ...(await filesUnder(catalogDirOf(ctx.root))),
    ...(await filesUnder(factsDirOf(ctx.root))),
  ];
  const estate = async (): Promise<Estate> =>
    memoByFiles(memoKey, stateFiles, buildFromCatalog, { recheckAfterMs: 1000 });
  // Round 3: the join of the facts on file, only when an edge's calls are asked for.
  const linkCalls = async () =>
    memoByFiles(callsKey, stateFiles, () => estateLinkCalls(ctx.root), { recheckAfterMs: 1000 });
  const buildFromCatalog = async (): Promise<Estate> => {
    const records = await catalogRecords(ctx.root);
    if (!records.length)
      throw new HttpError(
        422,
        "Atticus can't show that yet",
        "The catalog is empty: read the repos first (atticus map <repo>, then atticus verify <repo> --write).",
        { notYet: true },
      );
    return buildEstate(records, { dependsOn: await estateDependencies(ctx.root, records) });
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
  // In a repo adopted in place every file Atticus writes is under .atticus/ (ADR 0132).
  const layoutRel = (view: string) =>
    isAdopted(ctx.root) ? `.atticus/${layoutPath(view)}` : layoutPath(view);
  const viewsRel = diagramsRelOf(ctx.root) + "/views";
  const readLayout = async (view: string) => {
    try {
      const f = DiagramLayout.safeParse(
        parse(await readFile(join(ctx.root, layoutRel(view)), "utf8")),
      );
      if (!f.success)
        throw new HttpError(422, "Atticus refused", `${layoutRel(view)} isn't a layout file.`);
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
      // Review of beta.24: every call merged into one edge of a view (a node's or a focus), not
      // only the first 20 the view lists, worked out by the view's own function.
      .add("GET", "/api/graph/edge-calls", async ({ query }) => {
        const edge = query.get("edge");
        const node = query.get("node");
        const focus = query.get("focus");
        if (!edge || !node === !focus)
          throw badRequest("Say edge=<edge id> and node=<id> or focus=<id>.");
        const id = idOf((node ?? focus)!);
        const lens = lensOf(query.get("lens"), node ? "architecture" : "data");
        // 3.11.0: the node view's depth and all, as GET /api/graph/node takes them, so an edge
        // of a depth-2 or an all view is found.
        const d = query.get("depth");
        if (d !== null && !/^[1-3]$/.test(d)) throw badRequest("depth is 1, 2 or 3.");
        const est = await estate();
        const v = guard(() =>
          node
            ? nodeView(est, id, {
                lens,
                depth: d ? Number(d) : 1,
                all: query.get("all") === "1",
                everyJoin: true,
              })
            : focusView(est, id, { lens, everyJoin: true }),
        );
        const e = v.edges.find((x) => x.id === edge);
        if (!e) throw notFound(`The ${lens} view of ${id} has no edge ${edge}.`);
        // 3.11.0 (round 3): each link's call facts, from the join of the facts on file, so a
        // line that holds another arrow's call too is corrected for this arrow's alone.
        const calls = e.joins?.length ? await linkCalls() : new Map<string, LinkCall[]>();
        return {
          status: 200,
          body: {
            edge: e.id,
            count: e.count,
            joins: (e.joins ?? []).map((j) => {
              const c = calls.get(j.interface);
              return c?.length ? { ...j, calls: c } : j;
            }),
          } satisfies Api.GraphEdgeCallsViewT,
        };
      })
      // G6 (ADR 0175): a canvas's named filters and layers, kept in the metarepo for review.
      .add("GET", "/api/graph/views", async () => {
        const dir = join(ctx.root, ...viewsRel.split("/"));
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
          body: { views, dir: viewsRel } satisfies Api.SavedCanvasViewsT,
        };
      })
      .add("PUT", "/api/graph/views/{name}", async ({ params, body, query }) => {
        const b = Api.SavedCanvasView.safeParse({ ...(body as object), name: params.name });
        if (!b.success)
          throw badRequest(
            "Name the view (lower case, digits and dashes) and give its lens and node.",
            {
              errors: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
            },
          );
        const v = { ...b.data, by: ctx.user, at: new Date().toISOString() };
        const rel = `${viewsRel}/${v.name}.yaml`;
        // A view kept already (perhaps a teammate's, committed) is replaced only when asked.
        if (existsSync(join(ctx.root, rel)) && query.get("replace") !== "1")
          throw conflict(
            `There is a view ${v.name} already (${rel}): pick another name, or replace it.`,
          );
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
        if (line < 1) throw badRequest("A line is 1 or more.");
        const dir = await checkoutOf(ctx.root, repo).catch(() => undefined);
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
          body: { view, saved: !!f, path: layoutRel(view), positions: f?.positions ?? {} },
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
        await writeFileAtomic(join(ctx.root, layoutRel(view)), stringify(file));
        ctx.events.publish({ type: "file.changed", path: layoutRel(view) });
        return {
          status: 200,
          body: { view, saved: true, path: layoutRel(view), positions: file.positions },
        };
      })
  );
}
