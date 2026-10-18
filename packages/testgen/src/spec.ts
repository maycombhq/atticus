import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePath, type RecordOf } from "@maycombhq/core";
import type { Hop } from "@maycombhq/naysayer";
import type { PlanContext } from "@maycombhq/planner";
import { buildStub, generate, parseSpec, type JsonSchema, type StubRoute } from "@maycombhq/stubs";
import type { RepoPlace } from "./targets.js";

/**
 * The OpenAPI operation a hop calls, read from the callee's spec: the interfaces.md contract
 * (relative to the callee's repo, else to the metarepo), else the catalog endpoint's spec
 * evidence. The callee's change worktree comes first, so a spec updated for the change is
 * the one tests are generated from. Files only.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export interface SpecOperation {
  /** Where the spec was read: "<repo>:<path>" or a metarepo path. */
  source: string;
  route: StubRoute;
  /** The request body's example, or one built from its schema (read-only fields left out). */
  requestExample?: unknown;
  /** Security requirements: scheme type and scopes. */
  security: { scheme: string; type: string; scopes: string[] }[];
  /** Every top-level property of the request and of the first 2xx response. */
  requestFields: string[];
  responseFields: string[];
}

function candidates(
  ctx: PlanContext,
  hop: Hop,
  places: Map<string, RepoPlace>,
): { file: string; label: string }[] {
  const out: { file: string; label: string }[] = [];
  const calleeRepo = ctx.repoOf(hop.callee);
  const place = calleeRepo ? places.get(calleeRepo) : undefined;
  const contract = hop.contract.replace(/[`*]/g, "").trim();
  if (contract && !/^(none|n\/a|-|tbd)$/i.test(contract)) {
    if (place?.dir)
      out.push({ file: join(place.dir, contract), label: `${calleeRepo}:${contract}` });
    out.push({ file: join(ctx.root, contract), label: contract });
  }
  const ep = endpointFor(ctx, hop);
  for (const e of ep?.evidence ?? []) {
    if (e.source !== "spec" || !e.path) continue;
    const p = e.repo ? places.get(e.repo) : undefined;
    if (e.repo && p?.dir) out.push({ file: join(p.dir, e.path), label: `${e.repo}:${e.path}` });
    else if (!e.repo) out.push({ file: join(ctx.root, e.path), label: e.path });
  }
  return out;
}

/** The catalog endpoint a hop calls (callee, method, normalised path), if the catalog has it. */
export function endpointFor(ctx: PlanContext, hop: Hop): RecordOf<"Endpoint"> | undefined {
  if (!hop.method || !hop.path) return undefined;
  const p = normalizePath(hop.path);
  return ctx.records.find(
    (r): r is RecordOf<"Endpoint"> =>
      r.kind === "Endpoint" &&
      r.component === hop.callee &&
      (r.method ?? "").toUpperCase() === hop.method &&
      normalizePath(r.normalizedPath ?? r.pathOrTopic) === p,
  );
}

const stripReadOnly = (schema: JsonSchema | undefined): JsonSchema | undefined => {
  if (!schema?.properties) return schema;
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(schema.properties).filter(([, s]) => !s.readOnly),
    ),
  };
};

function securityOf(doc: Obj, op: Obj): SpecOperation["security"] {
  const reqs = (
    Array.isArray(op.security) ? op.security : Array.isArray(doc.security) ? doc.security : []
  ) as unknown[];
  const schemes =
    isObj(doc.components) && isObj(doc.components.securitySchemes)
      ? doc.components.securitySchemes
      : isObj(doc.securityDefinitions)
        ? doc.securityDefinitions
        : {};
  const out: SpecOperation["security"] = [];
  for (const r of reqs) {
    if (!isObj(r)) continue;
    for (const [name, scopes] of Object.entries(r)) {
      const s = isObj(schemes[name]) ? (schemes[name] as Obj) : {};
      const type =
        s.type === "http" ? String(s.scheme ?? "http").toLowerCase() : String(s.type ?? "unknown");
      out.push({ scheme: name, type, scopes: Array.isArray(scopes) ? scopes.map(String) : [] });
    }
  }
  return out;
}

const pick = (content: unknown): Obj | undefined => {
  if (!isObj(content)) return undefined;
  const k =
    Object.keys(content).find((x) => x.toLowerCase() === "application/json") ??
    Object.keys(content).find((x) => /json/.test(x));
  return k && isObj(content[k]) ? (content[k] as Obj) : undefined;
};

/** Read the operation a hop calls from the first spec that has it. */
export function findOperation(
  ctx: PlanContext,
  hop: Hop,
  places: Map<string, RepoPlace>,
): { op?: SpecOperation; tried: string[] } {
  const tried: string[] = [];
  if (!hop.method || !hop.path) return { tried };
  const want = normalizePath(hop.path);
  for (const c of candidates(ctx, hop, places)) {
    if (!existsSync(c.file) || tried.includes(c.label)) continue;
    tried.push(c.label);
    let doc: Obj;
    let stub;
    try {
      const text = readFileSync(c.file, "utf8");
      doc = parseSpec(text);
      stub = buildStub(text);
    } catch {
      continue;
    }
    const route = stub.routes.find((r) => {
      if (r.method !== hop.method) return false;
      const p = normalizePath(r.path);
      return p === want || stub.basePaths.some((b) => normalizePath(`${b}${r.path}`) === want);
    });
    if (!route) continue;
    const item =
      isObj(doc.paths) && isObj(doc.paths[route.path]) ? (doc.paths[route.path] as Obj) : {};
    const op = isObj(item[route.method.toLowerCase()])
      ? (item[route.method.toLowerCase()] as Obj)
      : {};
    const media = pick(isObj(op.requestBody) ? op.requestBody.content : undefined);
    const bodySchema = stripReadOnly(route.body?.schema);
    const requestExample =
      media?.example !== undefined
        ? media.example
        : route.body?.json && bodySchema
          ? generate(bodySchema)
          : undefined;
    const ok = route.responses.find((r) => /^2/.test(r.status));
    const okMedia = (() => {
      const responses = isObj(op.responses) ? op.responses : {};
      const r = ok ? responses[ok.status] : undefined;
      return pick(isObj(r) ? r.content : undefined);
    })();
    const okSchema = okMedia && isObj(okMedia.schema) ? (okMedia.schema as JsonSchema) : undefined;
    return {
      op: {
        source: c.label,
        route,
        ...(requestExample !== undefined ? { requestExample } : {}),
        security: securityOf(doc, op),
        requestFields: Object.keys(bodySchema?.properties ?? {}),
        responseFields: Object.keys(okSchema?.properties ?? (isObj(ok?.body) ? ok.body : {})),
      },
      tried,
    };
  }
  return { tried };
}
