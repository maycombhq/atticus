import { spawn } from "node:child_process";
import {
  IdempotencyAnswer,
  PingResponse,
  RunProgress,
  RunResult,
  SECRET_KEY_PATTERN,
  type ExecutorConfig,
  type RunRequest,
} from "@maycombhq/core";

/**
 * The three executor transports of contract C4 (ADR 0033), behind one client interface:
 *
 * - `http`: `GET /ping`, `POST /run` (202 with a run id, or 200 with the result),
 *   `GET /runs/<id>` polled for progress and the result, `GET /idempotency/<key>`. Only on
 *   127.0.0.1 (or ::1, localhost) unless the procedure lists the host.
 * - `command`: the program is started per call; one JSON request line on stdin, JSON lines on
 *   stdout (progress, then one result, pong or checked).
 * - `mcp`: an MCP server over stdio (newline-delimited JSON-RPC 2.0): initialize, then
 *   `tools/list` for ping and `tools/call` for a run; a tool per step (`<procedure>_<step>` or
 *   the config's `tools` map); `atticus_check_idempotency` answers idempotency checks.
 *
 * Atticus never passes credentials: a started program gets the environment without any
 * variable whose name looks like a secret, and requests carry none.
 */

export class TransportError extends Error {
  constructor(
    readonly kind: "unreachable" | "timed-out" | "protocol",
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export interface ExecutorClient {
  ping(): Promise<PingResponse>;
  check(idempotencyKey: string): Promise<IdempotencyAnswer | undefined>;
  run(request: RunRequest, onProgress?: (p: RunProgress) => void): Promise<RunResult>;
}

/** The environment for a program Atticus starts: nothing that looks like a credential. */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_KEY_PATTERN.test(k)));
}

const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLocalUrl(url: string): boolean {
  try {
    return LOCAL.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ http

export function httpClient(cfg: ExecutorConfig, o: { pollMs?: number } = {}): ExecutorClient {
  const base = cfg.url!.replace(/\/+$/, "");
  const call = async (path: string, init: RequestInit = {}, timeoutMs = cfg.timeoutMs) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}${path}`, { ...init, signal: ac.signal });
      const text = await res.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        throw new TransportError(
          "protocol",
          `${cfg.name} answered ${path} with something that isn't JSON`,
        );
      }
      return { status: res.status, body };
    } catch (e) {
      if (e instanceof TransportError) throw e;
      if ((e as Error).name === "AbortError")
        throw new TransportError(
          "timed-out",
          `${cfg.name} didn't answer ${path} within ${timeoutMs} ms`,
        );
      throw new TransportError(
        "unreachable",
        `${cfg.name} can't be reached at ${base}: ${(e as Error).message}`,
      );
    } finally {
      clearTimeout(t);
    }
  };
  return {
    async ping() {
      const r = await call("/ping", {}, Math.min(cfg.timeoutMs, 5000));
      return PingResponse.parse(r.body);
    },
    async check(key) {
      const r = await call(`/idempotency/${encodeURIComponent(key)}`);
      if (r.status === 404) return undefined;
      return IdempotencyAnswer.parse(r.body);
    },
    async run(request, onProgress) {
      const deadline = Date.now() + cfg.timeoutMs;
      const started = await call("/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const done = RunResult.safeParse(started.body);
      if (started.status === 200 && done.success) return done.data;
      if (started.status !== 202 && started.status !== 200)
        throw new TransportError(
          "protocol",
          `${cfg.name} refused the run (HTTP ${started.status})`,
        );
      const runId = (started.body as { runId?: string })?.runId ?? request.runId;
      let seen = 0;
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0)
          throw new TransportError(
            "timed-out",
            `${cfg.name} didn't finish within ${cfg.timeoutMs} ms`,
          );
        const r = await call(`/runs/${encodeURIComponent(runId)}`, {}, left);
        const b = (r.body ?? {}) as { progress?: unknown[]; result?: unknown };
        for (const p of (b.progress ?? []).slice(seen)) {
          const pp = RunProgress.safeParse(p);
          if (pp.success) onProgress?.(pp.data);
        }
        seen = b.progress?.length ?? seen;
        if (b.result) return RunResult.parse(b.result);
        await sleep(Math.min(o.pollMs ?? 50, Math.max(1, deadline - Date.now())));
      }
    },
  };
}

