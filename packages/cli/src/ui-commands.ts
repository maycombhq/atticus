import { spawn } from "node:child_process";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  catalogDirOf,
  createLog,
  DEFAULT_PORT,
  keptFilesMayHaveChanged,
  orgPackDirOf,
  trustKeptFiles,
} from "@maycombhq/core";
import { forgetCatalogs, keepCatalogsInMemory, readCatalog } from "@maycombhq/scanner";
import {
  startServer,
  type Router,
  type RunningServer,
  type ServerContext,
} from "@maycombhq/server";
import { stopAllBuilds } from "@maycombhq/taskrun";
import { uiDistDir } from "@maycombhq/ui";
import type { Output } from "./commands.js";
import { answersMayHaveChanged, keepAnswersWhileWatched } from "./watched-memo.js";
import { uiRoutes, type UiDeps } from "./ui-api.js";
import { uiRunRoutes } from "./ui-api-run.js";
import { uiMeRoutes } from "./ui-api-me.js";
import { uiKnowRoutes } from "./ui-api-know.js";
import { uiInitiativeRoutes } from "./ui-api-initiatives.js";
import { uiQuestionRoutes } from "./ui-api-questions.js";
import { uiAcrossRoutes } from "./ui-api-across.js";
import { uiGraphRoutes } from "./ui-api-graph.js";
import { uiOnboardingRoutes } from "./ui-api-onboarding.js";
import { uiSpecRoutes } from "./ui-api-specs.js";
import { uiCiteRoutes } from "./ui-api-cites.js";
import { uiKnowledgeRoutes } from "./ui-api-knowledge.js";
import { uiModelRunRoutes } from "./ui-api-runs.js";
import { uiCopilotRunRoutes } from "./ui-api-copilot-runs.js";
import { uiComponentTypeRoutes } from "./component-type-commands.js";
import { uiLinkMatchRoutes } from "./ui-api-link-match.js";
import { uiDecisionRoutes } from "./ui-api-decisions.js";
import { uiLinkRoutes } from "./ui-api-links.js";
import { uiSketchRoutes } from "./ui-api-sketch.js";
import { uiOwnerRoutes } from "./ui-api-owner.js";
import { uiDeclaredRoutes } from "./ui-api-declared.js";
import { uiHistoryRoutes } from "./ui-api-history.js";
import { uiAiRoutes } from "./ui-api-ai.js";
import { uiDocumentRoutes } from "./ui-api-documents.js";
import { uiRepoRoutes } from "./ui-api-repos.js";
import { uiCockpitRoutes } from "./ui-api-cockpit.js";
import { uiTrustRoutes } from "./ui-api-trust.js";
import { uiFactsRoutes } from "./ui-api-facts.js";
import { uiAuditRoutes } from "./ui-api-audit.js";
import { uiOutsideRoutes } from "./ui-api-outside.js";
import { uiContractsRoutes } from "./ui-api-contracts.js";
import { uiStageRoutes } from "./ui-api-stages.js";
import { asTheApp, servingTheApp } from "./model-address.js";
import { uiActivityRoutes } from "./ui-api-activity.js";
import { uiThreadRoutes } from "./ui-api-thread.js";
import { uiSetupRoutes } from "./ui-api-setup.js";
import { uiRolesRoutes } from "./ui-api-roles.js";

/**
 * Whether a changed file (root-relative, "/"-separated, as the server's live events name it) can
 * change the catalog the server keeps: a file in the catalog folder, that folder or one above
 * it (the watcher names top folders when many files change), or the org pack, whose
 * sources.yaml says where the catalog is. Anything else (doctor's probe in .atticus/, a run, a
 * question) leaves it kept: reading every record again for it made the app's screens slow.
 */
export function catalogMayHaveChanged(root: string, path: string): boolean {
  const p = path.replace(/^\.\/?/, "").replace(/\/+$/, "");
  const near = (dir: string) => {
    const rel = relative(root, dir).split(sep).join("/");
    // A folder outside the root isn't followed: any change may be the one.
    if (rel.startsWith("..") || isAbsolute(rel)) return true;
    return p === "" || p === rel || p.startsWith(rel + "/") || rel.startsWith(p + "/");
  };
  return near(catalogDirOf(root)) || near(orgPackDirOf(root));
}

