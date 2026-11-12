import { Api, headFromFiles, isAdopted } from "@maycombhq/core";
import { forgetCatalogs, readCrossCheck } from "@maycombhq/scanner";
import {
  badRequest,
  conflict,
  intParam,
  notFound,
  type Router,
  type ServerContext,
} from "@maycombhq/server";
import { baseClonePath } from "@maycombhq/workspace";
import type { z } from "zod";
import { captured, type LocalJob } from "./ui-api-steps.js";

/**
 * The readers' cross-check and the catalog build's confirm steps in the app (ADR 0195 points 3,
 * 4 and 7, ticket CS3; C4 3.12.0, additive, the owner's decision of 2026-11-11).
 *
 * Reads (files only; a build is made in memory and guarded, never written):
 * - GET /api/crosscheck, GET /api/crosscheck/{repo}: each repo's cross-check, one with its items.
 * - GET /api/build: each repo's source, what `atticus catalog build` would do now (its
 *   refusal, with the removals and hand edits it lists and their counts) and what the last build
 *   here changed.
 * - GET /api/build/undo[?n=]: the builds kept to undo (1 the latest) and what taking back the n
 *   latest puts back.
 * - GET /api/build/prune: the slot files no build reads.
 *
 * Writes: each the CLI's own command, as a local job (one at a time with Apply, Propose and Bring
 * in), so its lines are in the Console (ADR 0187) and the app and `atticus …` never disagree.
 * Each confirms exactly what the page listed: the build with the counts the refusal named (the
 * command refuses any other), undo with the builds and the number of files listed, prune and the
 * hand edits' curate with the count listed (409 and nothing run when it is no longer that).
 * Everything here writes the metarepo's own files or this machine's, for review in the catalog
 * PR (ADR 0186: no confirmation of a shared system).
 */

