import { Api, headFromFiles, isAdopted } from "@maycombhq/core";
import { promotedStates, readCrossCheck } from "@maycombhq/scanner";
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
 * - GET /api/build/upgrade: the upgrade to source slots as a dry run (`atticus upgrade --json`).
 * - GET /api/crosscheck/{repo}/promote?key=: the person's fact promoting an item would write.
 *
 * Writes: each the CLI's own command, as a local job (one at a time with Apply, Propose and Bring
 * in), so its lines are in the Console (ADR 0187) and the app and `atticus …` never disagree.
 * Each confirms exactly what the page listed: the build with the counts the refusal named (the
 * command refuses any other), undo with the builds and the number of files listed, prune and the
 * hand edits' curate with the count listed, the upgrade with the count of files listed and the
 * listing's hash (and, when its first build changes the catalog, the count of those changes), a promote with the hash of the fact line previewed (409 and nothing run when it
 * is no longer that). A promote is the person's own fact: refused inside a Copilot session
 * (`ai/src/person-only.ts`), as the command line refuses it.
 * Everything here writes the metarepo's own files or this machine's, for review in the catalog
 * PR (ADR 0186: no confirmation of a shared system).
 */

const REPO = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

/** A promote job's code when the promote itself refused (the app says it as the promote's). */
export const PROMOTE_REFUSED = 3;

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

// The server keeps the catalogs it read in memory until its watcher hears a change (ADR 0119).
// Every build and every look here goes through CS2's `loadBuildInputs`, which forgets every kept
// read first (`forgetKeptReads`), so a build in the same job as the curated decisions it follows
// reads them (ui-api-catalog.test.ts: curate then build in one job keeps the hand edit).

/**
 * One run of `work` at a time, shared: a call while none runs starts one; a call while one runs
 * waits for the next, which starts once it ends (so it reads the files as they are once it was
 * asked), and every call until that one starts shares it. Two runs never overlap, and no call
 * is answered by a run that started before it.
 */
export function coalesced<T>(work: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | undefined;
  let next: Promise<T> | undefined;
  const start = (): Promise<T> => {
    const p = work();
    running = p;
    const done = () => {
      if (running === p) running = undefined;
    };
    p.then(done, done);
    return p;
  };
  return () => {
    // `next` is set from the moment it is asked for until it starts (then it is `running`).
    if (next) return next;
    if (!running) return start();
    const after = running.then(
      () => undefined,
      () => undefined,
    );
    const n = after.then(() => {
      next = undefined;
      return start();
    });
    next = n;
    return n;
  };
}