/** Every route of the app's local API, on the server's base routes (one place, so a test can check the API doc against it). */
export function extendUiRoutes(
  r: Router,
  ctx: ServerContext,
  deps: UiDeps = {},
  o: { warm?: boolean } = {},
): Router {
  // Review round 50 (ADR 0186 addendum): everything a route starts, its jobs included, is the
  // app's, so a model call it makes is held to the address the person confirmed.
  const add = r.add.bind(r);
  r.add = ((method, pattern, handler, opts) =>
    add(method, pattern, (req) => asTheApp(() => handler(req)), opts)) as Router["add"];
  const known = uiKnowRoutes(uiRunRoutes(uiRoutes(r, ctx, deps), ctx, deps), ctx, {
    warm: o.warm === true,
    ...(deps.doctor ? { doctor: deps.doctor } : {}),
  });
  // UX review: initiatives started, planned and recorded in the app.
  const base = uiInitiativeRoutes(known, ctx);
  const views = uiGraphRoutes(uiAcrossRoutes(uiMeRoutes(base, ctx), ctx), ctx);
  const specs = uiSpecRoutes(uiOnboardingRoutes(uiQuestionRoutes(views, ctx), ctx), ctx);
  // ADR 0102: knowledge, a change's needs and the org pack from the wikis.
  // ADR 0106: the model runs, what they were asked and answered.
  // ADR 0110: the prompts people sent their assistant and the responses they got.
  // ADR 0121: the AI tab, how AI runs here.
  // ADR 0122: general knowledge as files, in inputs/. ADR 0123: branches you can see.
  // WP7.1: one change at a glance. ADR 0124: how far to trust each repo's map; the Map's
  // evidence and a person's correction of a fact (F3); a stage tab's findings and a comment
  // on one (B10).
  // ADR 0149: a sample audit answered in the app, and the outside systems.
  // ADR 0164: the contract check on every link (Map › Mismatches).
  // ADR 0173: an unattended Copilot run started from the app, shown live.
  // ADR 0174: correcting the map on the canvas.
  // ADR 0179: a change sketched on the canvas.
  // ADR 0181: the AI's decisions, a person's correction that spreads, and Undo of a batch.
  const all = uiComponentTypeRoutes(
    uiLinkMatchRoutes(
      uiSketchRoutes(
        uiDeclaredRoutes(
          uiOwnerRoutes(
            uiLinkRoutes(
              uiCopilotRunRoutes(
                uiStageRoutes(
                  uiContractsRoutes(
                    uiOutsideRoutes(
                      uiAuditRoutes(
                        uiFactsRoutes(
                          uiTrustRoutes(
                            uiCockpitRoutes(
                              uiRepoRoutes(
                                uiDocumentRoutes(
                                  uiAiRoutes(
                                    uiHistoryRoutes(
                                      uiModelRunRoutes(
                                        uiKnowledgeRoutes(uiCiteRoutes(specs, ctx), ctx),
                                        ctx,
                                        deps.runStep ? { runStep: deps.runStep } : {},
                                      ),
                                      ctx,
                                    ),
                                    ctx,
                                  ),
                                  ctx,
                                ),
                                ctx,
                              ),
                              ctx,
                            ),
                            ctx,
                          ),
                          ctx,
                        ),
                        ctx,
                      ),
                      ctx,
                    ),
                    ctx,
                  ),
                  ctx,
                ),
                ctx,
              ),
              ctx,
            ),
            ctx,
          ),
          ctx,
        ),
        ctx,
      ),
      ctx,
    ),
    ctx,
  );
  // ADR 0187: the Console's list of everything running or run lately, wherever it started.
  // ADR 0189: a stage of a change as one conversation, and a person's reply in it. ADR 0190:
  // settings and setup in the app, Edit then Propose. ADR 0191: roles and the business analyst
  // (owners suggested, work items, the stories' shaping, an owner question sent, a knowledge
  // section in place, Ask from knowledge).
  return uiRolesRoutes(
    uiSetupRoutes(
      uiThreadRoutes(uiActivityRoutes(uiDecisionRoutes(all, ctx), ctx), ctx),
      ctx,
      deps.openFolder ? { openFolder: deps.openFolder } : {},
    ),
    ctx,
    {
      ...(deps.notify ? { notify: deps.notify } : {}),
      ...(deps.workTracker ? { workTracker: deps.workTracker } : {}),
      ...(deps.now ? { now: () => new Date(deps.now!) } : {}),
    },
  );
}

