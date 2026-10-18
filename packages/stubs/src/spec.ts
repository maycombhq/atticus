import { parse } from "yaml";
import { generate, schemaExample, type JsonSchema } from "./schema.js";

/** Where a route's answer comes from, best first. */
export type ExampleSource =
  /** media type `example` */
  | "example"
  /** media type `examples` (OpenAPI 3) or response `examples` (Swagger 2.0) */
  | "examples"
  /** the schema's `example` or first `examples` entry */
  | "schema-example"
  /** the schema's `default` */
  | "schema-default"
  /** built from the schema */
  | "generated"
  /** the response has no body in the spec; the stub sends {} */
  | "none"
  /** a catalog endpoint without a spec; the stub sends {} */
  | "catalog";

export interface StubParam {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema?: JsonSchema;
}

export interface StubBody {
  required: boolean;
  /** False when the operation takes only non-JSON bodies, which the stub doesn't check. */
  json: boolean;
  schema?: JsonSchema;
}

export interface StubResponse {
  /** "200", a range like "5XX", or "default". */
  status: string;
  description?: string;
  mediaType?: string;
  /** The body sent; undefined when the spec documents no body. */
  body?: unknown;
  example: ExampleSource;
  /** Named examples, for Prefer: example=<name>. */
  named: Record<string, unknown>;
}

export interface StubRoute {
  method: string;
  path: string;
  operationId?: string;
  params: StubParam[];
  body?: StubBody;
  responses: StubResponse[];
  /** The status answered when no scenario is asked for: the first 2xx. */
  status: number;
  /** Where that answer's body comes from. */
  example: ExampleSource;
}

export interface Stub {
  title: string;
  version?: string;
  /** Path prefixes from the spec's servers or basePath; requests may use them or not. */
  basePaths: string[];
  /** Sorted by path, then method. */
  routes: StubRoute[];
  warnings: string[];
}

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isJson = (mediaType: string) => /(^|\/|\+)json($|;)/i.test(mediaType) || mediaType === "*/*";

/** Parse a spec file's text, YAML or JSON. */
export function parseSpec(text: string): Obj {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    throw new Error(`Can't read the spec: ${(e as Error).message.split("\n")[0]}`, { cause: e });
  }
  if (!isObj(doc)) throw new Error("This file is not an OpenAPI 3 or Swagger 2.0 spec.");
  return doc;
}

/**
 * Replace every local $ref with what it points at. A ref back into itself becomes {} (any
 * value), so recursive schemas don't loop. Refs to other files are never followed: a stub
 * reads one file and nothing else.
 */
function derefAll(doc: Obj, warnings: Set<string>): Obj {
  const lookup = (ref: string): unknown => {
    let cur: unknown = doc;
    for (const raw of ref.slice(2).split("/")) {
      const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
      cur = isObj(cur) ? cur[key] : undefined;
    }
    return cur;
  };
  const walk = (node: unknown, stack: string[]): unknown => {
    if (Array.isArray(node)) return node.map((n) => walk(n, stack));
    if (!isObj(node)) return node;
    if (typeof node.$ref === "string") {
      const ref = node.$ref;
      if (!ref.startsWith("#/")) {
        warnings.add(`Can't follow ${ref}: only refs inside the spec are read.`);
        return {};
      }
      if (stack.includes(ref)) return {};
      const target = lookup(ref);
      if (target === undefined) {
        warnings.add(`${ref} points at nothing.`);
        return {};
      }
      return walk(target, [...stack, ref]);
    }
    const out: Obj = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v, stack);
    return out;
  };
  return walk(doc, []) as Obj;
}

function statusOrder(s: string): number {
  if (/^\d{3}$/.test(s)) return Number(s);
  if (/^[1-5]XX$/i.test(s)) return Number(s[0]) * 100 + 99.5;
  return 1000;
}

function pickMedia(content: unknown): [string, Obj] | undefined {
  if (!isObj(content)) return undefined;
  const entries = Object.entries(content).filter((e): e is [string, Obj] => isObj(e[1]));
  return (
    entries.find(([m]) => m.toLowerCase() === "application/json") ??
    entries.find(([m]) => isJson(m)) ??
    entries[0]
  );
}

/** A response's body, from the best example the spec gives. */
function responseBody(
  example: unknown,
  examples: unknown,
  schema: JsonSchema | undefined,
): Pick<StubResponse, "body" | "example" | "named"> {
  const named: Record<string, unknown> = {};
  if (isObj(examples))
    for (const [k, v] of Object.entries(examples))
      named[k] = isObj(v) && "value" in v ? v.value : v;
  if (example !== undefined) return { body: example, example: "example", named };
  const first = Object.values(named)[0];
  if (first !== undefined) return { body: first, example: "examples", named };
  const own = schemaExample(schema);
  if (own) return { body: own.value, example: own.source, named };
  if (schema) return { body: generate(schema), example: "generated", named };
  return { example: "none", named };
}

/** Swagger 2.0 keeps a parameter's schema on the parameter itself. */
const SCHEMA_KEYS = [
  "type",
  "format",
  "enum",
  "items",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "default",
];
const inlineSchema = (p: Obj): JsonSchema =>
  Object.fromEntries(SCHEMA_KEYS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));

