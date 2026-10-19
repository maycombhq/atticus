import { createHash } from "node:crypto";
import { normalizePath, type CatalogRecord, type EvidenceSource } from "@maycombhq/core";
import type { z } from "zod";
import type { RepoHandle, ScanContext } from "@maycombhq/sdk";
import { flattenProperties, flattenYaml, type ConfigValue } from "./lang/config.js";

/**
 * Helpers every built-in extractor uses, so records come out in one shape.
 *
 * Loose ends (ADR 0016): a call, publish, subscribe or database access whose other end
 * isn't in this repo is emitted as an Unresolved record. `owner` is the component holding
 * the loose end; `unresolvedKind` and `raw` follow one grammar:
 *   http-call         "METHOD URL"            (placeholders resolved where config allows)
 *   event-publish     "topic"
 *   event-subscribe   "topic"
 *   db-access         "read table" | "write table"
 *   db-connection     "jdbc-or-host URL"
 * The merge step resolves them into Interfaces, Tables' readers and writers, and so on.
 */
/**
 * What a loose end is. http-endpoint: a served path the code makes from a name (a constant) whose
 * value isn't known, so it can't be a verified Endpoint until it is.
 */
export type LooseEndKind =
  | "http-call"
  | "http-endpoint"
  | "event-publish"
  | "event-subscribe"
  | "db-access"
  | "db-connection"
  | "mq-publish"
  | "mq-subscribe";

export interface Ev {
  source: z.infer<typeof EvidenceSource>;
  path: string;
  line?: number;
  side?: "caller" | "callee" | "gateway" | "definition";
}

export const evidence = (repo: RepoHandle, e: Ev) => ({ repo: repo.name, ...e });

const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);

/** Component id for this scan: the manifest's, else the repo id. */
export const componentOf = (repo: RepoHandle, ctx: ScanContext) => ctx.component ?? repo.name;

export function looseEnd(
  repo: RepoHandle,
  ctx: ScanContext,
  kind: LooseEndKind,
  raw: string,
  ev: Ev,
): CatalogRecord {
  const owner = componentOf(repo, ctx);
  return {
    schemaVersion: 1,
    kind: "Unresolved",
    id: `${owner}.${kind}.${short(`${raw}|${ev.path}|${ev.line ?? ""}`)}`,
    status: "current",
    confidence: "inferred",
    unresolvedKind: kind,
    raw,
    owner,
    evidence: [evidence(repo, ev)],
  } as unknown as CatalogRecord;
}

/** A REST endpoint as found on the serving side; merge gives it its canonical id. */
export function restEndpoint(
  repo: RepoHandle,
  component: string,
  method: string,
  path: string,
  ev: Ev,
  extra: Record<string, unknown> = {},
): CatalogRecord {
  const m = method.toUpperCase();
  const norm = normalizePath(path);
  return {
    schemaVersion: 1,
    kind: "Endpoint",
    id: `${component}.${m.toLowerCase()}.${short(norm)}`,
    status: "current",
    confidence: "verified",
    component,
    endpointType: "rest",
    method: m,
    pathOrTopic: path,
    normalizedPath: norm,
    schemaRefs: [],
    evidence: [evidence(repo, ev)],
    ...extra,
  } as unknown as CatalogRecord;
}

/** Read and merge the repo's config files (application*.yml|yaml|properties), first wins. */
export async function repoConfig(
  repo: RepoHandle,
  globs = [
    "**/application*.yml",
    "**/application*.yaml",
    "**/application*.properties",
    "**/bootstrap*.yml",
  ],
): Promise<Map<string, ConfigValue>> {
  const out = new Map<string, ConfigValue>();
  const files: string[] = [];
  for await (const p of repo.listFiles(globs)) if (!/\/test\//.test(p)) files.push(p);
  // application.yml before profile-specific files, so defaults win for the base config.
  files.sort(
    (a, b) => a.split("/").pop()!.length - b.split("/").pop()!.length || a.localeCompare(b),
  );
  for (const f of files) {
    const text = await repo.readText(f);
    const flat = f.endsWith(".properties") ? flattenProperties(text, f) : flattenYaml(text, f);
    for (const [k, v] of flat) if (!out.has(k)) out.set(k, v);
  }
  return out;
}

/** Split a URL into host and path; relative URLs have no host. */
export function splitUrl(url: string): { scheme?: string; host?: string; path: string } {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(url);
  if (m) return { scheme: m[1]!.toLowerCase(), host: m[2]!.toLowerCase(), path: m[3] || "/" };
  return { path: url.split(/[?#]/)[0] ?? "" };
}