/** Start the local server with the app and the write calls (ADR 0015, 0043). */
export async function startUi(
  root: string,
  o: {
    port?: number;
    user?: string;
    version?: string;
    staticDir?: string;
    /** Let a VS Code panel frame the app (ADR 0091). */
    embed?: "vscode";
    /** Every page in the app's menu, not only the six entries (`atticus ui --full`). */
    full?: boolean;
    /** The session token the editor that started it made (ATTICUS_UI_TOKEN). */
    token?: string;
    /**
     * The page key the editor that started it made (ATTICUS_UI_PAGE_KEY, ADR 0186): a page the
     * editor serves from its own files asks for the person's confirmations with it.
     */
    pageKey?: string;
    /** Start the machine checks as the server starts, for the Set up page's first load. */
    warm?: boolean;
  } = {},
  deps: UiDeps = {},
): Promise<RunningServer> {
  const srv = await startServer({
    root,
    port: o.port ?? DEFAULT_PORT,
    ...(o.embed ? { embed: o.embed } : {}),
    ...(o.full ? { full: true } : {}),
    ...(o.token ? { token: o.token } : {}),
    ...(o.pageKey ? { pageKey: o.pageKey } : {}),
    staticDir: o.staticDir ?? uiDistDir(),
    ...(o.user ? { user: o.user } : {}),
    ...(o.version ? { version: o.version } : {}),
    onRequest: (() => {
      const log = createLog(root);
      return (r) => {
        // beta.23: a call that may have written: the answers kept are worked out again.
        if (r.method !== "GET" && r.method !== "HEAD") {
          answersMayHaveChanged();
          keptFilesMayHaveChanged();
        }
        const fields = { method: r.method, path: r.path, status: r.status, ms: r.ms };
        if (r.error) log.error("request", r.error, fields);
        else if (r.status >= 500) log.warn("request", fields);
        else log.debug("request", fields);
      };
    })(),
    extend: (r, ctx) => extendUiRoutes(r, ctx, deps, { warm: o.warm === true }),
  });
  // ADR 0119: the catalog is read once and kept while the server runs; any file change it
  // hears (its watcher, its own writes, a scan) means the next read reads the files again.
  keepCatalogsInMemory(true);
  // Review round 50: every model call this process makes while it serves is the app's.
  servingTheApp(true);
  // Read it now, while nobody waits, so the first page doesn't pay for it.
  void readCatalog(join(catalogDirOf(root), "generated"), { cacheRoot: root }).catch(
    () => undefined,
  );
  // beta.23: the answers Home asks for again and again are kept until a change is heard.
  // Whether the watcher follows the files, asked of it at most once a second (it lists them).
  let followed = { at: 0, yes: false };
  const following = () => {
    if (Date.now() - followed.at > 1000)
      followed = { at: Date.now(), yes: srv.following.length > 0 };
    return followed.yes;
  };
  const unkeep = keepAnswersWhileWatched(root, following);
  // And the small files read (each question, the org pack's files, each repo's facts) aren't
  // checked again, while nothing here writes, until a change is heard.
  trustKeptFiles(() => srv.quiet && following());
  const stop = srv.events.listen((e) => {
    const changed =
      e.type === "file.changed" &&
      (typeof e.path !== "string" || catalogMayHaveChanged(root, e.path));
    if (changed || e.type === "index.rebuilt") forgetCatalogs();
    if (e.type === "file.changed" || e.type === "index.rebuilt" || e.type === "job.done") {
      answersMayHaveChanged();
      // Only the files at or under the path the watcher names are checked again.
      keptFilesMayHaveChanged(
        e.type === "file.changed" && typeof e.path === "string" ? join(root, e.path) : undefined,
      );
    }
  });
  const close = srv.close;
  return Object.assign(srv, {
    close: async () => {
      stop();
      unkeep();
      trustKeptFiles(undefined);
      keepCatalogsInMemory(false);
      servingTheApp(false);
      await close();
    },
  });
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // No browser to open: the URL is printed anyway.
  }
}

/**
 * Resolves on Ctrl+C or SIGTERM. With --embed vscode it also resolves when stdin closes: the
 * extension holds that pipe open, so the app ends with the window that started it, even when
 * the window or its extension host is killed and nothing gets to stop it. With --parent <pid> it
 * also resolves once that process is gone: an editor (the IntelliJ plugin) that started it and
 * was killed leaves no server behind.
 */
