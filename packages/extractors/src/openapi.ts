import { isMap, isScalar, LineCounter, parseDocument } from "yaml";
import type { CatalogRecord } from "@maycombhq/core";
import { defineExtractor } from "@maycombhq/sdk";
import { componentOf, restEndpoint } from "./facts.js";

const SPEC_KIT_CONTRACT = /(^|\/)specs\/[^/]+\/contracts\//;

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];

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
      const text = await repo.readText(path);
      const lc = new LineCounter();
      const doc = parseDocument(text, { lineCounter: lc });
      const root = doc.contents;
      if (!isMap(root)) continue;
      const version = String(doc.get("openapi") ?? doc.get("swagger") ?? "");
      if (!/^(3\.|2\.0)/.test(version)) continue;
      const basePath = version.startsWith("2") ? String(doc.get("basePath") ?? "") : "";
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
      const paths = doc.get("paths");
      if (!isMap(paths)) continue;
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
          const first = (sec as { items?: unknown[] } | undefined)?.items?.[0];
          if (isMap(first) && first.items[0] && isScalar(first.items[0].key))
            auth = schemeType(String(first.items[0].key.value));
          else if (sec && (sec as { items?: unknown[] }).items?.length === 0) auth = "none";
          yield restEndpoint(
            repo,
            component,
            method,
            `${basePath}${p}`,
            { source: "spec", path, ...(line ? { line } : {}), side: "definition" },
            auth ? { auth } : {},
          ) as CatalogRecord;
        }
      }
    }
  },
});