// ------------------------------------------------------------------ command

/** Start a program, send it one line, and hand back each JSON line until `stop` says so. */
function exchange(
  cfg: ExecutorConfig,
  line: unknown,
  onLine: (msg: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cfg.command!, cfg.args, {
        env: cleanEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      reject(
        new TransportError("unreachable", `${cfg.name} can't be started: ${(e as Error).message}`),
      );
      return;
    }
    let buf = "";
    let finished = false;
    const finish = (err?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(
      () =>
        finish(new TransportError("timed-out", `${cfg.name} didn't finish within ${timeoutMs} ms`)),
      timeoutMs,
    );
    child.on("error", (e) =>
      finish(new TransportError("unreachable", `${cfg.name} can't be started: ${e.message}`)),
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!l) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(l) as Record<string, unknown>;
        } catch {
          continue; // a program may log plain text; only JSON lines are messages
        }
        try {
          if (onLine(msg)) finish();
        } catch (e) {
          finish(e as Error);
        }
      }
    });
    child.on("close", (code) =>
      finish(new TransportError("protocol", `${cfg.name} exited (code ${code}) before answering`)),
    );
    child.stdin.on("error", () => undefined);
    child.stdin.end(`${JSON.stringify(line)}\n`);
  });
}

export function commandClient(cfg: ExecutorConfig): ExecutorClient {
  return {
    async ping() {
      let pong: PingResponse | undefined;
      await exchange(
        cfg,
        { type: "ping" },
        (m) => {
          if (m.type !== "pong") return false;
          pong = PingResponse.parse(m);
          return true;
        },
        Math.min(cfg.timeoutMs, 10_000),
      );
      return pong!;
    },
    async check(key) {
      let ans: IdempotencyAnswer | undefined;
      await exchange(
        cfg,
        { type: "check", idempotencyKey: key },
        (m) => {
          if (m.type !== "checked") return false;
          ans = IdempotencyAnswer.parse(m);
          return true;
        },
        cfg.timeoutMs,
      );
      return ans;
    },
    async run(request, onProgress) {
      let result: RunResult | undefined;
      await exchange(
        cfg,
        request,
        (m) => {
          if (m.type === "progress") {
            const p = RunProgress.safeParse(m);
            if (p.success) onProgress?.(p.data);
            return false;
          }
          if (m.type !== "result") return false;
          result = RunResult.parse(m);
          return true;
        },
        cfg.timeoutMs,
      );
      return result!;
    },
  };
}

// ------------------------------------------------------------------ mcp

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const IDEMPOTENCY_TOOL = "atticus_check_idempotency";

/** The tool for a step: the config's map, else `<procedure>_<step>` with safe characters. */
export function toolName(cfg: ExecutorConfig, procedure: string, step: string): string {
  return (
    cfg.tools[`${procedure}/${step}`] ?? `${procedure}_${step}`.replace(/[^A-Za-z0-9_-]/g, "_")
  );
}

