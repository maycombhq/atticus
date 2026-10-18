import { createHash } from "node:crypto";
import type { CatalogRecord } from "@maycombhq/core";
import type { RepoHandle, ScanContext } from "@maycombhq/sdk";
import { skipPath } from "../backends/shared.js";
import { clipId, ev, slug, type IngressRoute } from "../platform/util.js";
import { settingSlug } from "../spring.js";

/**
 * Helpers the ADR 0040 vocabulary extractors share (GraphQL, gRPC, real-time, webhooks,
 * serverless, mesh, apps, data pipelines, ML, ingress), so their records come out in one shape.
 *
 * Loose ends added for this vocabulary (ADR 0016 grammar, resolved by merge):
 *   graphql-call   "QUERY Query.field" | "MUTATION Mutation.field" | "SUBSCRIPTION Subscription.field"
 *   grpc-call      "package.Service" | "package.Service/Method" (package optional)
 *   webhook-callback "METHOD /callback/path REGISTRAR-URL": this component registered the path
 *                  with the system at REGISTRAR-URL, which calls it back
 */

export type VocabLooseEnd =
  | "http-call"
  | "event-publish"
  | "event-subscribe"
  | "db-access"
  | "graphql-call"
  | "grpc-call"
  | "webhook-callback";

export { clipId, ev, slug, type IngressRoute };

const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);

/** The repo's component (manifest), else the repo id. */
export const own = (repo: RepoHandle, ctx: ScanContext) => ctx.component ?? repo.name;

/** A loose end with the same id rule as the other built-in extractors. */
export function loose(
  repo: RepoHandle,
  owner: string,
  kind: VocabLooseEnd,
  raw: string,
  path: string,
  line: number | undefined,
  source: "code" | "config" | "spec" | "infrastructure" = "code",
): CatalogRecord {
  return {
    schemaVersion: 2,
    kind: "Unresolved",
    id: `${owner}.${kind}.${short(`${raw}|${path}|${line ?? ""}`)}`,
    status: "current",
    confidence: "inferred",
    unresolvedKind: kind,
    raw,
    owner,
    evidence: [ev(repo, source, path, line, "caller")],
  } as unknown as CatalogRecord;
}

/** An Endpoint of one of the non-REST types; ids are `<component>.<prefix>.<slug of name>`. */
export function endpoint(f: {
  repo: RepoHandle;
  component: string;
  endpointType: "graphql" | "grpc" | "websocket" | "sse" | "webhook" | "function" | "rest";
  prefix: string;
  name: string;
  method?: string;
  pathOrTopic: string;
  normalizedPath?: string;
  source: "code" | "config" | "spec" | "infrastructure";
  path: string;
  line?: number;
  side?: "callee" | "definition";
}): CatalogRecord {
  return {
    schemaVersion: 2,
    kind: "Endpoint",
    id: clipId(`${slug(f.component)}.${f.prefix}.${slug(f.name) || "root"}`),
    status: "current",
    confidence: "verified",
    component: slug(f.component),
    endpointType: f.endpointType,
    ...(f.method ? { method: f.method } : {}),
    pathOrTopic: f.pathOrTopic,
    ...(f.normalizedPath ? { normalizedPath: f.normalizedPath } : {}),
    schemaRefs: [],
    evidence: [ev(f.repo, f.source, f.path, f.line, f.side ?? "definition")],
  } as unknown as CatalogRecord;
}

/** A Component record of one of the documented types (ADR 0040). */
export function component(f: {
  repo: RepoHandle;
  ctx: ScanContext;
  id: string;
  type: string;
  runtime?: string;
  source: "code" | "config" | "infrastructure";
  path: string;
  line?: number;
}): CatalogRecord {
  const id = slug(f.id);
  return {
    schemaVersion: 2,
    kind: "Component",
    id,
    status: "current",
    confidence: "verified",
    system: f.ctx.system ?? id,
    repo: f.repo.name,
    type: f.type,
    ...(f.runtime ? { runtime: f.runtime } : {}),
    evidence: [ev(f.repo, f.source, f.path, f.line)],
  } as unknown as CatalogRecord;
}