const REPO = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success)
    throw badRequest("Some fields aren't right.", {
      errors: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  return r.data;
}

/** The base clone's commit, read from its .git files (no git runs), when it is there. */
async function headOf(root: string, repo: string): Promise<string | undefined> {
  try {
    return await headFromFiles(isAdopted(root) ? root : baseClonePath(root, repo));
  } catch {
    return undefined;
  }
}

/**
 * The server keeps the catalogs it read in memory until its watcher hears a change (ADR 0119),
 * which can come after a step's own write: a build in the same job as the curated decisions it
 * follows, or a look right after a hand edit, would read the folder as it was. Each build and
 * each look here reads the files.
 */
function fresh<T>(f: () => Promise<T>): Promise<T> {
  forgetCatalogs();
  return f();
}

/** The routes; `asJob` is ui-api.ts's local job (one at a time with Apply, Propose and Bring in). */
export function uiCatalogRoutes(r: Router, ctx: ServerContext, asJob: LocalJob): Router {
  const root = ctx.root;
  const repoOf = (params: Record<string, string | undefined>) => {
    const repo = params.repo ?? "";
    if (!REPO.test(repo)) throw badRequest("repo is a repo id, as the manifests name it.");
    return repo;
  };
  return r
    .add("GET", "/api/crosscheck", async () => {
      const v = await readCrossCheck(root);
      const repos = await Promise.all(
        v.repos.map(async (x) => {
          const head = await headOf(root, x.repo);
          return { ...x, items: [], ...(head ? { head } : {}) };
        }),
      );
      return { status: 200, body: Api.CrossCheckView.parse({ ...v, repos }) };
    })
    .add("GET", "/api/crosscheck/{repo}", async ({ params }) => {
      const repo = repoOf(params);
      const v = await readCrossCheck(root, { repo });
      const one = v.repos[0];
      if (!one) throw notFound(`${repo} isn't a repo the manifests list.`);
      const head = await headOf(root, repo);
      return {
        status: 200,
        body: Api.RepoCrossCheck.parse({ ...one, ...(head ? { head } : {}) }),
      };
    })
    .add("POST", "/api/crosscheck/{repo}/dismiss", async ({ params, body }) => {
      const repo = repoOf(params);
      const b = parse(Api.CrossCheckDismissRequest, body);
      const v = await readCrossCheck(root, { repo });
      if (!v.repos[0]) throw notFound(`${repo} isn't a repo the manifests list.`);
      const { catalogCrossCheck } = await import("./crosscheck-commands.js");
      return asJob(
        b.undo ? `List again on ${repo}: ${b.key}` : `Dismiss on ${repo}: ${b.key}`,
        () =>
          captured((io) =>
            catalogCrossCheck(
              root,
              { repo, ...(b.undo ? { undismiss: b.key } : { dismiss: b.key }) },
              io,
            ),
          ),
      );
    })
    .add("GET", "/api/build", async () => {
      const { catalogBuildView } = await import("./build-report.js");
      return {
        status: 200,
        body: Api.CatalogBuildView.parse(await fresh(() => catalogBuildView(root))),
      };
    })
    .add("POST", "/api/build", async ({ body }) => {
      const b = parse(Api.CatalogBuildRequest, body);
      const { catalogBuild } = await import("./catalog-build-commands.js");
      const flags = [
        ...(b.allowRemovals !== undefined ? [`--allow-removals ${b.allowRemovals}`] : []),
        ...(b.discardEdits !== undefined ? [`--discard-edits ${b.discardEdits}`] : []),
      ];
      return asJob(["atticus catalog build", ...flags].join(" "), () =>
        captured((io) =>
          fresh(() =>
            catalogBuild(
              root,
              {
                ...(b.allowRemovals !== undefined ? { allowRemovals: b.allowRemovals } : {}),
                ...(b.discardEdits !== undefined ? { discardEdits: b.discardEdits } : {}),
              },
              io,
            ),
          ),
        ),
      );
    })
    .add("POST", "/api/build/edits/curate", async ({ body }) => {
      const b = parse(Api.CatalogEditsRequest, body);
      const { catalogBuildView } = await import("./build-report.js");
      const now = (await fresh(() => catalogBuildView(root))).pending.refused;
      const edits = now?.reasons.includes("hand-edits") ? (now.edits ?? []) : [];
      if (edits.length !== b.count)
        throw conflict(
          `The page listed ${b.count} hand ${b.count === 1 ? "edit" : "edits"}; there ${edits.length === 1 ? "is" : "are"} ${edits.length} now. Nothing was made curated: look at the list again.`,
        );
      const { catalogBuild, catalogEdits } = await import("./catalog-build-commands.js");
      // Keep the edits: each made a curated decision, then the build with them (which writes
      // what the edited files hold, so nothing is overwritten), in one job.
      return asJob("atticus catalog edits --curate, then atticus catalog build", () =>
        captured(async (io) => {
          const code = await fresh(() => catalogEdits(root, { curate: true, by: ctx.user }, io));
          return code === 0 ? fresh(() => catalogBuild(root, {}, io)) : code;
        }),
      );
    })
    .add("GET", "/api/build/undo", async ({ query }) => {
      const n = intParam(query, "n", 1, 1_000_000);
      const { catalogUndoView } = await import("./build-report.js");
      return {
        status: 200,
        body: Api.CatalogUndoView.parse(await catalogUndoView(root, n)),
      };
    })
    .add("POST", "/api/build/undo", async ({ body }) => {
      const b = parse(Api.CatalogUndoRequest, body);
      const { catalogUndoView } = await import("./build-report.js");
      const v = await catalogUndoView(root, b.n);
      if (!v.plan) throw conflict(v.problem ?? `There are fewer than ${b.n} builds to undo here.`);
      if (v.plan.files.length !== b.files)
        throw conflict(
          `The page listed ${b.files} ${b.files === 1 ? "file" : "files"} to put back; taking back the ${b.n === 1 ? "latest build" : `${b.n} latest builds`} puts back ${v.plan.files.length} now. Nothing was undone: look at the list again.`,
        );
      const { catalogUndo } = await import("./catalog-build-commands.js");
      return asJob(`atticus catalog undo ${b.n} --yes`, () =>
        captured((io) => fresh(() => catalogUndo(root, { n: b.n, yes: true }, io))),
      );
    })
    .add("GET", "/api/build/prune", async () => {
      const { catalogPruneView } = await import("./build-report.js");
      return {
        status: 200,
        body: Api.CatalogPruneView.parse(await fresh(() => catalogPruneView(root))),
      };
    })
    .add("POST", "/api/build/prune", async ({ body }) => {
      const b = parse(Api.CatalogPruneRequest, body);
      const { catalogPruneView } = await import("./build-report.js");
      const v = await fresh(() => catalogPruneView(root));
      if (v.files.length !== b.count)
        throw conflict(
          `The page listed ${b.count} ${b.count === 1 ? "file" : "files"} to remove; there ${v.files.length === 1 ? "is" : "are"} ${v.files.length} now. Nothing was removed: look at the list again.`,
        );
      const { catalogPrune } = await import("./catalog-build-commands.js");
      return asJob("atticus catalog prune --yes", () =>
        captured((io) => fresh(() => catalogPrune(root, { yes: true }, io))),
      );
    });
}
