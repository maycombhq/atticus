import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Document } from "yaml";
import type { CatalogRecord } from "@maycombhq/core";
import { defineExtractor } from "@maycombhq/sdk";
import { componentOf, restEndpoint } from "./facts.js";

const SPEC_KIT_CONTRACT = /(^|\/)specs\/[^/]+\/contracts\//;

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];

/** One operation of an OpenAPI 3.x or Swagger 2.0 document, as the extractor and intake read it. */
export interface OpenApiOperation {
  /** Lower case, as the spec writes it. */
  method: string;
  /** The path with Swagger 2.0's basePath in front (OpenAPI 3's server path is not added). */
  path: string;
  /** The line of the path's key. */
  line?: number;
  /** The line of the method's key. */
  methodLine?: number;
  /** The first security requirement's scheme, as a catalog auth; "none" for `security: []`. */
  auth?: string;
  /** The scopes the first security requirement lists, in the spec's order. */
  scopes: string[];
  /** The operation's own node and its path item's (for parameters, bodies and responses). */
  node: unknown;
  pathItem: unknown;
}

export interface OpenApiDocument {
  /** "3.0.3", "3.1.0", "2.0". */
  version: string;
  doc: Document;
  lc: LineCounter;
  /** The server URLs (OpenAPI 3 `servers`, or Swagger 2's scheme, host and basePath). */
  servers: string[];
  operations: OpenApiOperation[];
}

/**
 * An OpenAPI 3.x or Swagger 2.0 document (YAML or JSON) read into its operations, or undefined
 * when the text is neither. The one place both the repo extractor and intake's partner-spec
 * reader (ADR 0130) take operations from, so they agree on method, path, line and auth.
 */
export function readOpenApiDocument(text: string): OpenApiDocument | undefined {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });
  const root = doc.contents;
  if (!isMap(root)) return undefined;
  const version = String(doc.get("openapi") ?? doc.get("swagger") ?? "");
  if (!/^(3\.|2\.0)/.test(version)) return undefined;
  const swagger2 = version.startsWith("2");
  const basePath = swagger2 ? String(doc.get("basePath") ?? "") : "";
  const servers: string[] = [];
  if (swagger2) {
    const host = doc.get("host");
    if (typeof host === "string" && host) {
      const schemes = doc.get("schemes");
      const first = isSeq(schemes) ? schemes.items.find(isScalar) : undefined;
      servers.push(`${first ? String(first.value) : "https"}://${host}${basePath}`);
    }
  } else {
    const list = doc.get("servers");
    if (isSeq(list))
      for (const s of list.items) {
        const url = isMap(s) ? s.get("url") : undefined;
        if (typeof url === "string" && url) servers.push(url);
      }
  }
  const schemes = (doc.getIn(["components", "securitySchemes"]) ??
    doc.get("securityDefinitions")) as unknown;
  const schemeType = (name: string): string | undefined => {
    const s = isMap(schemes) ? (schemes.get(name) as unknown) : undefined;
    if (!isMap(s)) return undefined;
    const type = String(s.get("type") ?? "");
    if (type === "oauth2" || type === "openIdConnect") return "oauth2";
    if (type === "apiKey") return "api-key";
    if (type === "mutualTLS") return "mtls";
    if (type === "http") return String(s.get("scheme") ?? "") === "basic" ? "basic" : "other";
    return "other";
  };
  const globalSec = doc.get("security") as unknown;
  const operations: OpenApiOperation[] = [];
  const paths = doc.get("paths");
  if (!isMap(paths)) return { version, doc, lc, servers, operations };
  for (const pair of paths.items) {
    if (!isScalar(pair.key)) continue;
    const p = String(pair.key.value);
    const line = pair.key.range ? lc.linePos(pair.key.range[0]).line : undefined;
    const ops = pair.value;
    if (!isMap(ops)) continue;
    for (const op of ops.items) {
      const method = isScalar(op.key) ? String(op.key.value).toLowerCase() : "";
      if (!METHODS.includes(method)) continue;
      const opNode = op.value;
      const sec = (isMap(opNode) ? opNode.get("security") : undefined) ?? globalSec;
      let auth: string | undefined;
      const scopes: string[] = [];
      const first = (sec as { items?: unknown[] } | undefined)?.items?.[0];
      if (isMap(first) && first.items[0] && isScalar(first.items[0].key)) {
        auth = schemeType(String(first.items[0].key.value));
        const listed = first.items[0].value;
        if (isSeq(listed))
          for (const s of listed.items) if (isScalar(s)) scopes.push(String(s.value));
      } else if (sec && (sec as { items?: unknown[] }).items?.length === 0) auth = "none";
      const methodLine =
        isScalar(op.key) && op.key.range ? lc.linePos(op.key.range[0]).line : undefined;
      operations.push({
        method,
        path: `${basePath}${p}`,
        ...(line ? { line } : {}),
        ...(methodLine ? { methodLine } : {}),
        ...(auth ? { auth } : {}),
        scopes,
        node: opNode,
        pathItem: ops,
      });
    }
  }
  return { version, doc, lc, servers, operations };
}

/**
 * OpenAPI 3.x and Swagger 2.0 specs (YAML or JSON) in a repo: one Endpoint per path and
 * method, with side "definition". Swagger 2.0 basePath is prefixed. Security schemes become
 * the endpoint's auth.
 */
export const openapiExtractor = defineExtractor({
  id: "openapi",
  version: "1.0.1",
  claims: [
    "**/*openapi*.yaml",
    "**/*openapi*.yml",
    "**/*openapi*.json",
    "**/*swagger*.yaml",
    "**/*swagger*.yml",
    "**/*swagger*.json",
    "**/api/*.yaml",
    "**/api/*.yml",
  ],
  async *scan(repo, ctx) {
    for await (const path of repo.listFiles(this.claims)) {
      const component = componentOf(repo, ctx, path);
      // Contracts inside a Spec Kit feature are plans, read by the speckit extractor (ADR 0030).
      if (SPEC_KIT_CONTRACT.test(path)) continue;
      const read = readOpenApiDocument(await repo.readText(path));
      if (!read) continue;
      for (const op of read.operations)
        yield restEndpoint(
          repo,
          component,
          op.method,
          op.path,
          { source: "spec", path, ...(op.line ? { line: op.line } : {}), side: "definition" },
          op.auth ? { auth: op.auth } : {},
        ) as CatalogRecord;
    }
  },
});