/** Any Setting; ids are `<component>[.<env>].<key slug>` as elsewhere. */
export function setting(f: {
  repo: RepoHandle;
  component: string;
  env?: string;
  settingKind: "schedule" | "retry" | "timeout" | "circuit-breaker" | "pool" | "config";
  key: string;
  value: string;
  target?: string;
  source: "code" | "config" | "infrastructure";
  path: string;
  line?: number;
}): CatalogRecord {
  const env = f.env && f.env !== "default" ? f.env : undefined;
  const keySlug = settingSlug(f.key);
  return {
    schemaVersion: 2,
    kind: "Setting",
    id: clipId(`${slug(f.component)}${env ? `.${slug(env)}` : ""}.${keySlug}`),
    status: "current",
    confidence: "verified",
    component: slug(f.component),
    ...(env ? { env } : {}),
    settingKind: f.settingKind,
    key: f.key,
    valueOrRef: f.value,
    ...(f.target ? { target: f.target } : {}),
    evidence: [ev(f.repo, f.source, f.path, f.line)],
  } as unknown as CatalogRecord;
}

/** Line number (1-based) of a character offset. */
export function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Blank out comments while keeping strings, offsets and line breaks, so a regular expression
 * never matches commented-out code and line numbers stay right. `c` covers // and block
 * comments (Java, Kotlin, JS/TS, Go, C#, Swift, Dart, GraphQL descriptions are kept), `hash`
 * covers # comments (Python, YAML, GraphQL, protobuf uses `c`).
 */
export function stripComments(text: string, style: "c" | "hash"): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === '"' || ch === "'" || ch === "`") {
      // Python and Dart triple quotes, and every simple quoted string.
      const triple = text.startsWith(ch.repeat(3), i);
      const close = triple ? ch.repeat(3) : ch;
      let j = i + close.length;
      while (j < n && !text.startsWith(close, j)) {
        if (text[j] === "\\") j++;
        else if (!triple && ch !== "`" && text[j] === "\n") break;
        j++;
      }
      j = Math.min(n, j + close.length);
      out += text.slice(i, j);
      i = j;
    } else if (style === "c" && ch === "/" && next === "/") {
      while (i < n && text[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (style === "c" && ch === "/" && next === "*") {
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
    } else if (style === "hash" && ch === "#") {
      while (i < n && text[i] !== "\n") {
        out += " ";
        i++;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Read a file, warning instead of failing when it can't be read. */
export async function read(
  repo: RepoHandle,
  ctx: ScanContext,
  path: string,
): Promise<string | undefined> {
  try {
    return await repo.readText(path);
  } catch (err) {
    ctx.warn(`Could not read this file: ${err instanceof Error ? err.message : String(err)}`, path);
    return undefined;
  }
}

/** Claimed source files, without dependencies, build output and tests. */
export async function sources(repo: RepoHandle, globs: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const p of repo.listFiles(globs)) if (!skipPath(p)) out.push(p);
  return out.sort();
}

/** First host label of a URL, the usual component name in internal host names. */
export function hostOf(url: string): string | undefined {
  return /^[a-z][a-z0-9+.-]*:\/\/([^/:?#]+)/i.exec(url)?.[1]?.toLowerCase();
}

/** `/orders/{id}` from a template literal `/orders/${id}` or `:id` style path. */
export function templatePath(raw: string): string {
  return raw
    .replace(
      /\$\{\s*([^}]+?)\s*\}/g,
      (_w, e: string) => `{${e.split(".").pop()!.replace(/\W/g, "")}}`,
    )
    .replace(/\\\(([^)]+)\)/g, (_w, e: string) => `{${e.split(".").pop()!.replace(/\W/g, "")}}`)
    .replace(/\$(\w+)/g, "{$1}");
}
