import { request } from "node:http";

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

export class AtticusApi {
  constructor(
    readonly url: string,
    private readonly token: string,
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
      const r = request(this.url + path, { method, headers, timeout: 30_000 }, (res) => {
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
      r.on("timeout", () => r.destroy(new Error("timed out")));
      r.on("error", (e) =>
        reject(new ApiFailed(`The Atticus app didn't answer (${e.message}).`, 0)),
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
