import { componentExtractor } from "@maycombhq/extractors";
import { runExtractor, type RepoHandle } from "@maycombhq/sdk";

/**
 * Deterministic repo-type detection from files alone (no network, no AI), used by
 * `repos discover` and `adopt` to propose repos.manifest.yaml entries. Types are the ones
 * profiles and dialects already use: spring-boot, java, node, frontend, python, go, dotnet,
 * gateway, infra, event-config, mainframe; `unknown` becomes an owner question.
 *
 * Whether a repo builds something comes from the component extractor itself, so discovery
 * and the scan agree on what counts as a component.
 */

export const REPO_TYPES = [
  "spring-boot",
  "java",
  "frontend",
  "node",
  "python",
  "go",
  "dotnet",
  "gateway",
  "mainframe",
  "infra",
  "event-config",
  "unknown",
] as const;
export type RepoType = (typeof REPO_TYPES)[number];

export interface Detection {
  type: RepoType;
  /** The files that decided it, for the proposal and the questions. */
  signals: string[];
  /** The component extractor would emit a Component for this repo. */
  component: boolean;
  /** How sure: high when a build file names the framework, medium for a marker alone. */
  confidence: "high" | "medium" | "low";
}

const FRONTEND_DEPS = ["react", "vue", "@angular/core", "svelte", "next", "nuxt", "solid-js"];

async function first(repo: RepoHandle, globs: string[]): Promise<string | undefined> {
  for await (const p of repo.listFiles(globs)) return p;
  return undefined;
}

async function all(repo: RepoHandle, globs: string[], max = 3): Promise<string[]> {
  const out: string[] = [];
  for await (const p of repo.listFiles(globs)) {
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/** Root-level marker first, then the shallowest one anywhere. */
async function marker(repo: RepoHandle, names: string[]): Promise<string | undefined> {
  const root = await first(repo, names);
  if (root) return root;
  const deep: string[] = [];
  for await (const p of repo.listFiles(names.map((n) => `**/${n}`))) deep.push(p);
  return deep.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0];
}

async function text(repo: RepoHandle, path: string): Promise<string> {
  try {
    return await repo.readText(path);
  } catch {
    return "";
  }
}

/**
 * The words a description uses for a kind of repo (ADR 0128). Read only when the files say
 * nothing at all: a repo's own build files always win, and a guess from a description is marked
 * `low`, with the description named as its signal, so nobody mistakes it for something read.
 */
const TYPE_WORDS: readonly (readonly [RepoType, readonly string[]])[] = [
  ["gateway", ["api gateway", "gateway", "api proxy", "reverse proxy"]],
  ["infra", ["infrastructure", "terraform", "kubernetes manifests", "helm chart", "deployment"]],
  ["event-config", ["topic definitions", "event topics", "topic config", "event catalogue"]],
  ["mainframe", ["mainframe", "cobol", "batch jobs"]],
  ["frontend", ["web app", "single-page app", "front end", "frontend", "the pages"]],
];

/** The type a description names, when the files name none. */
export function typeFromDescription(text: string | undefined): RepoType | undefined {
  const t = (text ?? "").toLowerCase();
  if (!t) return undefined;
  for (const [type, words] of TYPE_WORDS) if (words.some((w) => t.includes(w))) return type;
  return undefined;
}

export async function detectRepoType(
  repo: RepoHandle,
  o: { description?: string } = {},
): Promise<Detection> {
  const comp = await runExtractor(componentExtractor, repo, {
    scannedAt: "1970-01-01T00:00:00Z",
  });
  const component = comp.records.some((r) => r.kind === "Component");
  const d = (type: RepoType, signals: string[], confidence: Detection["confidence"]) => ({
    type,
    signals,
    component,
    confidence,
  });

  const apigee = await all(repo, ["**/apiproxy/*.xml", "**/apiproxy/proxies/*.xml"]);
  const kong = await first(repo, ["kong.yaml", "kong.yml", "**/kong.yaml", "**/kong.yml"]);
  if (apigee.length || kong) return d("gateway", apigee.length ? apigee : [kong!], "high");

  const pom = await marker(repo, ["pom.xml", "build.gradle", "build.gradle.kts"]);
  const pkg = await marker(repo, ["package.json"]);
  const py = await marker(repo, ["pyproject.toml", "requirements.txt", "setup.py"]);
  const gomod = await marker(repo, ["go.mod"]);
  const dotnet = await first(repo, ["*.csproj", "*.sln", "*.fsproj", "**/*.csproj"]);
  const anyBuild = pom ?? pkg ?? py ?? gomod ?? dotnet;

  const cobol = await all(repo, [
    "**/*.cbl",
    "**/*.CBL",
    "**/*.cob",
    "**/*.COB",
    "**/*.jcl",
    "**/*.JCL",
  ]);
  if (cobol.length && !anyBuild) return d("mainframe", cobol, "high");

  if (pom) {
    const t = await text(repo, pom);
    return /spring-boot|org\.springframework\.boot/.test(t)
      ? d("spring-boot", [pom], "high")
      : d("java", [pom], "medium");
  }
  if (pkg) {
    let deps: Record<string, unknown> = {};
    try {
      const j = JSON.parse(await text(repo, pkg)) as Record<string, Record<string, unknown>>;
      deps = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) };
    } catch {
      // unreadable package.json: still a Node repo
    }
    const fe = FRONTEND_DEPS.find((n) => n in deps);
    return fe ? d("frontend", [pkg], "high") : d("node", [pkg], "medium");
  }
  if (py) return d("python", [py], "medium");
  if (gomod) return d("go", [gomod], "high");
  if (dotnet) return d("dotnet", [dotnet], "high");

  const infra = await all(repo, [
    "**/*.tf",
    "**/k8s/**/*.yaml",
    "**/k8s/**/*.yml",
    "**/kubernetes/**/*.yaml",
    "**/Chart.yaml",
    "**/kustomization.yaml",
  ]);
  if (infra.length) return d("infra", infra, "medium");
  const topics = await all(repo, ["**/topics/*.yaml", "**/topics/*.yml", "**/topics/**/*.yaml"]);
  if (topics.length) return d("event-config", topics, "medium");
  // Nothing in the files says what this is. What a person wrote about it is better than nothing,
  // and is said to be where the guess came from (ADR 0128).
  const said = typeFromDescription(o.description);
  if (said) return d(said, ["the repo's description in repos.manifest.yaml"], "low");
  return d("unknown", [], "low");
}