/** The routes; `asJob` is ui-api.ts's local job (one at a time with Apply, Propose and Bring in). */
export function uiCatalogRoutes(r: Router, ctx: ServerContext, asJob: LocalJob): Router {
  const root = ctx.root;
  // The review: every file event reloads the page, and each GET /api/build is a whole build in
  // memory, so the builds are coalesced (`coalesced`).
  const buildViewNow = coalesced(async () =>
    (await import("./build-report.js")).catalogBuildView(root),
  );
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
      // Each readers-only item a person promoted: verified on its line, not yet, or rejected.
      const promoted = await promotedStates(
        root,
        repo,
        one.items.filter((i) => i.state === "readers-only").map((i) => i.key),
      );
      const { readersValueSha } = await import("./crosscheck-commands.js");
      const items = one.items.map((i) => {
        const p = i.state === "readers-only" ? promoted.get(i.key) : undefined;
        const sha =
          i.state === "readers-only" || i.state === "disagree"
            ? { readersSha256: readersValueSha(i.readers?.value) }
            : {};
        return { ...i, ...sha, ...(p ? { promoted: p } : {}) };
      });
      return {
        status: 200,
        body: Api.RepoCrossCheck.parse({ ...one, items, ...(head ? { head } : {}) }),
      };
    })
    .add("GET", "/api/crosscheck/{repo}/promote", async ({ params, query }) => {
      const repo = repoOf(params);
      const key = (query.get("key") ?? "").trim();
      if (!key || key.length > 500)
        throw badRequest("key is the item's key, as the cross-check names it.");
      const v = await readCrossCheck(root, { repo });
      if (!v.repos[0]) throw notFound(`${repo} isn't a repo the manifests list.`);
      const { planPromote } = await import("@maycombhq/scanner");
      const { checkoutLineOf } = await import("./crosscheck-commands.js");
      const { next: _next, ...plan } = await planPromote(root, repo, key, {
        lineOf: checkoutLineOf(root, repo),
      });
      void _next;
      return { status: 200, body: Api.CrossCheckPromoteView.parse(plan) };
    })
    .add("POST", "/api/crosscheck/{repo}/promote", async ({ params, body }) => {
      const repo = repoOf(params);
      const b = parse(Api.CrossCheckPromoteRequest, body);
      const v = await readCrossCheck(root, { repo });
      if (!v.repos[0]) throw notFound(`${repo} isn't a repo the manifests list.`);
      const { planPromote } = await import("@maycombhq/scanner");
      const { catalogCrossCheck, checkoutLineOf } = await import("./crosscheck-commands.js");
      const plan = await planPromote(root, repo, b.key, { lineOf: checkoutLineOf(root, repo) });
      if (!plan.can)
        throw conflict(`${b.key} can't be promoted now: ${plan.why}. Nothing written.`);
      if (plan.sha256 !== b.sha256)
        throw conflict(
          `The fact promoting ${b.key} writes isn't the one the page showed any more. Nothing written: look at it again.`,
        );
      const { verifyCommand } = await import("./verify-commands.js");
      // The person's fact, then the verifier on it: one job, both commands' lines in the Console.
      return asJob(`Promote on ${repo}`, () =>
        captured(async (io) => {
          const code = await catalogCrossCheck(
            root,
            { repo, promote: b.key, expect: b.sha256 },
            io,
          );
          // The promote's own refusal is said as such (PROMOTE_REFUSED), not as verify's.
          if (code !== 0) return PROMOTE_REFUSED;
          return verifyCommand(root, repo, { write: false, verbose: false, json: false }, io);
        }),
      );
    })
    .add("POST", "/api/crosscheck/{repo}/dismiss", async ({ params, body }) => {
      const repo = repoOf(params);
      const b = parse(Api.CrossCheckDismissRequest, body);
      const v = await readCrossCheck(root, { repo });
      const one = v.repos[0];
      if (!one) throw notFound(`${repo} isn't a repo the manifests list.`);
      const { catalogCrossCheck, readersValueSha } = await import("./crosscheck-commands.js");
      // The key is checked before a job starts (the review): an item to dismiss, at the value
      // the page showed, or a dismissal to take back.
      const item = one.items.find((i) => i.key === b.key);
      if (b.undo) {
        if (!item?.dismissed) throw notFound(`${b.key} isn't dismissed on ${repo}.`);
      } else {
        if (!item || item.state === "agree" || item.state === "facts-only")
          throw notFound(`${b.key} isn't an item the readers found or disagree on, on ${repo}.`);
        if (b.sha256 === undefined)
          throw badRequest("sha256 is the item's readersSha256, as the page showed it.");
        if (readersValueSha(item.readers?.value) !== b.sha256)
          throw conflict(
            `The readers say another value for ${b.key} than the page showed. Nothing written: look at it again.`,
          );
      }
      return asJob(b.undo ? `List again on ${repo}` : `Dismiss on ${repo}`, () =>
        captured((io) =>
          catalogCrossCheck(
            root,
            {
              repo,
              ...(b.undo ? { undismiss: b.key } : { dismiss: b.key, expect: b.sha256! }),
            },
            io,
          ),
        ),
      );
    })
    .add("GET", "/api/build", async () => {
      return { status: 200, body: Api.CatalogBuildView.parse(await buildViewNow()) };
    })
    .add("POST", "/api/build", async ({ body }) => {
      const b = parse(Api.CatalogBuildRequest, body);
      // The review (S2): a confirm is of the list shown. Built again in memory and guarded
      // (buildAndWrite with check), and run only when it lists what the page listed.
      const counted = b.allowRemovals !== undefined || b.discardEdits !== undefined;
      if (counted && b.plan === undefined)
        throw badRequest("plan is GET /api/build's pending.plan for the list being confirmed.");
      if (b.plan !== undefined) {
        const { catalogBuildView } = await import("./build-report.js");
        if ((await catalogBuildView(root)).pending.plan !== b.plan)
          throw conflict(
            "What the build would remove or discard isn't what the page listed any more. Nothing written: look at the list again.",
          );
      }
      const { catalogBuild } = await import("./catalog-build-commands.js");
      const flags = [
        ...(b.allowRemovals !== undefined ? [`--allow-removals ${b.allowRemovals}`] : []),
        ...(b.discardEdits !== undefined ? [`--discard-edits ${b.discardEdits}`] : []),
      ];
      // The plan is checked again under the command's lock (as upgrade --yes checks its own):
      // a writer between this check and the job writes nothing the page didn't list.
      return asJob(["atticus catalog build", ...flags].join(" "), () =>
        captured((io) =>
          catalogBuild(
            root,
            {
              ...(b.allowRemovals !== undefined ? { allowRemovals: b.allowRemovals } : {}),
              ...(b.discardEdits !== undefined ? { discardEdits: b.discardEdits } : {}),
              ...(b.plan !== undefined ? { plan: b.plan } : {}),
            },
            io,
          ),
        ),
      );
    })
    .add("POST", "/api/build/edits/curate", async ({ body }) => {
      const b = parse(Api.CatalogEditsRequest, body);
      const { catalogBuildView } = await import("./build-report.js");
      const view = await catalogBuildView(root);
      const now = view.pending.refused;
      const edits = now?.reasons.includes("hand-edits") ? (now.edits ?? []) : [];
      if (edits.length !== b.count || view.pending.plan !== b.plan)
        throw conflict(
          edits.length !== b.count
            ? `The page listed ${b.count} hand ${b.count === 1 ? "edit" : "edits"}; there ${edits.length === 1 ? "is" : "are"} ${edits.length} now. Nothing was made curated: look at the list again.`
            : "The hand edits aren't the ones the page listed any more. Nothing was made curated: look at the list again.",
        );
      const { catalogBuild, catalogEdits } = await import("./catalog-build-commands.js");
      // Keep the edits: each made a curated decision, then the build with them (which writes
      // what the edited files hold, so nothing is overwritten), in one job.
      return asJob("Make the hand edits curated, then build", () =>
        captured(async (io) => {
          const code = await catalogEdits(root, { curate: true, by: ctx.user, plan: b.plan }, io);
          return code === 0 ? catalogBuild(root, {}, io) : code;
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
      if (v.plan.hash !== b.plan)
        throw conflict(
          "The builds to take back or their files aren't the ones the page listed any more. Nothing was undone: look at the list again.",
        );
      const { catalogUndo } = await import("./catalog-build-commands.js");
      return asJob(`atticus catalog undo ${b.n} --yes`, () =>
        captured((io) => catalogUndo(root, { n: b.n, yes: true, plan: b.plan }, io)),
      );
    })
    .add("GET", "/api/build/prune", async () => {
      const { catalogPruneView } = await import("./build-report.js");
      return {
        status: 200,
        body: Api.CatalogPruneView.parse(await catalogPruneView(root)),
      };
    })
    .add("POST", "/api/build/prune", async ({ body }) => {
      const b = parse(Api.CatalogPruneRequest, body);
      const { catalogPruneView } = await import("./build-report.js");
      const v = await catalogPruneView(root);
      if (v.files.length !== b.count)
        throw conflict(
          `The page listed ${b.count} ${b.count === 1 ? "file" : "files"} to remove; there ${v.files.length === 1 ? "is" : "are"} ${v.files.length} now. Nothing was removed: look at the list again.`,
        );
      if (v.plan !== b.plan)
        throw conflict(
          "The files to remove aren't the ones the page listed any more. Nothing was removed: look at the list again.",
        );
      const { catalogPrune } = await import("./catalog-build-commands.js");
      return asJob("atticus catalog prune --yes", () =>
        captured((io) => catalogPrune(root, { yes: true, plan: b.plan }, io)),
      );
    })
    .add("GET", "/api/build/upgrade", async () => {
      const { catalogUpgradeView } = await import("./build-report.js");
      return { status: 200, body: Api.CatalogUpgradeView.parse(await catalogUpgradeView(root)) };
    })
    .add("POST", "/api/build/upgrade", async ({ body }) => {
      const b = parse(Api.CatalogUpgradeRequest, body);
      const { catalogUpgradeView } = await import("./build-report.js");
      const v = await catalogUpgradeView(root);
      if (!v.pending) throw conflict("Nothing to upgrade: catalog/sources is here already.");
      // The other steps may change an input the slots record, and would make the files written
      // differ from the ones listed: they run first (Run the upgrade, POST /api/upgrade).
      if (v.others.length)
        throw conflict(
          `Other upgrade steps wait first (${v.others.map((s) => s.summary).join("; ")}): run the upgrade (Run the upgrade, on Home or on Catalog builds) first, then look at this list again. Nothing written.`,
        );
      // A first build that changes the catalog is accepted with the count of its changes, as
      // `atticus upgrade --yes --accept-changes <n>` names it; any other count writes nothing.
      const accept = v.acceptChanges;
      if (accept > 0 && b.acceptChanges !== accept)
        throw conflict(
          b.acceptChanges === undefined
            ? `The first build gives ${accept} record ${accept === 1 ? "file" : "files"} differently: accept exactly ${accept === 1 ? "it" : "these"} with their count first. Nothing written.`
            : `The page accepted ${b.acceptChanges} ${b.acceptChanges === 1 ? "change" : "changes"}; the first build gives ${accept} record ${accept === 1 ? "file" : "files"} differently now. Nothing written: look at the list again.`,
        );
      if (accept === 0 && b.acceptChanges !== undefined)
        throw conflict(
          "The first build changes nothing now, so there is nothing to accept. Nothing written: look at the list again.",
        );
      if (v.writes.length !== b.count || v.plan !== b.plan)
        throw conflict(
          `The page listed ${b.count} ${b.count === 1 ? "file" : "files"} to write; the upgrade writes ${v.writes.length === b.count ? "other files" : `${v.writes.length}`} now. Nothing written: look at the list again.`,
        );
      const { upgradeCommand } = await import("./upgrade.js");
      return asJob(
        accept ? `atticus upgrade --yes --accept-changes ${accept}` : "atticus upgrade --yes",
        () =>
          captured((io) =>
            upgradeCommand(
              root,
              { by: ctx.user, yes: true, ...(accept ? { acceptChanges: accept } : {}) },
              io,
            ),
          ),
      );
    });
}