/** One MCP session over stdio: initialize, then the calls, then close. */
async function mcpSession<T>(
  cfg: ExecutorConfig,
  timeoutMs: number,
  work: (
    rpc: (method: string, params?: unknown) => Promise<unknown>,
    notes: (fn: (m: Record<string, unknown>) => void) => void,
  ) => Promise<T>,
): Promise<T> {
  let child;
  try {
    child = spawn(cfg.command!, cfg.args, {
      env: cleanEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (e) {
    throw new TransportError(
      "unreachable",
      `${cfg.name} can't be started: ${(e as Error).message}`,
    );
  }
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let listener: ((m: Record<string, unknown>) => void) | undefined;
  let next = 1;
  let buf = "";
  let dead: Error | undefined;
  const failAll = (e: Error) => {
    dead ??= e;
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  child.on("error", (e) =>
    failAll(new TransportError("unreachable", `${cfg.name} can't be started: ${e.message}`)),
  );
  child.on("close", (code) =>
    failAll(new TransportError("protocol", `${cfg.name} exited (code ${code})`)),
  );
  child.stdin.on("error", () => undefined);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!l) continue;
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(l) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof m.id === "number" && pending.has(m.id)) {
        const p = pending.get(m.id)!;
        pending.delete(m.id);
        if (m.error)
          p.reject(
            new TransportError(
              "protocol",
              `${cfg.name}: ${(m.error as { message?: string }).message ?? "error"}`,
            ),
          );
        else p.resolve(m.result);
      } else if (typeof m.method === "string") listener?.(m);
    }
  });
  const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const rpc = (method: string, params?: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      if (dead) return reject(dead);
      const id = next++;
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_r, reject) => {
    timer = setTimeout(
      () =>
        reject(new TransportError("timed-out", `${cfg.name} didn't finish within ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      (async () => {
        await rpc("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "atticus", version: "0.0.1" },
        });
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        return work(rpc, (fn) => (listener = fn));
      })(),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
  }
}

const ToolList = (v: unknown) =>
  ((v as { tools?: { name: string }[] })?.tools ?? []).map((t) => t.name);

function resultOf(raw: unknown, runId: string): RunResult {
  const r = (raw ?? {}) as {
    structuredContent?: unknown;
    content?: { type: string; text?: string }[];
    isError?: boolean;
  };
  let data: unknown = r.structuredContent;
  if (data === undefined) {
    const text = r.content?.find((c) => c.type === "text")?.text;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text };
    }
  }
  const d = (data ?? {}) as Record<string, unknown>;
  return RunResult.parse({
    type: "result",
    runId,
    status: r.isError ? "failed" : ((d.status as string) ?? "done"),
    outputs: (d.outputs as object) ?? {},
    evidence: (d.evidence as unknown[]) ?? [],
    ...(typeof d.message === "string" ? { message: d.message } : {}),
  });
}

export function mcpClient(cfg: ExecutorConfig): ExecutorClient {
  const reverse = new Map(Object.entries(cfg.tools).map(([k, v]) => [v, k]));
  return {
    async ping() {
      return mcpSession(cfg, Math.min(cfg.timeoutMs, 10_000), async (rpc) => {
        const tools = ToolList(await rpc("tools/list")).filter((t) => t !== IDEMPOTENCY_TOOL);
        return PingResponse.parse({
          type: "pong",
          name: cfg.name,
          version: "mcp",
          procedures: tools.map((t) => reverse.get(t) ?? t),
          fillOnly: cfg.fillOnly,
        });
      });
    },
    async check(key) {
      return mcpSession(cfg, cfg.timeoutMs, async (rpc) => {
        if (!ToolList(await rpc("tools/list")).includes(IDEMPOTENCY_TOOL)) return undefined;
        const r = resultOf(
          await rpc("tools/call", { name: IDEMPOTENCY_TOOL, arguments: { idempotencyKey: key } }),
          "check",
        );
        return { type: "checked" as const, idempotencyKey: key, used: r.outputs.used !== false };
      });
    },
    async run(request, onProgress) {
      return mcpSession(cfg, cfg.timeoutMs, async (rpc, notes) => {
        const name = toolName(cfg, request.procedure, request.step);
        if (!ToolList(await rpc("tools/list")).includes(name))
          throw new TransportError(
            "protocol",
            `${cfg.name} has no tool ${name} for ${request.procedure}/${request.step}`,
          );
        notes((m) => {
          if (m.method !== "notifications/progress") return;
          const p = (m.params ?? {}) as {
            progressToken?: string;
            message?: string;
            progress?: number;
            total?: number;
          };
          if (p.progressToken !== request.runId || !p.message) return;
          onProgress?.({
            type: "progress",
            runId: request.runId,
            message: p.message,
            ...(typeof p.progress === "number" && p.total
              ? { percent: Math.min(100, (p.progress / p.total) * 100) }
              : {}),
          });
        });
        const { inputs, ...meta } = request;
        const raw = await rpc("tools/call", {
          name,
          arguments: inputs,
          _meta: { progressToken: request.runId, atticus: meta },
        });
        return resultOf(raw, request.runId);
      });
    },
  };
}

export function clientFor(cfg: ExecutorConfig): ExecutorClient {
  if (cfg.transport === "http") return httpClient(cfg);
  if (cfg.transport === "command") return commandClient(cfg);
  return mcpClient(cfg);
}
