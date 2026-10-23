/**
 * The small HTTP layer under the local API: a path router with `{param}` segments, RFC 9457
 * problem details for every error, and JSON bodies. Node's http module only, so the server
 * installs with no native modules and runs the same on Windows and Linux.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(detail ?? title);
  }
}

export const badRequest = (detail: string, extra: Record<string, unknown> = {}) =>
  new HttpError(400, "The request isn't valid", detail, extra);
export const notFound = (detail: string) => new HttpError(404, "Not found", detail);
export const conflict = (detail: string) => new HttpError(409, "Conflict", detail);

export interface Req {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export interface Res {
  status: number;
  body?: unknown;
}

export type Handler = (req: Req) => Promise<Res> | Res;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
  /** The largest body this call takes, when it isn't the server's default (an upload). */
  maxBody?: number;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, o: { maxBody?: number } = {}): this {
    this.routes.push({
      method,
      parts: pattern.split("/").filter(Boolean),
      handler,
      ...(o.maxBody ? { maxBody: o.maxBody } : {}),
    });
    return this;
  }

  /** The handler and path params, or the methods the path does allow (for 405). */
  match(
    method: string,
    path: string,
  ):
    { handler: Handler; params: Record<string, string>; maxBody?: number } | { allowed: string[] } {
    const segs = path.split("/").filter(Boolean);
    const allowed: string[] = [];
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const want = r.parts[i]!;
        let got: string;
        try {
          got = decodeURIComponent(segs[i]!);
        } catch {
          ok = false;
          break;
        }
        if (want.startsWith("{") && want.endsWith("}")) params[want.slice(1, -1)] = got;
        else if (want !== got) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (r.method === method)
        return { handler: r.handler, params, ...(r.maxBody ? { maxBody: r.maxBody } : {}) };
      allowed.push(r.method);
    }
    return { allowed };
  }
}

/** A problem-details body (RFC 9457). */
export function problem(e: HttpError): Record<string, unknown> {
  return {
    type: `https://atticus.dev/problems/${e.status}`,
    title: e.title,
    status: e.status,
    ...(e.detail ? { detail: e.detail } : {}),
    ...e.extra,
  };
}

/** An integer query parameter within bounds, or undefined when absent. */
export function intParam(q: URLSearchParams, name: string, min: number, max: number) {
  const v = q.get(name);
  if (v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max)
    throw badRequest(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

/** A string query parameter, or undefined when absent or empty. */
export const strParam = (q: URLSearchParams, name: string) => q.get(name) || undefined;
