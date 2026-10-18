import { spawn } from "node:child_process";
import { DEFAULT_PORT } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiDistDir } from "@maycombhq/ui";
import type { Output } from "./commands.js";
import { uiRoutes, type UiDeps } from "./ui-api.js";
import { uiRunRoutes } from "./ui-api-run.js";

/** Start the local server with the app and the write calls (ADR 0015, 0043). */
export function startUi(
  root: string,
  o: { port?: number; user?: string; version?: string; staticDir?: string } = {},
  deps: UiDeps = {},
): Promise<RunningServer> {
  return startServer({
    root,
    port: o.port ?? DEFAULT_PORT,
    staticDir: o.staticDir ?? uiDistDir(),
    ...(o.user ? { user: o.user } : {}),
    ...(o.version ? { version: o.version } : {}),
    extend: (r, ctx) => uiRunRoutes(uiRoutes(r, ctx, deps), ctx, deps),
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
 * atticus ui [--port n] [--open]: serve the app on 127.0.0.1 until Ctrl+C. The session token
 * is new each start and is handed to the app inside its page, so only this machine's browser,
 * on a page from this server, can drive the API.
 */
export async function uiCommand(
  root: string,
  o: { port?: number; open?: boolean; version?: string },
  io: Output,
): Promise<number> {
  let srv: RunningServer;
  try {
    srv = await startUi(root, {
      ...(o.port !== undefined ? { port: o.port } : {}),
      ...(o.version ? { version: o.version } : {}),
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
  if (o.open) openBrowser(srv.url);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await srv.close();
  io.out("Stopped.");
  return 0;
}
