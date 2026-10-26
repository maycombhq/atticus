import { spawn } from "node:child_process";
import { isAbsolute, join, relative, sep } from "node:path";
import { catalogDirOf, createLog, DEFAULT_PORT, orgPackDirOf } from "@maycombhq/core";
import { forgetCatalogs, keepCatalogsInMemory, readCatalog } from "@maycombhq/scanner";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiDistDir } from "@maycombhq/ui";
import type { Output } from "./commands.js";
import { uiRoutes, type UiDeps } from "./ui-api.js";
import { uiRunRoutes } from "./ui-api-run.js";
import { uiMeRoutes } from "./ui-api-me.js";
import { uiKnowRoutes } from "./ui-api-know.js";
import { uiQuestionRoutes } from "./ui-api-questions.js";
import { uiAcrossRoutes } from "./ui-api-across.js";
import { uiGraphRoutes } from "./ui-api-graph.js";
import { uiOnboardingRoutes } from "./ui-api-onboarding.js";
import { uiSpecRoutes } from "./ui-api-specs.js";
import { uiCiteRoutes } from "./ui-api-cites.js";
import { uiKnowledgeRoutes } from "./ui-api-knowledge.js";
import { uiModelRunRoutes } from "./ui-api-runs.js";
import { uiHistoryRoutes } from "./ui-api-history.js";
import { uiAiRoutes } from "./ui-api-ai.js";
import { uiDocumentRoutes } from "./ui-api-documents.js";
import { uiRepoRoutes } from "./ui-api-repos.js";
import { uiCockpitRoutes } from "./ui-api-cockpit.js";
import { uiTrustRoutes } from "./ui-api-trust.js";
import { uiFactsRoutes } from "./ui-api-facts.js";
import { uiStageRoutes } from "./ui-api-stages.js";

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
  } = {},
  deps: UiDeps = {},
): Promise<RunningServer> {
  const srv = await startServer({
    root,
    port: o.port ?? DEFAULT_PORT,
    ...(o.embed ? { embed: o.embed } : {}),
    ...(o.full ? { full: true } : {}),
    staticDir: o.staticDir ?? uiDistDir(),
    ...(o.user ? { user: o.user } : {}),
    ...(o.version ? { version: o.version } : {}),
    onRequest: (() => {
      const log = createLog(root);
      return (r) => {
        const fields = { method: r.method, path: r.path, status: r.status, ms: r.ms };
        if (r.error) log.error("request", r.error, fields);
        else if (r.status >= 500) log.warn("request", fields);
        else log.debug("request", fields);
      };
    })(),
    extend: (r, ctx) => {
      const base = uiKnowRoutes(uiRunRoutes(uiRoutes(r, ctx, deps), ctx, deps), ctx);
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
      return uiStageRoutes(
        uiFactsRoutes(
          uiTrustRoutes(
            uiCockpitRoutes(
              uiRepoRoutes(
                uiDocumentRoutes(
                  uiAiRoutes(
                    uiHistoryRoutes(
                      uiModelRunRoutes(uiKnowledgeRoutes(uiCiteRoutes(specs, ctx), ctx), ctx),
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
    },
  });
  // ADR 0119: the catalog is read once and kept while the server runs; any file change it
  // hears (its watcher, its own writes, a scan) means the next read reads the files again.
  keepCatalogsInMemory(true);
  // Read it now, while nobody waits, so the first page doesn't pay for it.
  void readCatalog(join(catalogDirOf(root), "generated")).catch(() => undefined);
  const stop = srv.events.listen((e) => {
    const changed =
      e.type === "file.changed" &&
      (typeof e.path !== "string" || catalogMayHaveChanged(root, e.path));
    if (changed || e.type === "index.rebuilt") forgetCatalogs();
  });
  const close = srv.close;
  return Object.assign(srv, {
    close: async () => {
      stop();
      keepCatalogsInMemory(false);
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
 * What `atticus ui` prints once it runs. The token drives the API, so it is printed only for an
 * editor that started the app (it reads it from here) or on request, not into every terminal and
 * its scrollback (ADR 0119).
 */
export function startedLines(
  url: string,
  token: string,
  o: { showToken?: boolean; embed?: "vscode"; parent?: number },
): string[] {
  return [
    `Atticus is running at ${url} (Ctrl+C stops it).`,
    o.showToken || o.embed || o.parent !== undefined
      ? `For assistants and scripts, the session token is ${token}`
      : "The page has the session token; --show-token prints it for an assistant or a script.",
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
  let srv: RunningServer;
  try {
    srv = await startUi(root, {
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
  await srv.close();
  io.out("Stopped.");
  return 0;
}
