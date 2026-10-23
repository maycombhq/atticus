import { spawn } from "node:child_process";
import { createLog, DEFAULT_PORT } from "@maycombhq/core";
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

/** Start the local server with the app and the write calls (ADR 0015, 0043). */
export function startUi(
  root: string,
  o: {
    port?: number;
    user?: string;
    version?: string;
    staticDir?: string;
    /** Let a VS Code panel frame the app (ADR 0091). */
    embed?: "vscode";
  } = {},
  deps: UiDeps = {},
): Promise<RunningServer> {
  return startServer({
    root,
    port: o.port ?? DEFAULT_PORT,
    ...(o.embed ? { embed: o.embed } : {}),
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
      return uiKnowledgeRoutes(uiCiteRoutes(specs, ctx), ctx);
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
  },
  io: Output,
): Promise<number> {
  let srv: RunningServer;
  try {
    srv = await startUi(root, {
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
  io.out(`Atticus is running at ${srv.url} (Ctrl+C stops it).`);
  io.out(`For assistants and scripts, the session token is ${srv.token}`);
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
