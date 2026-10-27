import { createHash } from "node:crypto";
import { isMap, isScalar, isSeq, type Document, type LineCounter, type YAMLMap } from "yaml";
import { endpointId, normalizePath } from "@maycombhq/core";
import { readOpenApiDocument, type OpenApiOperation } from "@maycombhq/extractors";

/**
 * A vendor's operations, read from its published spec (ADR 0130): method, path, auth and scopes,
 * and the request and response fields with their types, enum values and whether each is
 * required, every one citing the spec file and line. A partner spec is verified for what it says
 * about its own system and nothing more. OpenAPI 3 and Swagger 2 only; the operations come from
 * the same reader the repo extractor uses (`readOpenApiDocument`), so both agree on what an
 * operation is. Files only: no network, no model, no clock.
 */

/** Where a request field travels. A path parameter is left to the path. */
export type FieldIn = "body" | "query" | "header" | "cookie" | "form";

export interface VendorField {
  /** Dotted for a nested property, `[]` for an array's items: `items[].id`. */
  name: string;
  in: FieldIn;
  type?: string;
  /**
   * true: the spec lists it as required; false: it doesn't (OpenAPI says absent means optional,
   * ADR 0125); left out: nothing says (a field under an array the spec leaves open).
   */
  required?: boolean;
  enum?: string[];
  /** spec path:line of the property (or parameter). */
  cite: string;
  /** spec path:line of the `required` list that names it, when one does. */
  requiredCite?: string;
}

export interface VendorOperation {
  /** The catalog Endpoint id intake gives it (ADR 0017's names; a short path hash on a clash). */
  id: string;
  /** Upper case. */
  method: string;
  /** As the spec writes it, Swagger 2's basePath in front. */
  path: string;
  /** With the server path in front (OpenAPI 3 `servers[0]`); the same as `path` when it has none. */
  fullPath: string;
  normalizedPath: string;
  operationId?: string;
  auth?: string;
  scopes: string[];
  /** spec path:line of the method. */
  cite: string;
  request: VendorField[];
  response: VendorField[];
}

export interface VendorSpec {
  path: string;
  system: string;
  title?: string;
  version?: string;
  /** The hosts the spec's servers name, lower case, each once. */
  hosts: string[];
  /** The first server's path ("/v1"), or "" when it has none. */
  serverPath: string;
  /** Swagger 2's basePath, which every operation's path starts with; "" for OpenAPI 3. */
  basePath: string;
  operations: VendorOperation[];
}

const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 6);

/**
 * The Endpoint ids for a spec's operations, as `readOpenApiSpec` gives them: two with one name
 * get a short path hash (ADR 0017).
 */
export function specEndpointIds(
  component: string,
  ops: readonly { method: string; normalizedPath: string }[],
): string[] {
  const ids = ops.map((o) => endpointId(component, o.method, o.normalizedPath));
  const count = new Map<string, number>();
  for (const id of ids) count.set(id, (count.get(id) ?? 0) + 1);
  return ids.map((id, i) =>
    (count.get(id) ?? 0) > 1 ? `${id}-${short(ops[i]!.normalizedPath)}` : id,
  );
}

const MAX_DEPTH = 6;

