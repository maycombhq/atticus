import { createHash } from "node:crypto";
import type { CatalogRecord } from "@maycombhq/core";
import type { RepoHandle, ScanContext } from "@maycombhq/sdk";
import type { Ev } from "../facts.js";
import { settingSlug } from "../spring.js";

/**
 * Helpers the platform extractors share: ids, environments, component names and the
 * Deployment and Setting shapes, so every platform record comes out the same way.
 */

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** A string for a scalar (numbers and booleans too); undefined for anything else. */
export const str = (v: unknown): string | undefined =>
  typeof v === "string"
    ? v
    : typeof v === "number" || typeof v === "boolean"
      ? String(v)
      : undefined;

export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Walk a path through plain objects and arrays. */
export function at(v: unknown, ...path: (string | number)[]): unknown {
  let cur = v;
  for (const p of path) {
    if (typeof p === "number") cur = Array.isArray(cur) ? cur[p] : undefined;
    else cur = isObj(cur) ? cur[p] : undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Same slug rule as the other built-in extractors: lowercase, dots kept, the rest dashed. */
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

/** Topic endpoint ids follow the topics extractor: `topic.<topic with every non-alphanumeric dashed>`. */
export const topicId = (topic: string) =>
  `topic.${topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;

/** Record ids are at most 120 characters; a longer one keeps its start and gains a short hash. */
export function clipId(id: string): string {
  if (id.length <= 120) return id;
  const h = createHash("sha256").update(id).digest("hex").slice(0, 10);
  return `${id.slice(0, 109).replace(/[-.]+$/, "")}-${h}`;
}

/** Evidence with optional fields left out rather than set to undefined. */
export function ev(
  repo: RepoHandle,
  source: Ev["source"],
  path: string,
  line?: number,
  side?: Ev["side"],
): Ev & { repo: string } {
  return {
    source,
    repo: repo.name,
    path,
    ...(line !== undefined ? { line } : {}),
    ...(side ? { side } : {}),
  };
}

// ------------------------------------------------------------------ environments

const ENV_WORDS = new Set([
  "dev",
  "development",
  "test",
  "testing",
  "qa",
  "sit",
  "uat",
  "stage",
  "staging",
  "preprod",
  "perf",
  "prod",
  "production",
  "dr",
  "sandbox",
  "int",
  "nonprod",
]);
/** Folders whose children are environments whatever they are called (kustomize overlays and the like). */
const ENV_PARENTS = new Set(["overlays", "envs", "environments", "env", "clusters"]);

export const isEnvWord = (s: string) => ENV_WORDS.has(s.toLowerCase());

const suffixEnv = (s: string) => {
  const last = s.toLowerCase().split(/[-_]/).at(-1);
  return last && ENV_WORDS.has(last) ? last : undefined;
};

/**
 * The environment a manifest or resource is for, from (in order) its namespace when that is
 * an environment word or ends in one (`forge-prod` → prod), a folder that is an environment
 * word or sits under overlays/, envs/ and the like, a name ending in an environment word,
 * and finally the namespace as it is. Undefined when nothing says.
 */
export function envOf(o: { namespace?: string; path: string; name?: string }): string | undefined {
  const ns = o.namespace?.toLowerCase();
  if (ns) {
    if (ENV_WORDS.has(ns)) return ns;
    const s = suffixEnv(ns);
    if (s) return s;
  }
  const dirs = o.path.toLowerCase().split("/").slice(0, -1);
  for (let i = dirs.length - 1; i >= 0; i--) {
    if (ENV_WORDS.has(dirs[i]!)) return dirs[i]!;
    if (i > 0 && ENV_PARENTS.has(dirs[i - 1]!)) return slug(dirs[i]!);
  }
  if (o.name) {
    const s = suffixEnv(o.name);
    if (s && o.name.length > s.length + 1) return s;
  }
  return ns ? slug(ns) : undefined;
}

/** `reports-job-prod` → `reports-job`: names often carry their environment. */
export function stripEnv(name: string): string {
  const s = suffixEnv(name);
  return s && name.length > s.length + 1 ? name.slice(0, -(s.length + 1)) : name;
}

// ------------------------------------------------------------------ components

/** Repo types that build no component of their own (as in the component extractor). */
const NOT_COMPONENTS = new Set(["gateway", "event-config", "infra", "library", "docs"]);

/** The repo's own component when the manifest names one and the repo builds something. */
export function ownComponent(ctx: ScanContext): string | undefined {
  if (!ctx.component) return undefined;
  if (ctx.repoType && NOT_COMPONENTS.has(ctx.repoType)) return undefined;
  return ctx.component;
}

/**
 * The component a manifest object or resource belongs to. Candidates are tried in order
 * (an app label, then the object's name), without any environment suffix; when one of them
 * is the repo's component from the manifest, or starts with it, the manifest's name wins.
 */
export function componentFor(
  ctx: ScanContext,
  candidates: (string | undefined)[],
  fallback?: string,
): string {
  const names = candidates.filter((c): c is string => !!c).map((c) => slug(stripEnv(c)));
  const own = ctx.component;
  if (own && names.some((n) => n === own || n.startsWith(`${own}-`))) return own;
  return names.find((n) => n.length > 0) ?? fallback ?? own ?? "unknown";
}

// ------------------------------------------------------------------ records

export interface Resources {
  cpu?: string;
  memory?: string;
}

/** Container limits, else requests: what a deployment is sized at. */
export function resourcesOf(container: unknown): Resources | undefined {
  for (const k of ["limits", "requests"]) {
    const r = at(container, "resources", k);
    const cpu = str(at(r, "cpu"));
    const memory = str(at(r, "memory"));
    if (cpu || memory) return { ...(cpu ? { cpu } : {}), ...(memory ? { memory } : {}) };
  }
  return undefined;
}

export const int = (v: unknown): number | undefined => {
  const n =
    typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};

export function deployment(f: {
  component: string;
  env: string;
  platform: string;
  replicas?: number;
  resources?: Resources;
  autoscaling?: { min: number; max: number };
  networkPolicies?: string[];
  evidence: Ev[];
}): CatalogRecord {
  return {
    schemaVersion: 1,
    kind: "Deployment",
    id: clipId(`${slug(f.component)}.${slug(f.env)}`),
    status: "current",
    confidence: "verified",
    component: slug(f.component),
    env: f.env,
    platform: f.platform,
    ...(f.replicas !== undefined ? { replicas: f.replicas } : {}),
    ...(f.resources ? { resources: f.resources } : {}),
    ...(f.autoscaling && f.autoscaling.max > 0 ? { autoscaling: f.autoscaling } : {}),
    networkPolicies: [...new Set(f.networkPolicies ?? [])].sort(),
    evidence: f.evidence,
  } as unknown as CatalogRecord;
}

/**
 * Setting ids are `<component>.<key slug>` (ADR 0016); a setting that holds for one
 * environment only puts the environment in between, `<component>.<env>.<key slug>`, so the
 * same job in two environments gives two records.
 */
export function settingId(component: string, env: string | undefined, key: string): string {
  const e = env && env !== "default" ? `.${slug(env)}` : "";
  return clipId(`${slug(component)}${e}.${settingSlug(key)}`);
}

export function configSetting(f: {
  component: string;
  env?: string;
  key: string;
  value: string;
  target?: string;
  evidence: Ev[];
}): CatalogRecord {
  const env = f.env && f.env !== "default" ? f.env : undefined;
  return {
    schemaVersion: 1,
    kind: "Setting",
    id: settingId(f.component, env, f.key),
    status: "current",
    confidence: "verified",
    component: slug(f.component),
    ...(env ? { env } : {}),
    settingKind: "config",
    key: f.key,
    valueOrRef: f.value,
    ...(f.target ? { target: f.target } : {}),
    evidence: f.evidence,
  } as unknown as CatalogRecord;
}

/** Read a file, warning instead of failing when it can't be read. */
export async function readOrWarn(
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

export const dirOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
