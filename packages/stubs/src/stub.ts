import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { CatalogRecord } from "@maycombhq/core";
import { coerce, validate } from "./schema.js";
import {
  sortRoutes,
  type ExampleSource,
  type Stub,
  type StubResponse,
  type StubRoute,
} from "./spec.js";

/** The part of a Node IncomingMessage a stub reads; tests pass plain objects. */
export interface StubRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  [Symbol.asyncIterator]?(): AsyncIterator<unknown>;
}

/** The part of a Node ServerResponse a stub writes. */
export interface StubReply {
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body?: string): unknown;
}

export type StubHandler = (req: StubRequest, res: StubReply) => Promise<void>;

export interface RequestError {
  in: "path" | "query" | "header" | "body";
  name?: string;
  pointer?: string;
  message: string;
}

const NO_BODY = new Set([204, 205, 304]);
/** OpenAPI says these header parameters are ignored: the HTTP layer owns them. */
const IGNORED_HEADERS = new Set(["accept", "content-type", "authorization"]);

const either = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]!}`;

interface Compiled {
  route: StubRoute;
  segments: { re: RegExp; names: string[] }[];
  literalSegments: number;
  literalChars: number;
}

function compile(route: StubRoute): Compiled {
  const parts = route.path.split("/").filter(Boolean);
  let literalSegments = 0;
  let literalChars = 0;
  const segments = parts.map((seg) => {
    const names: string[] = [];
    const src = seg
      .split(/(\{[^}]+\})/)
      .map((piece) => {
        const m = /^\{([^}]+)\}$/.exec(piece);
        if (m) {
          names.push(m[1]!);
          return "([^/]+)";
        }
        literalChars += piece.length;
        return piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("");
    if (names.length === 0) literalSegments++;
    return { re: new RegExp(`^${src}$`), names };
  });
  return { route, segments, literalSegments, literalChars };
}

function matchPath(c: Compiled, parts: string[]): Record<string, string> | undefined {
  if (parts.length !== c.segments.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const m = c.segments[i]!.re.exec(parts[i]!);
    if (!m) return undefined;
    c.segments[i]!.names.forEach((n, j) => (params[n] = m[j + 1]!));
  }
  return params;
}

function splitPath(pathname: string): string[] {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
}

async function readBody(req: StubRequest): Promise<string> {
  if (typeof req[Symbol.asyncIterator] !== "function") return "";
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<unknown>)
    chunks.push(typeof c === "string" ? Buffer.from(c) : (c as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

const header = (req: StubRequest, name: string): string | undefined => {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(req.headers))
    if (k.toLowerCase() === want && v !== undefined) return Array.isArray(v) ? v.join(", ") : v;
  return undefined;
};

/** Prefer: code=503, example=down (RFC 7240 preferences, as mock servers commonly read them). */
function preferences(req: StubRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header(req, "prefer") ?? "").split(/[,;]/)) {
    const eq = part.indexOf("=");
    if (eq > 0)
      out[part.slice(0, eq).trim().toLowerCase()] = part
        .slice(eq + 1)
        .trim()
        .replace(/^"|"$/g, "");
  }
  return out;
}

function send(res: StubReply, status: number, body: unknown, headers: Record<string, string>) {
  if (NO_BODY.has(status) || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    "content-length": String(Buffer.byteLength(text)),
  });
  res.end(text);
}

function problem(
  res: StubReply,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  // RFC 9457 member order: type, title, status, then the rest.
  send(
    res,
    status,
    { type: body.type, title: body.title, status, ...body },
    {
      "content-type": "application/problem+json",
      ...headers,
    },
  );
}

/** Check the request's parameters and body against the route; errors in spec order. */
function check(
  route: StubRoute,
  pathParams: Record<string, string>,
  query: URLSearchParams,
  req: StubRequest,
  text: string,
): RequestError[] {
  const errors: RequestError[] = [];
  for (const p of route.params) {
    let value: unknown;
    if (p.in === "path") {
      const raw = pathParams[p.name];
      if (raw === undefined) continue;
      value = coerce(raw, p.schema);
    } else if (p.in === "query") {
      const all = query.getAll(p.name);
      if (all.length === 0) {
        if (p.required) errors.push({ in: "query", name: p.name, message: "is required" });
        continue;
      }
      const t = p.schema?.type;
      value =
        t === "array" || (Array.isArray(t) && t.includes("array"))
          ? all.flatMap((v) => v.split(",")).map((v) => coerce(v, p.schema?.items))
          : coerce(all[0]!, p.schema);
    } else {
      if (IGNORED_HEADERS.has(p.name.toLowerCase())) continue;
      const raw = header(req, p.name);
      if (raw === undefined) {
        if (p.required) errors.push({ in: "header", name: p.name, message: "is required" });
        continue;
      }
      value = coerce(raw, p.schema);
    }
    for (const e of validate(value, p.schema))
      errors.push({ in: p.in, name: p.name, message: e.message });
  }
  const b = route.body;
  if (b) {
    if (text.trim() === "") {
      if (b.required) errors.push({ in: "body", pointer: "", message: "is required" });
    } else if (b.json) {
      const type = header(req, "content-type");
      if (type && !/json/i.test(type))
        errors.push({ in: "body", pointer: "", message: "must be sent as application/json" });
      else {
        let value: unknown;
        try {
          value = JSON.parse(text) as unknown;
        } catch {
          errors.push({ in: "body", pointer: "", message: "isn't valid JSON" });
          return errors;
        }
        for (const e of validate(value, b.schema, "", "request"))
          errors.push({ in: "body", pointer: e.pointer, message: e.message });
      }
    }
  }
  return errors;
}

function documented(route: StubRoute, code: string): StubResponse | undefined {
  return (
    route.responses.find((r) => r.status === code) ??
    route.responses.find((r) => r.status === `${code[0]}XX`) ??
    route.responses.find((r) => r.status === "default")
  );
}

/**
 * A Node request handler for a stub. Matches method and path template (a literal segment
 * beats a template), checks the request, and answers with the operation's example and its
 * first 2xx status. X-Stub-Status: <code> or Prefer: code=<code> asks for another documented
 * response; Prefer: example=<name> picks a named example. Answers are the same every time.
 */
export function stubHandler(stub: Stub): StubHandler {
  const compiled = stub.routes.map(compile);
  const operations = stub.routes.map((r) => `${r.method} ${r.path}`);
  return async (req, res) => {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://stub.invalid");
    const pathname = url.pathname.replace(/(.)\/+$/, "$1");
    const text = await readBody(req);
    const candidates = [
      pathname,
      ...stub.basePaths
        .filter((b) => pathname === b || pathname.startsWith(`${b}/`))
        .map((b) => pathname.slice(b.length) || "/"),
    ];
    let hits: { c: Compiled; params: Record<string, string> }[] = [];
    for (const p of candidates) {
      const parts = splitPath(p);
      hits = compiled.flatMap((c) => {
        const params = matchPath(c, parts);
        return params ? [{ c, params }] : [];
      });
      if (hits.length > 0) break;
    }
    const specific = (a: Compiled, b: Compiled) =>
      b.literalSegments - a.literalSegments || b.literalChars - a.literalChars;
    hits.sort((a, b) => specific(a.c, b.c));

    if (hits.length === 0)
      return problem(res, 404, {
        type: "urn:atticus:stub:no-route",
        title: "No such operation",
        detail: `The spec has no operation for ${method} ${url.pathname}.`,
        instance: url.pathname,
        operations,
      });
    const hit = hits.find((h) => h.c.route.method === method);
    if (!hit) {
      const allow = [...new Set(hits.map((h) => h.c.route.method))].sort();
      return problem(
        res,
        405,
        {
          type: "urn:atticus:stub:method-not-allowed",
          title: "Method not allowed",
          detail: `${hits[0]!.c.route.path} takes ${either(allow)}, not ${method}.`,
          instance: url.pathname,
          allow,
        },
        { allow: allow.join(", ") },
      );
    }
    const route = hit.c.route;
    const name = `${route.method} ${route.path}`;
    const errors = check(route, hit.params, url.searchParams, req, text);
    if (errors.length > 0)
      return problem(res, 400, {
        type: "urn:atticus:stub:invalid-request",
        title: "The request doesn't match the spec",
        detail: `${errors.length} problem${errors.length === 1 ? "" : "s"} with ${name}.`,
        instance: url.pathname,
        errors,
      });

    const prefs = preferences(req);
    const asked = header(req, "x-stub-status")?.trim() ?? prefs.code;
    let status = route.status;
    let response: StubResponse | undefined = documented(route, String(route.status));
    if (asked !== undefined) {
      response = /^[1-5]\d\d$/.test(asked) ? documented(route, asked) : undefined;
      if (!response)
        return problem(res, 400, {
          type: "urn:atticus:stub:unknown-scenario",
          title: "No such response in the spec",
          detail: `${name} documents ${route.responses.map((r) => r.status).join(", ")}, not ${asked}.`,
          instance: url.pathname,
          documented: route.responses.map((r) => r.status),
        });
      status = Number(asked);
    }
    const named = prefs.example !== undefined ? response?.named[prefs.example] : undefined;
    const body = named ?? response?.body ?? {};
    const mediaType =
      response?.mediaType && /json/i.test(response.mediaType)
        ? response.mediaType
        : "application/json";
    send(res, status, NO_BODY.has(status) ? undefined : body, {
      ...(NO_BODY.has(status) ? {} : { "content-type": mediaType }),
      "x-stub-route": name,
    });
  };
}

/** What each operation answers with, for `atticus stub check`. */
export function checkStub(stub: Stub): {
  method: string;
  path: string;
  operationId?: string;
  status: number;
  example: ExampleSource;
}[] {
  return stub.routes.map((r) => ({
    method: r.method,
    path: r.path,
    ...(r.operationId ? { operationId: r.operationId } : {}),
    status: r.status,
    example: r.example,
  }));
}

type EndpointRec = Extract<CatalogRecord, { kind: "Endpoint" }>;

/**
 * A stub for the REST endpoints the catalog knows for a component or system, when there
 * is no spec: every operation answers 200 with {}. Paths are also served under the base
 * path of any gateway route callers use to reach them, so a client pointed at the gateway
 * path works too.
 */
export function stubFromCatalog(records: CatalogRecord[], componentOrSystem: string): Stub {
  const id = componentOrSystem;
  const components = records.filter((r) => r.kind === "Component");
  const isComponent = components.some((c) => c.id === id);
  const isSystem = records.some((r) => r.kind === "System" && r.id === id);
  const endpoints = records.filter((r): r is EndpointRec => r.kind === "Endpoint");
  const owners = new Set([
    id,
    ...(isComponent ? [] : components.filter((c) => c.system === id).map((c) => c.id)),
  ]);
  if (!isComponent && !isSystem && !endpoints.some((e) => e.component === id))
    throw new Error(`No component or system "${id}" in the catalog.`);
  const mine = endpoints
    .filter((e) => owners.has(e.component) && e.endpointType === "rest" && e.status !== "retired")
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const seen = new Set<string>();
  const routes: StubRoute[] = [];
  for (const e of mine) {
    const method = (e.method ?? "GET").toUpperCase();
    const key = `${method} ${e.pathOrTopic}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({
      method,
      path: e.pathOrTopic,
      operationId: e.id,
      params: [...e.pathOrTopic.matchAll(/\{([^}]+)\}/g)].map((m) => ({
        name: m[1]!,
        in: "path" as const,
        required: true,
      })),
      responses: [{ status: "200", body: {}, example: "catalog", named: {} }],
      status: 200,
      example: "catalog",
    });
  }
  const ids = new Set(mine.map((e) => e.id));
  const basepaths = new Map(
    records
      .filter((r) => r.kind === "GatewayRoute")
      .map((r) => [r.id, (r as { basepath: string }).basepath]),
  );
  const basePaths = new Set<string>();
  for (const r of records)
    if (r.kind === "Interface" && r.endpoint && ids.has(r.endpoint) && r.route) {
      const b = basepaths.get(r.route)?.replace(/\/+$/, "");
      if (b) basePaths.add(b);
    }
  return {
    title: `Catalog stub for ${id}`,
    basePaths: [...basePaths].sort(),
    routes: sortRoutes(routes),
    warnings: [],
  };
}

/**
 * Serve a stub on a local port; for the CLI only (tests call the handler directly). Binds to
 * 127.0.0.1 unless told otherwise, so a stub is never reachable from the network by accident.
 */
export async function startStub(
  handler: StubHandler,
  o: { port: number; host?: string },
): Promise<{ url: string; port: number; close(): Promise<void> }> {
  const host = o.host ?? "127.0.0.1";
  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/problem+json" });
      res.end(JSON.stringify({ title: "The stub failed", status: 500 }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
