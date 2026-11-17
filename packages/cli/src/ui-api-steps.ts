import { readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Api, printToCurrent } from "@maycombhq/core";
import { badRequest, type Router, type ServerContext } from "@maycombhq/server";
import { changeWorktreesDir } from "@maycombhq/workspace";
import type { Output } from "./commands.js";

/**
 * ADR 0188: the app offers a button for every step in the daily path. The local steps a page
 * named as a command to type, run here as the person's click: each writes the metarepo's own
 * files or this machine's (ADR 0186: no confirmation), as a local job whose lines go to the
 * Console (ADR 0187). Nothing here pushes, opens a PR or calls a model.
 *
 * - POST /api/facts/apply-all: `atticus verify --all --write` (a declaration or an owner on the
 *   canvas is drawn on every repo's map).
 * - POST /api/estate/join: `atticus estate join` (the estate pass Map › Flows waits on).
 * - POST /api/knowledge/sources/sync: `atticus sources sync`, every wiki at once.
 * - POST /api/workspace/prune: `atticus workspace prune <change>`, for one change or every
 *   change with worktrees; a worktree with uncommitted work is kept, as on the command line.
 * - GET /api/changes/{changeId}/tasks/{taskId}/context: `atticus task context --markdown`, for
 *   the person to copy into their assistant.
 * - PUT /api/history/recording: `atticus history on|off`, this machine's setting.
 */

interface Ran {
  code: number;
  out: string[];
  err: string[];
  /** Beta.28: more for the job's result (Edit the map's `edits`, `built` and `callers`). */
  extra?: Record<string, unknown>;
}

/**
 * Starts a local job (ui-api.ts's, one at a time with Apply, Propose and Bring in). Beta.28.4:
 * work made of several counted parts (the repos of an Apply) says which it is on with `count`,
 * and the job's progress carries it (the strip under the top bar shows "2 of 7": two done).
 */
export type LocalJob = (
  what: string,
  work: (count: (done: number, total: number, message: string) => void) => Promise<Ran>,
) => { status: number; body: { jobId: string } };

/** A command's own code in this process, its lines kept and sent to the Console. */
export async function captured(f: (io: Output) => Promise<number>): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await f({
    out: (l) => {
      out.push(l);
      printToCurrent(l);
    },
    err: (l) => {
      err.push(l);
      printToCurrent(l);
    },
    // The hunt of beta.28.1 (S2): a write's steps and heartbeats go to the Console as they run,
    // never into the job's lines or errors.
    progress: (l) => printToCurrent(l, { now: true }),
  });
  return { code, out, err };
}

const ID = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

