import { request } from "node:http";

/**
 * The app's local API on 127.0.0.1 (ADR 0015, 0093), with the session token `atticus ui` printed.
 * The sidebar only reads through it. Nothing here goes off the machine.
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
    return new Promise((resolve, reject) => {
      const r = request(
        this.url + path,
        { method: "GET", headers: { "X-Atticus-Token": this.token }, timeout: 30_000 },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (d: string) => (body += d));
          res.on("end", () => {
            let json: unknown;
            try {
              json = body ? JSON.parse(body) : undefined;
            } catch {
              json = undefined;
            }
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) return resolve(json as T);
            const p = (json ?? {}) as { title?: string; detail?: string };
            const words = [p.title, p.detail].filter(Boolean).join(": ");
            reject(new ApiFailed(words || `The app answered ${status} for ${path}.`, status));
          });
        },
      );
      r.on("timeout", () => r.destroy(new Error("timed out")));
      r.on("error", (e) =>
        reject(new ApiFailed(`The Atticus app didn't answer (${e.message}).`, 0)),
      );
      r.end();
    });
  }
}
