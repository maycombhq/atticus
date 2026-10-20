import { createHash } from "node:crypto";
import { normalizePath, type CatalogRecord, type EvidenceSource } from "@maycombhq/core";
import type { z } from "zod";
import type { RepoHandle, ScanContext } from "@maycombhq/sdk";
import { flattenProperties, flattenYamlDocuments, type ConfigValue } from "./lang/config.js";

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

/**
 * Component id for a fact: the module's its file is in (ADR 0057), else the manifest's
 * component, else the repo id.
 */
export function componentOf(repo: RepoHandle, ctx: ScanContext, path?: string): string {
  if (path && ctx.modules?.length) {
    let best: { path: string; component: string } | undefined;
    for (const m of ctx.modules)
      if (path.startsWith(`${m.path}/`) && (!best || m.path.length > best.path.length)) best = m;
    if (best) return best.component;
  }
  return ctx.component ?? repo.name;
}

export function looseEnd(
  repo: RepoHandle,
  ctx: ScanContext,
  kind: LooseEndKind,
  raw: string,
  ev: Ev,
): CatalogRecord {
  const owner = componentOf(repo, ctx, ev.path);
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
  return layer(await configSources(repo, globs), () => true);
}

/**
 * Config for each file of a repo: a module's own config (files under the folder that holds
 * its src/), then the repo's root config, each layered as repoConfig does. For multi-module
 * repos, where each module has its own application.yml.
 */
export async function repoConfigFor(
  repo: RepoHandle,
  globs?: string[],
): Promise<(path: string) => Map<string, ConfigValue>> {
  const sources = await configSources(repo, globs);
  const rootOf = (p: string) => /^(.*?)\/?src\//.exec(p)?.[1] ?? "";
  const modules = new Map<string, Map<string, ConfigValue>>();
  const root = layer(sources, (s) => rootOf(s.file) === "");
  return (path: string) => {
    const mod = rootOf(path);
    if (mod === "") return root;
    if (!modules.has(mod)) {
      const own = layer(sources, (s) => rootOf(s.file) === mod);
      modules.set(mod, new Map([...root, ...own]));
    }
    return modules.get(mod)!;
  };
}

/** Profiles a catalog reads when a key has no base value: production's, before any other. */
const PROD = /^(prod|production|prd|live)$/i;

interface ConfigSource {
  file: string;
  /** The profile a file (application-<p>.yml) or a YAML document belongs to; none for base. */
  profile?: string;
  values: Map<string, ConfigValue>;
}

async function configSources(
  repo: RepoHandle,
  globs = [
    "**/application*.yml",
    "**/application*.yaml",
    "**/application*.properties",
    "**/bootstrap*.yml",
  ],
): Promise<ConfigSource[]> {
  const out: ConfigSource[] = [];
  const files: string[] = [];
  for await (const p of repo.listFiles(globs)) if (!/\/test\//.test(p)) files.push(p);
  for (const f of files.sort()) {
    const text = await repo.readText(f);
    const fileProfile = /(?:application|bootstrap)-([^/.]+)\.(?:ya?ml|properties)$/.exec(f)?.[1];
    if (f.endsWith(".properties")) {
      out.push({
        file: f,
        ...(fileProfile ? { profile: fileProfile } : {}),
        values: flattenProperties(text, f, repo.parseCache),
      });
      continue;
    }
    for (const d of flattenYamlDocuments(text, f, repo.parseCache)) {
      const profile = d.profile ?? fileProfile;
      out.push({ file: f, ...(profile ? { profile } : {}), values: d.values });
    }
  }
  return out;
}

/**
 * One map from config sources, the way a catalog should read them: base config (no profile)
 * wins; a key set only in profiles takes production's value, then the other profiles' in name
 * order. Not "whichever file name sorts first", which let a dev URL shadow prod's.
 */
function layer(
  sources: ConfigSource[],
  keep: (s: ConfigSource) => boolean,
): Map<string, ConfigValue> {
  const rank = (s: ConfigSource) => (!s.profile ? 0 : PROD.test(s.profile) ? 1 : 2);
  const ordered = sources
    .filter(keep)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.profile ?? "").localeCompare(b.profile ?? "") ||
        a.file.split("/").pop()!.length - b.file.split("/").pop()!.length ||
        a.file.localeCompare(b.file),
    );
  const out = new Map<string, ConfigValue>();
  for (const s of ordered) for (const [k, v] of s.values) if (!out.has(k)) out.set(k, v);
  return out;
}

/** Split a URL into host and path; relative URLs have no host. */
export function splitUrl(url: string): { scheme?: string; host?: string; path: string } {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(url);
  if (m) return { scheme: m[1]!.toLowerCase(), host: m[2]!.toLowerCase(), path: m[3] || "/" };
  return { path: url.split(/[?#]/)[0] ?? "" };
}