export function untilStopped(
  embedded: boolean,
  stdin: NodeJS.ReadableStream = process.stdin,
  o: { parent?: number; alive?: (pid: number) => boolean; everyMs?: number } = {},
): Promise<void> {
  return new Promise<void>((resolve) => {
    const alive =
      o.alive ??
      ((pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (e) {
          // EPERM: it is there, run by someone else.
          return (e as NodeJS.ErrnoException).code === "EPERM";
        }
      });
    const watch =
      o.parent !== undefined
        ? setInterval(() => {
            if (!alive(o.parent!)) stop();
          }, o.everyMs ?? 2000)
        : undefined;
    const stop = () => {
      if (watch) clearInterval(watch);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (embedded) {
        stdin.off("end", stop);
        stdin.off("close", stop);
        stdin.pause();
      }
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (embedded) {
      stdin.once("end", stop);
      stdin.once("close", stop);
      // Read and drop what comes: the stream only ends once it flows.
      stdin.on("data", () => undefined);
      stdin.resume();
    }
  });
}

/**
 * What `atticus ui` prints once it runs. The token drives the API, so it is printed only on
 * request in a person's own terminal, not into every terminal and its scrollback (ADR 0119).
 * Never when an editor started the app (--embed, --parent): what it prints lands in the editor's
 * output log, the file people attach to a support ticket. VS Code gives the app its token
 * (ATTICUS_UI_TOKEN); IntelliJ's page has it.
 */
export function startedLines(
  url: string,
  token: string,
  o: { showToken?: boolean; embed?: "vscode"; parent?: number },
): string[] {
  return [
    `Atticus is running at ${url} (Ctrl+C stops it).`,
    o.embed || o.parent !== undefined
      ? "The session token isn't printed: the editor that started the app has it."
      : o.showToken
        ? `For assistants and scripts, the session token is ${token}`
        : "The page has the session token; --show-token prints it for an assistant or a script.",
    // ADR 0186: what the printed token can't do, said where it is printed.
    ...(o.showToken && !o.embed && o.parent === undefined
      ? [
          "It doesn't approve a write to a shared system (a PR, a push, a merge, a message): a person confirms those in the app, or runs the command with --approve.",
        ]
      : []),
  ];
}

/**
 * atticus ui [--port n] [--open] [--by handle]: serve the app on 127.0.0.1 until Ctrl+C. The session token
 * is new each start and is handed to the app inside its page, so only this machine's browser,
 * on a page from this server, can drive the API.
 */
export async function uiCommand(
  root: string,
  o: {
    port?: number;
    open?: boolean;
    version?: string;
    user?: string;
    embed?: "vscode";
    parent?: number;
    /** Print the session token (ADR 0119): an editor that starts the app reads it, a person rarely needs it. */
    showToken?: boolean;
    /** Every page a tab of its section, and the menu's More pages open (the Surfaces design). */
    full?: boolean;
  },
  io: Output,
): Promise<number> {
  // The editor's token, read once and kept from the commands the app runs.
  const given = o.embed ? process.env.ATTICUS_UI_TOKEN : undefined;
  delete process.env.ATTICUS_UI_TOKEN;
  // ADR 0186: the editor's page key too, for a panel it serves from its own files; never printed.
  const pageKey = o.embed ? process.env.ATTICUS_UI_PAGE_KEY : undefined;
  delete process.env.ATTICUS_UI_PAGE_KEY;
  let srv: RunningServer;
  try {
    srv = await startUi(root, {
      ...(given ? { token: given } : {}),
      ...(pageKey ? { pageKey } : {}),
      warm: true,
      ...(o.full ? { full: true } : {}),
      ...(o.port !== undefined ? { port: o.port } : {}),
      ...(o.user ? { user: o.user } : {}),
      ...(o.version ? { version: o.version } : {}),
      ...(o.embed ? { embed: o.embed } : {}),
    });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    io.err(
      code === "EADDRINUSE"
        ? `Port ${o.port ?? DEFAULT_PORT} is in use. Start with --port <another port>.`
        : `Couldn't start the app: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }
  for (const l of startedLines(srv.url, srv.token, o)) io.out(l);
  const p = srv.person;
  io.out(
    p.source === "git"
      ? `You are ${p.handle}${p.name ? ` (${p.name})` : ""}, from your Git user.`
      : `You are ${p.handle}.`,
  );
  if (p.warning) io.err(p.warning);
  if (o.open) openBrowser(srv.url);
  await untilStopped(
    o.embed === "vscode",
    process.stdin,
    o.parent !== undefined ? { parent: o.parent } : {},
  );
  // A task run's build stops with the app, and the run does nothing more (no fix round, no
  // commit); on Windows the signal never reached the build's own handler, so it is stopped here.
  stopAllBuilds();
  await srv.close();
  io.out("Stopped.");
  return 0;
}