/** Read a partner spec into the vendor's operations; undefined when it isn't OpenAPI 3 or Swagger 2. */
export function readVendorSpec(path: string, text: string, system: string): VendorSpec | undefined {
  const read = readOpenApiDocument(text);
  if (!read) return undefined;
  const { doc, lc } = read;
  const at = (offset: number | undefined) =>
    offset === undefined ? undefined : `${path}:${lc.linePos(offset).line}`;
  const swagger2 = read.version.startsWith("2");
  const hosts: string[] = [];
  let serverPath = "";
  read.servers.forEach((url, i) => {
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/i.exec(url);
    const host = m?.[1]
      ?.replace(/^[^@]*@/, "")
      .replace(/:\d+$/, "")
      .toLowerCase();
    if (host && !host.includes("{") && !hosts.includes(host)) hosts.push(host);
    if (i === 0) {
      const p = m ? m[2]! : url.startsWith("/") ? url.split(/[?#]/)[0]! : "";
      serverPath = p.replace(/\/+$/, "");
    }
  });
  // Swagger 2's server is scheme, host and basePath; the basePath is already in each path.
  if (swagger2) serverPath = "";
  const info = doc.get("info");
  const title = isMap(info) ? info.get("title") : undefined;
  const version = isMap(info) ? info.get("version") : undefined;

  const ctx: Ctx = { doc, lc, path, at };
  const ops = read.operations.map((op) => {
    const method = op.method.toUpperCase();
    const fullPath = `${serverPath}${op.path}` || op.path;
    const node = isMap(op.node) ? op.node : undefined;
    const opId = node?.get("operationId");
    return {
      method,
      path: op.path,
      fullPath,
      normalizedPath: normalizePath(op.path),
      ...(typeof opId === "string" && opId ? { operationId: opId } : {}),
      ...(op.auth ? { auth: op.auth } : {}),
      scopes: op.scopes,
      cite: `${path}:${op.methodLine ?? op.line ?? 1}`,
      request: requestFields(ctx, op, swagger2),
      response: responseFields(ctx, op, swagger2),
    };
  });
  const ids = specEndpointIds(system, ops);
  return {
    path,
    system,
    ...(typeof title === "string" && title ? { title } : {}),
    ...(version !== undefined && version !== null && String(version)
      ? { version: String(version) }
      : {}),
    hosts,
    serverPath,
    basePath: swagger2 ? String(doc.get("basePath") ?? "") : "",
    operations: ops.map((o, i) => ({ id: ids[i]!, ...o })),
  };
}

interface Ctx {
  doc: Document;
  lc: LineCounter;
  path: string;
  at: (offset: number | undefined) => string | undefined;
}

/** A node, its `$ref` followed (local refs only, a bounded number of times). */
function deref(ctx: Ctx, node: unknown, seen = new Set<string>()): unknown {
  let n = node;
  for (let i = 0; i < 8 && isMap(n); i++) {
    const ref = n.get("$ref");
    if (typeof ref !== "string") return n;
    if (!ref.startsWith("#/") || seen.has(ref)) return undefined;
    seen.add(ref);
    const parts = ref
      .slice(2)
      .split("/")
      .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
    n = ctx.doc.getIn(parts, true);
  }
  return n;
}

const offsetOfKey = (map: YAMLMap, key: string): number | undefined => {
  const pair = map.items.find((p) => isScalar(p.key) && String(p.key.value) === key);
  return pair && isScalar(pair.key) ? pair.key.range?.[0] : undefined;
};

const strings = (n: unknown): string[] | undefined =>
  isSeq(n) ? n.items.filter(isScalar).map((s) => String(s.value)) : undefined;

/** A schema's type: its `type`, else object or array from what it has. */
function typeOf(schema: YAMLMap): string | undefined {
  const t = schema.get("type");
  if (typeof t === "string") return t;
  if (isSeq(t)) {
    const named = strings(t)!.filter((x) => x !== "null");
    return named.length === 1 ? named[0] : named.join("|") || undefined;
  }
  if (schema.has("properties") || schema.has("allOf")) return "object";
  if (schema.has("items")) return "array";
  return undefined;
}

/** The fields of a schema: its properties, nested ones dotted, an array's items under `[]`. */
function schemaFields(
  ctx: Ctx,
  node: unknown,
  where: FieldIn,
  prefix: string,
  depth: number,
  seen: Set<string>,
  out: VendorField[],
): void {
  if (depth > MAX_DEPTH) return;
  const refs = new Set(seen);
  const schema = deref(ctx, node, refs);
  if (!isMap(schema)) return;
  // allOf: every part's properties, the parts' required lists together.
  const parts = schema.get("allOf");
  const maps: YAMLMap[] = [schema];
  if (isSeq(parts))
    for (const p of parts.items) {
      const m = deref(ctx, p, new Set(refs));
      if (isMap(m)) maps.push(m);
    }
  const required = new Map<string, number | undefined>();
  for (const m of maps) {
    const r = m.get("required", true);
    if (isSeq(r))
      for (const s of r.items)
        if (isScalar(s)) required.set(String(s.value), offsetOfKey(m, "required"));
  }
  const objectLike = maps.some((m) => isMap(m.get("properties")));
  for (const m of maps) {
    const props = m.get("properties");
    if (!isMap(props)) continue;
    for (const pair of props.items) {
      if (!isScalar(pair.key)) continue;
      const key = String(pair.key.value);
      const name = prefix ? `${prefix}.${key}` : key;
      const prop = deref(ctx, pair.value, new Set(refs));
      const p = isMap(prop) ? prop : undefined;
      const type = p ? typeOf(p) : undefined;
      const values = p ? strings(p.get("enum")) : undefined;
      const req = required.has(key);
      out.push({
        name,
        in: where,
        ...(type ? { type } : {}),
        ...(objectLike ? { required: req } : {}),
        ...(values ? { enum: values } : {}),
        cite: ctx.at(pair.key.range?.[0]) ?? `${ctx.path}:1`,
        ...(req && required.get(key) !== undefined
          ? { requiredCite: ctx.at(required.get(key))! }
          : {}),
      });
      if (p && (type === "object" || type === "array"))
        schemaFields(ctx, pair.value, where, name, depth + 1, refs, out);
    }
  }
  if (!objectLike && schema.has("items")) {
    const items = deref(ctx, schema.get("items", true), new Set(refs));
    const name = `${prefix}[]`;
    if (prefix) {
      // the array itself is already a field; its items' fields follow under it
      schemaFields(ctx, items, where, name, depth + 1, refs, out);
    } else if (isMap(items)) {
      schemaFields(ctx, items, where, name, depth + 1, refs, out);
    }
  }
}

function parameters(ctx: Ctx, op: OpenApiOperation): YAMLMap[] {
  const byKey = new Map<string, YAMLMap>();
  for (const holder of [op.pathItem, op.node]) {
    const list = isMap(holder) ? holder.get("parameters", true) : undefined;
    if (!isSeq(list)) continue;
    for (const item of list.items) {
      const p = deref(ctx, item);
      if (!isMap(p)) continue;
      byKey.set(`${String(p.get("in"))}|${String(p.get("name"))}`, p);
    }
  }
  return [...byKey.values()];
}

/** The parameter's own line: its `name` key, which a `$ref`'d parameter has where it's defined. */
const paramCite = (ctx: Ctx, p: YAMLMap) =>
  ctx.at(offsetOfKey(p, "name") ?? p.range?.[0]) ?? `${ctx.path}:1`;

/** The JSON (or first) media type's schema of an OpenAPI 3 `content`. */
function contentSchema(ctx: Ctx, holder: unknown): unknown {
  const h = deref(ctx, holder);
  if (!isMap(h)) return undefined;
  const content = h.get("content");
  if (!isMap(content)) return undefined;
  const json =
    content.items.find((p) => isScalar(p.key) && /json/i.test(String(p.key.value))) ??
    content.items[0];
  return isMap(json?.value) ? json.value.get("schema", true) : undefined;
}

function requestFields(ctx: Ctx, op: OpenApiOperation, swagger2: boolean): VendorField[] {
  const out: VendorField[] = [];
  const seen = new Set<string>();
  for (const p of parameters(ctx, op)) {
    const where = String(p.get("in"));
    const name = String(p.get("name") ?? "");
    if (where === "path" || !name) continue;
    if (where === "body") {
      schemaFields(ctx, p.get("schema", true), "body", "", 0, seen, out);
      continue;
    }
    const schema = swagger2 ? p : deref(ctx, p.get("schema", true));
    const s = isMap(schema) ? schema : undefined;
    const type = s ? typeOf(s) : undefined;
    const values = s ? strings(s.get("enum")) : undefined;
    out.push({
      name,
      in: where === "formData" ? "form" : (where as FieldIn),
      ...(type ? { type } : {}),
      required: p.get("required") === true,
      ...(values ? { enum: values } : {}),
      cite: paramCite(ctx, p),
    });
  }
  if (!swagger2 && isMap(op.node)) {
    const body = op.node.get("requestBody", true);
    if (body) schemaFields(ctx, contentSchema(ctx, body), "body", "", 0, seen, out);
  }
  return out;
}

function responseFields(ctx: Ctx, op: OpenApiOperation, swagger2: boolean): VendorField[] {
  const responses = isMap(op.node) ? op.node.get("responses") : undefined;
  if (!isMap(responses)) return [];
  const ok = responses.items
    .filter((p) => isScalar(p.key) && /^2\d\d$/.test(String(p.key.value)))
    .sort((a, b) =>
      String((a.key as { value: unknown }).value) < String((b.key as { value: unknown }).value)
        ? -1
        : 1,
    )[0];
  if (!ok) return [];
  const out: VendorField[] = [];
  const schema = swagger2
    ? (() => {
        const r = deref(ctx, ok.value);
        return isMap(r) ? r.get("schema", true) : undefined;
      })()
    : contentSchema(ctx, ok.value);
  schemaFields(ctx, schema, "body", "", 0, new Set(), out);
  return out;
}

/** A JSON pointer token: `/` and `~` escaped. */
const pointer = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

/**
 * The C1 Schema records of a vendor's operations (ADR 0130, on ADR 0125's `required`): one
 * `<endpoint>.request` and one `<endpoint>.response` per operation that has fields, each field
 * with its type and whether it is required (true or false, as the spec's `required` lists say;
 * left out where nothing says). Evidence cites the operation's line, then each field's.
 */
export function operationSchemas(
  spec: VendorSpec,
): { operation: VendorOperation; schemas: Record<string, unknown>[] }[] {
  return spec.operations.map((op) => {
    const schemas: Record<string, unknown>[] = [];
    const [file, line] = [spec.path, Number(op.cite.slice(op.cite.lastIndexOf(":") + 1))];
    for (const side of ["request", "response"] as const) {
      const fields = op[side];
      if (!fields.length) continue;
      const lines = [line, ...fields.map((f) => Number(f.cite.slice(f.cite.lastIndexOf(":") + 1)))];
      const where = side === "request" ? "requestBody" : "responses";
      schemas.push({
        schemaVersion: 1,
        kind: "Schema",
        id: `${op.id}.${side}`,
        status: "current",
        confidence: "verified",
        format: "openapi",
        ref: `${file}#/paths/${pointer(op.path.slice(spec.basePath.length) || "/")}/${op.method.toLowerCase()}/${where}`,
        ...(spec.version ? { version: spec.version } : {}),
        fields: fields.map((f) => ({
          name: f.name,
          ...(f.type ? { type: f.type } : {}),
          ...(f.required !== undefined ? { required: f.required } : {}),
        })),
        evidence: [...new Set(lines)]
          .filter((n) => Number.isInteger(n) && n > 0)
          .map((n) => ({ source: "spec", path: file, line: n, side: "definition" })),
      });
    }
    return { operation: op, schemas };
  });
}