/** The changes that have worktrees here (workspace/.worktrees/<change>), by name. */
async function changesWithWorktrees(root: string): Promise<string[]> {
  const dir = dirname(changeWorktreesDir(root, "x"));
  return (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory() && ID.test(d.name) && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();
}

export function uiStepRoutes(r: Router, ctx: ServerContext, asJob: LocalJob): Router {
  const root = ctx.root;
  return r
    .add("POST", "/api/facts/apply-all", async ({ body }) => {
      const { factsRepos, verifyAllCommand } = await import("./verify-commands.js");
      const { APPLIED_WITH_LEFT_OUT } = await import("./verify-left-out.js");
      // Beta.28.4 (ADR 0198): the repos to apply, when the page lists them (the map's bar: the
      // repos whose corrections wait). Each is checked against the facts on file before a job
      // starts, and they run in id order whatever order they came in. No list: every repo read.
      const asked = Api.FactsApplyAllRequest.safeParse(body ?? {});
      if (!asked.success)
        throw badRequest(
          "repos is a list of one or more repo names, or left out for every repo read so far.",
        );
      let only: string[] | undefined;
      if (asked.data.repos) {
        const read = await factsRepos(root);
        const unread = [...new Set(asked.data.repos)].filter((x) => !read.includes(x)).sort();
        if (unread.length)
          throw badRequest(
            `No facts on file for ${unread.join(", ")}: nothing was started. Read the list of repos waiting again.`,
          );
        only = read.filter((x) => asked.data.repos!.includes(x));
      }
      const what = !only
        ? "Applying to every repo"
        : only.length === 1
          ? `Applying to ${only[0]}`
          : `Applying to ${only.length} repos`;
      return asJob(what, async (count) => {
        // The hunt of beta.28.1 (S2): each repo's own outcome, told by verify: a repo that wrote
        // with rejected facts left out (exit 3) is applied, as one repo's Apply is.
        const codes: number[] = [];
        const applied: string[] = [];
        const notApplied: string[] = [];
        let leftOut = 0;
        let leftOutRepos = 0;
        let total = 0;
        let stopped = false;
        const ran = await captured((io) =>
          verifyAllCommand(
            root,
            {
              write: true,
              verbose: false,
              json: false,
              ...(only ? { only } : {}),
              // Beta.28.4: the job's own progress counts the repos finished, when there are
              // several, and says the repo it is on (the strip under the top bar shows both).
              onStart: (repo, done, of) => {
                total = of;
                if (of > 1) count(done, of, `${done} of ${of} repos done, applying ${repo}`);
              },
              // Beta.28.4: Stop ended the run before these repos: not applied, by name.
              onStopped: (notReached) => {
                stopped = true;
                notApplied.push(...notReached);
              },
              onRepo: (repo, code, out) => {
                codes.push(code);
                if (total > 1) count(codes.length, total, `${codes.length} of ${total} repos done`);
                (code === 0 || code === APPLIED_WITH_LEFT_OUT ? applied : notApplied).push(repo);
                if (code === APPLIED_WITH_LEFT_OUT) {
                  leftOut += out;
                  leftOutRepos++;
                }
              },
            },
            io,
          ),
        );
        // Beta.28.4: which repos it applied and which it didn't, by name, for the page to say.
        // Stopped (the job ends stopped, whatever its code): said in its result too.
        const each = stopped
          ? { applied, notApplied, stopped: true, ...(leftOut ? { leftOut, leftOutRepos } : {}) }
          : codes.length
            ? { applied, notApplied }
            : {};
        const done =
          !stopped && ran.code !== 0 && codes.length > 0 && leftOutRepos > 0 && !notApplied.length;
        if (!done) return { ...ran, extra: each };
        return { ...ran, code: 0, extra: { ...each, leftOut, leftOutRepos } };
      });
    })
    .add("POST", "/api/estate/join", async () => {
      const { estateJoin } = await import("./estate-commands.js");
      return asJob("Joining the estate's flows", () =>
        captured((io) => estateJoin(root, { json: false }, io)),
      );
    })
    .add("POST", "/api/knowledge/sources/sync", async () => {
      const { sourcesSync } = await import("./knowledge-commands.js");
      return asJob("Syncing every wiki", () =>
        captured((io) => sourcesSync(root, io, { json: false })),
      );
    })
    .add("POST", "/api/workspace/prune", async ({ body }) => {
      const change = (body as { change?: unknown } | undefined)?.change;
      if (change !== undefined && (typeof change !== "string" || !ID.test(change)))
        throw badRequest("change is a change id, or left out for every change with worktrees.");
      const { workspacePrune } = await import("./workspace-commands.js");
      return asJob(change ? `Cleaning up ${change}'s worktrees` : "Cleaning up worktrees", () =>
        captured(async (io) => {
          const list = change ? [change] : await changesWithWorktrees(root);
          if (!list.length) {
            io.out("No change has worktrees here: nothing to clean up.");
            return 0;
          }
          let code = 0;
          for (const c of list) {
            io.out(`${c}:`);
            code = Math.max(code, await workspacePrune(root, c, {}, io));
          }
          return code;
        }),
      );
    })
    .add("GET", "/api/changes/{changeId}/tasks/{taskId}/context", async ({ params }) => {
      const { taskContextCli } = await import("./attach-commands.js");
      const lines: string[] = [];
      const errs: string[] = [];
      const code = await taskContextCli(
        root,
        params.changeId!,
        params.taskId!,
        { markdown: true },
        { out: (l) => lines.push(l), err: (l) => errs.push(l) },
      );
      if (code !== 0) throw badRequest(errs.join("\n") || "The task's context couldn't be made.");
      return { status: 200, body: { markdown: lines.join("\n") } };
    })
    .add("PUT", "/api/history/recording", async ({ body }) => {
      const on = (body as { on?: unknown } | undefined)?.on;
      if (typeof on !== "boolean") throw badRequest("on is true or false.");
      const { setLocalRecording } = await import("./history.js");
      await setLocalRecording(root, on);
      ctx.events.publish({ type: "file.changed", path: ".atticus/me.yaml" });
      return { status: 200, body: { on } };
    });
}
