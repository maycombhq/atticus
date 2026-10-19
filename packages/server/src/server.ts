import { randomBytes, timingSafeEqual } from "node:crypto";
import { userInfo } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { DEFAULT_PORT } from "@maycombhq/core";
import { HttpError, notFound, conflict, problem, Router } from "./http.js";
import { JobManager } from "./jobs.js";
import { apiRoutes, type Context } from "./routes.js";
import { appCsp, staticFile } from "./static.js";
import { upgrade, type Socket } from "./ws.js";

/** A live event (contract C4 LiveEvent): file, job, index and run changes. */
export type LiveEvent = { type: string } & Record<string, unknown>;

export class EventHub {
  private sockets = new Set<Socket>();
  add(s: Socket) {
    this.sockets.add(s);
  }
  remove(s: Socket) {
    this.sockets.delete(s);
  }
  get size() {
    return this.sockets.size;
  }
  publish(e: LiveEvent) {
    const text = JSON.stringify(e);
    for (const s of this.sockets) s.send(text);
  }
  closeAll() {
    for (const s of [...this.sockets]) s.close();
  }
}

export interface ServerOptions {
  /** The metarepo the API reads and writes. */
  root: string;
  /** Default 4321; 0 picks a free port. */
  port?: number;
  /** Only the loopback address is allowed (ADR 0015). */
  host?: string;
  /** Who is signed in (health); default the OS user. */
  user?: string;
  /** The Atticus version reported by health. */
  version?: string;
  /**
   * More routes, registered by whoever starts the server (the CLI adds the write calls, which
   * run the same command functions the terminal does).
   */
  extend?: (r: Router, ctx: ServerContext) => void;
  /** The built app to hand out at / (the UI package's dist folder). */
  staticDir?: string;
  /** Told about every API call when it ends: method, path (no query), status and time. */
  onRequest?: (r: {
    method: string;
    path: string;
    status: number;
    ms: number;
    error?: Error;
  }) => void;
}

export interface ServerContext extends Context {
  events: EventHub;
  jobs: JobManager;
}

export interface RunningServer {
  url: string;
  port: number;
  /** New every start; every API call must send it as X-Atticus-Token. */
  token: string;
  events: EventHub;
  jobs: JobManager;
  close(): Promise<void>;
}

const MAX_BODY = 4 * 1024 * 1024;

function osUser(): string {
  try {
    return userInfo().username || "unknown";
  } catch {
    return "unknown";
  }
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "The request body is too large");
    chunks.push(c as Buffer);
  }
  if (size === 0) return undefined;
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("application/json"))
    throw new HttpError(415, "Send the body as application/json");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "The request isn't valid", "The body is not valid JSON.");
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

/**
 * The local server (ADR 0015): binds 127.0.0.1 only, every API call carries the session token,
 * and requests from other sites or host names are refused, so neither another program's web
 * page nor a DNS-rebinding page can drive it.
 */
export async function startServer(o: ServerOptions): Promise<RunningServer> {
  const host = o.host ?? "127.0.0.1";
  if (host !== "127.0.0.1")
    throw new Error(`Atticus only listens on 127.0.0.1 (asked for ${host}).`);
  const token = randomBytes(32).toString("base64url");
  const events = new EventHub();
  const jobs = new JobManager((e) => events.publish(e));
  const ctx: ServerContext = {
    root: o.root,
    user: o.user ?? process.env.USER ?? process.env.USERNAME ?? osUser(),
    version: o.version ?? "0.0.0",
    events,
    jobs,
  };
  const router = apiRoutes(new Router(), ctx)
    .add("GET", "/api/jobs/{jobId}", ({ params }) => {
      const j = jobs.get(params.jobId!);
      if (!j) throw notFound(`There is no job ${params.jobId}.`);
      return { status: 200, body: j };
    })
    .add("POST", "/api/jobs/{jobId}/cancel", ({ params }) => {
      const j = jobs.get(params.jobId!);
      if (!j) throw notFound(`There is no job ${params.jobId}.`);
      if (!jobs.cancel(j.id)) throw conflict(`Job ${j.id} already finished (${j.state}).`);
      return { status: 200, body: j };
    });
  o.extend?.(router, ctx);
  let port = 0;

  /** Host must be this server (DNS rebinding); Origin, when a browser sends one, too. */
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const guard = (req: IncomingMessage, url: URL, tokenFromQuery: boolean) => {
    if (!allowedHosts().has(req.headers.host ?? ""))
      throw new HttpError(403, "Requests must be addressed to this server");
    const origin = req.headers.origin;
    if (origin && !allowedHosts().has(origin.replace(/^https?:\/\//, "")))
      throw new HttpError(403, "Requests from other sites are not allowed");
    const given =
      (req.headers["x-atticus-token"] as string | undefined) ??
      (tokenFromQuery ? (url.searchParams.get("token") ?? undefined) : undefined);
    if (!given || !sameToken(given, token))
      throw new HttpError(401, "Missing or wrong session token");
  };

  const server = createServer(async (req, res) => {
    const t0 = Date.now();
    const done = (status: number, error?: Error) => {
      const path = (req.url ?? "/").split("?")[0]!;
      if (path.startsWith("/api/"))
        o.onRequest?.({
          method: req.method ?? "GET",
          path,
          status,
          ms: Date.now() - t0,
          ...(error ? { error } : {}),
        });
    };
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!url.pathname.startsWith("/api/")) {
        if (!allowedHosts().has(req.headers.host ?? ""))
          throw new HttpError(403, "Requests must be addressed to this server");
        if (!o.staticDir || (req.method !== "GET" && req.method !== "HEAD"))
          throw new HttpError(404, "Not found", `Nothing is served at ${url.pathname}.`);
        const f = await staticFile(o.staticDir, url.pathname, token);
        res.writeHead(f.status, {
          "Content-Type": f.type,
          "Cache-Control": f.cache,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": appCsp(port),
        });
        res.end(req.method === "HEAD" ? undefined : f.body);
        return;
      }
      guard(req, url, false);
      const m = router.match(req.method ?? "GET", url.pathname);
      if ("allowed" in m) {
        if (m.allowed.length === 0)
          throw new HttpError(404, "Not found", `There is no API call ${url.pathname}.`);
        throw new HttpError(405, "Method not allowed", `Use ${m.allowed.join(" or ")}.`);
      }
      const body = await readBody(req);
      const out = await m.handler({
        method: req.method ?? "GET",
        path: url.pathname,
        params: m.params,
        query: url.searchParams,
        body,
      });
      send(res, out.status, out.body);
      done(out.status);
    } catch (e) {
      const err =
        e instanceof HttpError
          ? e
          : new HttpError(500, "Something went wrong", e instanceof Error ? e.message : String(e));
      send(res, err.status, problem(err), "application/problem+json");
      done(err.status, err.status >= 500 && e instanceof Error ? e : undefined);
    }
  });

  server.on("upgrade", (req: IncomingMessage, sock: Duplex) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (url.pathname !== "/api/events") throw new HttpError(404, "Not found");
      guard(req, url, true);
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(400, "Bad request");
      sock.end(`HTTP/1.1 ${err.status} ${err.title}\r\nConnection: close\r\n\r\n`);
      return;
    }
    const s = upgrade(req, sock, (x) => events.remove(x));
    if (s) events.add(s);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? DEFAULT_PORT, host, () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token,
    events,
    jobs,
    close: () =>
      new Promise<void>((resolve) => {
        events.closeAll();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
