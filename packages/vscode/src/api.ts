import { request } from "node:http";
import { WORDS } from "./words";

/**
 * The app's local API on 127.0.0.1 (ADR 0015, 0093), with the session token `atticus ui` printed.
 * The sidebar reads through it; the app in a panel (ADR 0097) makes its calls through it. Nothing
 * here goes off the machine.
 */

export class ApiFailed extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Review of beta.23: a call the running app hasn't answered in time. The app is up (it took the
 * call) and may well finish it: never said as "the app isn't answering".
 */
export class ApiTimedOut extends ApiFailed {
  constructor(
    readonly path: string,
    readonly afterMs: number,
  ) {
    super(WORDS.appSlowDetail(path, Math.round(afterMs / 1000)), 0);
  }
}

/** How long a read waits for the app's answer. */
export const READ_TIMEOUT_MS = 30_000;
/**
 * How long a write waits (review of beta.23): a task run's Done builds, fixes and commits, a live
 * work-tracker sync calls the tracker per item; the app goes on with them either way, so a short
 * wait only told the page "the app is down" while the write went through.
 */
export const WRITE_TIMEOUT_MS = 10 * 60_000;

export class AtticusApi {
  constructor(
    readonly url: string,
    private readonly token: string,
    private readonly wait: { readMs: number; writeMs: number } = {
      readMs: READ_TIMEOUT_MS,
      writeMs: WRITE_TIMEOUT_MS,
    },
  ) {}

  get<T>(path: string): Promise<T> {
    return this.call<T>("GET", path);
  }

  /** A write the person asked for (a finding's action): JSON in, the API's answer out. */
  post<T>(path: string, body: unknown): Promise<T> {
    return this.call<T>("POST", path, body);
  }

  /** Any call, with its status and body as they came: the app in a panel reads problems itself. */
  request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { "X-Atticus-Token": this.token };
      const text = body === undefined ? undefined : JSON.stringify(body);
      if (text !== undefined) headers["Content-Type"] = "application/json";
      const timeout = method === "GET" || method === "HEAD" ? this.wait.readMs : this.wait.writeMs;
      let timedOut = false;
      const r = request(this.url + path, { method, headers, timeout }, (res) => {
        let got = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => (got += d));
        res.on("end", () => {
          let json: unknown;
          try {
            json = got ? JSON.parse(got) : undefined;
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, body: json });
        });
      });
      r.on("timeout", () => {
        timedOut = true;
        r.destroy(new Error("timed out"));
      });
      r.on("error", (e) =>
        reject(
          timedOut
            ? new ApiTimedOut(path, timeout)
            : new ApiFailed(`The Atticus app didn't answer (${e.message}).`, 0),
        ),
      );
      r.end(text);
    });
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.request(method, path, body);
    if (r.status >= 200 && r.status < 300) return r.body as T;
    const p = (r.body ?? {}) as { title?: string; detail?: string };
    const words = [p.title, p.detail].filter(Boolean).join(": ");
    throw new ApiFailed(words || `The app answered ${r.status} for ${path}.`, r.status);
  }
}