function basePathsOf(doc: Obj, swagger: boolean): string[] {
  const raw: string[] = [];
  if (swagger) {
    if (typeof doc.basePath === "string") raw.push(doc.basePath);
  } else if (Array.isArray(doc.servers)) {
    for (const s of doc.servers) {
      if (!isObj(s) || typeof s.url !== "string") continue;
      const vars = isObj(s.variables) ? s.variables : {};
      const url = s.url.replace(/\{([^}]+)\}/g, (m, v: string) => {
        const d = isObj(vars[v]) ? (vars[v] as Obj).default : undefined;
        return typeof d === "string" ? d : m;
      });
      if (/\{/.test(url)) continue;
      try {
        raw.push(new URL(url, "http://stub.invalid").pathname);
      } catch {
        // A server url that isn't a URL adds no base path.
      }
    }
  }
  return [...new Set(raw.map((p) => p.replace(/\/+$/, "")).filter((p) => p && p !== "/"))].sort();
}

/**
 * Build a deterministic stub from an OpenAPI 3.x or Swagger 2.0 spec (text or parsed): one
 * route per operation, each with the status and body it answers with.
 */
export function buildStub(spec: string | unknown): Stub {
  const input = typeof spec === "string" ? parseSpec(spec) : spec;
  if (!isObj(input)) throw new Error("This file is not an OpenAPI 3 or Swagger 2.0 spec.");
  const swagger = String(input.swagger ?? "") === "2.0";
  if (!swagger && !/^3\./.test(String(input.openapi ?? "")))
    throw new Error("This file is not an OpenAPI 3 or Swagger 2.0 spec.");
  const warnings = new Set<string>();
  const doc = derefAll(input, warnings);
  const info = isObj(doc.info) ? doc.info : {};
  const routes: StubRoute[] = [];
  const paths = isObj(doc.paths) ? doc.paths : {};
  const produces = Array.isArray(doc.produces) ? doc.produces.map(String) : [];

  for (const [path, item] of Object.entries(paths)) {
    if (!isObj(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters.filter(isObj) : [];
    for (const m of METHODS) {
      const op = item[m];
      if (!isObj(op)) continue;
      const own = Array.isArray(op.parameters) ? op.parameters.filter(isObj) : [];
      // Operation parameters override path-level ones with the same name and place.
      const merged = [
        ...shared.filter((s) => !own.some((o) => o.name === s.name && o.in === s.in)),
        ...own,
      ];
      const params: StubParam[] = [];
      let body: StubBody | undefined;
      for (const p of merged) {
        const where = String(p.in ?? "");
        if (where === "path" || where === "query" || where === "header") {
          const schema = swagger ? inlineSchema(p) : isObj(p.schema) ? p.schema : undefined;
          params.push({
            name: String(p.name ?? ""),
            in: where,
            required: where === "path" || p.required === true,
            ...(schema ? { schema } : {}),
          });
        } else if (where === "body")
          body = {
            required: p.required === true,
            json: true,
            ...(isObj(p.schema) ? { schema: p.schema } : {}),
          };
        else if (where === "formData") body = { required: p.required === true, json: false };
      }
      if (!swagger && isObj(op.requestBody)) {
        const media = pickMedia(op.requestBody.content);
        const json = media ? isJson(media[0]) : false;
        body = {
          required: op.requestBody.required === true,
          json,
          ...(json && media && isObj(media[1].schema) ? { schema: media[1].schema } : {}),
        };
      }

      const responses: StubResponse[] = [];
      for (const [status, r] of Object.entries(isObj(op.responses) ? op.responses : {})) {
        if (!isObj(r)) continue;
        const description = typeof r.description === "string" ? r.description : undefined;
        let mediaType: string | undefined;
        let picked: Pick<StubResponse, "body" | "example" | "named">;
        if (swagger) {
          const ex = isObj(r.examples) ? r.examples : {};
          const exType =
            Object.keys(ex).find((k) => k.toLowerCase() === "application/json") ??
            Object.keys(ex).find(isJson);
          const schema = isObj(r.schema) ? (r.schema as JsonSchema) : undefined;
          mediaType = exType ?? produces.find(isJson) ?? (schema ? "application/json" : undefined);
          picked = exType
            ? { body: ex[exType], example: "examples", named: {} }
            : responseBody(undefined, undefined, schema);
        } else {
          const media = pickMedia(r.content);
          mediaType = media?.[0];
          picked = media
            ? responseBody(
                media[1].example,
                media[1].examples,
                isObj(media[1].schema) ? (media[1].schema as JsonSchema) : undefined,
              )
            : responseBody(undefined, undefined, undefined);
        }
        responses.push({
          status: status.toUpperCase() === "DEFAULT" ? "default" : status.toUpperCase(),
          ...(description !== undefined ? { description } : {}),
          ...(mediaType ? { mediaType } : {}),
          ...picked,
        });
      }
      responses.sort((a, b) => statusOrder(a.status) - statusOrder(b.status));
      const ok =
        responses.find((r) => /^2\d\d$/.test(r.status)) ??
        responses.find((r) => r.status === "2XX") ??
        responses.find((r) => r.status === "default");
      routes.push({
        method: m.toUpperCase(),
        path,
        ...(typeof op.operationId === "string" ? { operationId: op.operationId } : {}),
        params,
        ...(body ? { body } : {}),
        responses,
        status: ok && /^\d{3}$/.test(ok.status) ? Number(ok.status) : 200,
        example: ok?.example ?? "none",
      });
    }
  }
  return {
    title: typeof info.title === "string" ? info.title : "Stub",
    ...(info.version !== undefined ? { version: String(info.version) } : {}),
    basePaths: basePathsOf(doc, swagger),
    routes: sortRoutes(routes),
    warnings: [...warnings].sort(),
  };
}

export function sortRoutes(routes: StubRoute[]): StubRoute[] {
  return routes.sort((a, b) =>
    a.path === b.path ? (a.method < b.method ? -1 : 1) : a.path < b.path ? -1 : 1,
  );
}
