import { globToRegExp } from "@maycombhq/sdk";
import type { FileSource } from "./source.js";
import { isSourceFile } from "./verify.js";

/**
 * The batches of a repo read by an assistant that can't open files itself (ADR 0124 §4, tiers 2
 * and 3): the repo's source files in reading order (build and deploy files, config, then the files
 * that look like entry points and boundaries, tests last), sliced into batches whose numbered text
 * fits the room a model's limit leaves (ADR 0112). Every source line is in exactly one batch; a
 * file too big for one prompt is cut into line ranges, each numbered as in the file so a fact can
 * cite its line. Deterministic: the same files and room give the same batches.
 */

/** Part of one file: lines `from` to `to` (1-based, inclusive), and its tokens as sent. */
export interface FileSlice {
  path: string;
  from: number;
  to: number;
  /** Lines in the whole file. */
  of: number;
  tokens: number;
}

export interface BatchPlan {
  /** Source files read (excluded ones aside). */
  files: number;
  lines: number;
  tokens: number;
  batches: FileSlice[][];
  /** Source files an accepted exclusion rule leaves out. */
  excluded: string[];
}

export interface PlanOptions {
  /** Tokens the files of one batch may take. */
  room: number;
  /** Accepted exclusion globs (ADR 0075 scan settings). */
  exclude?: readonly string[];
}

const BUILD =
  /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|package\.json|go\.mod|Cargo\.toml|pyproject\.toml|setup\.py|[^/]+\.(csproj|sln|tf|tfvars|bicep|hcl)|Dockerfile[^/]*|Containerfile|Jenkinsfile|Makefile|Procfile|(docker-)?compose[^/]*\.ya?ml|Chart\.yaml|values[^/]*\.ya?ml|azure-pipelines[^/]*\.ya?ml|\.gitlab-ci\.yml|bitbucket-pipelines\.yml|serverless\.ya?ml|template\.ya?ml|manifest\.ya?ml)$/;
const DEPLOY_DIR =
  /(^|\/)(\.github\/workflows|\.circleci|k8s|kubernetes|helm|charts|deploy|deployment|deployments|manifests|infra|terraform|pipelines?)\//;
const CONFIG =
  /(^|\/)((application|bootstrap)[^/]*\.(ya?ml|properties)|appsettings[^/]*\.json|[^/]+\.(properties|conf|ini|toml)|web\.config|config\/[^/]+\.(ya?ml|json))$/;
const ENTRY_NAME =
  /(^|[._-])(main|app|application|server|program|startup|index|lambda|handler|function|cli)$|(controller|resource|router|routes?|handlers?|listener|consumer|subscriber|endpoints?|api|job|scheduler|worker|webhook|servlet|page|screen|view)$/i;
const ENTRY_DIR =
  /(^|\/)(controllers?|routes|routers|handlers|api|endpoints|jobs|listeners|consumers|functions|pages|screens)\//i;
const BOUNDARY_NAME =
  /(client|gateway|repository|repo|dao|mapper|entity|model|dto|request|response|publisher|producer|store|cache|schema)$/i;
const BOUNDARY_FILE =
  /\.(sql|proto|graphql|gql|avsc|wsdl|xsd)$|(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i;
const BOUNDARY_DIR =
  /(^|\/)(clients?|gateways?|repositories|dao|models?|entities|dto|migrations?)\//i;
const TEST =
  /(^|\/)(test|tests|__tests__|spec|specs|e2e|it)\/|[._-](test|spec)\.[^/.]+$|(Test|Tests|IT|Spec)\.[^/.]+$|(^|\/)test_[^/]+$|_test\.go$/;

const stem = (path: string) => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.indexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
};

/**
 * Where a file comes in the reading order: 0 build and deploy, 1 config, 2 entry points, 3
 * boundaries (clients, stores, schemas, migrations), 4 the rest, 5 tests.
 */
export function readingRank(path: string): number {
  if (TEST.test(path)) return 5;
  if (BUILD.test(path) || DEPLOY_DIR.test(path)) return 0;
  if (CONFIG.test(path)) return 1;
  const s = stem(path);
  if (ENTRY_NAME.test(s) || ENTRY_DIR.test(path)) return 2;
  if (BOUNDARY_NAME.test(s) || BOUNDARY_FILE.test(path) || BOUNDARY_DIR.test(path)) return 3;
  return 4;
}

/** Paths in reading order: by rank, then by path. */
export function readingOrder(paths: readonly string[]): string[] {
  return [...paths]
    .map((p) => ({ p, r: readingRank(p) }))
    .sort((a, b) => a.r - b.r || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0))
    .map((x) => x.p);
}

const linesOf = (text: string) => {
  const t = text.replace(/\r\n?/g, "\n");
  return (t.endsWith("\n") ? t.slice(0, -1) : t).split("\n");
};

/** Lines `from` to `to` of a file's text, each as `<n>| <text>`. */
export function numberedSlice(text: string, s: Pick<FileSlice, "from" | "to">): string {
  return linesOf(text)
    .slice(s.from - 1, s.to)
    .map((l, i) => `${s.from + i}| ${l}`)
    .join("\n");
}

const header = (s: Pick<FileSlice, "path" | "from" | "to" | "of">) =>
  `${s.path} lines ${s.from}-${s.to} of ${s.of} (numbered as in the file)`;

/** A slice as it goes in a prompt: its path and range, then its numbered lines. */
export function sliceText(source: FileSource, s: Pick<FileSlice, "path" | "from" | "to" | "of">) {
  return `${header(s)}\n${numberedSlice(source.read(s.path) ?? "", s)}`;
}

/** Tokens as context packs count them (characters / 4, ADR 0112). */
const tokensOf = (chars: number) => Math.ceil(chars / 4);

export function planBatches(source: FileSource, o: PlanOptions): BatchPlan {
  const room = Math.max(1, o.room);
  const excludeRes = (o.exclude ?? []).map(globToRegExp);
  const excluded: string[] = [];
  const paths: string[] = [];
  const texts = new Map<string, string>();
  for (const p of source.list()) {
    const text = source.read(p);
    if (text === undefined) continue;
    if (!isSourceFile(p, linesOf(text)[0] ?? "")) continue;
    if (excludeRes.some((re) => re.test(p))) {
      excluded.push(p);
      continue;
    }
    if (!text.trim()) continue;
    paths.push(p);
    texts.set(p, text);
  }

  // Each file whole when it fits the room, else in line ranges that each do.
  const slices: FileSlice[] = [];
  let lines = 0;
  for (const path of readingOrder(paths)) {
    const all = linesOf(texts.get(path)!);
    const of = all.length;
    lines += of;
    // The characters of each numbered line, with its line break: a range's size is a sum.
    const sizes = all.map((l, i) => `${i + 1}| ${l}`.length + 1);
    const cost = (from: number, chars: number) =>
      tokensOf(header({ path, from, to: of, of }).length + chars);
    const total = sizes.reduce((n, c) => n + c, 0);
    if (cost(1, total) <= room) {
      slices.push({ path, from: 1, to: of, of, tokens: cost(1, total) });
      continue;
    }
    let from = 1;
    while (from <= of) {
      // The longest range from `from` that fits; at least one line.
      let to = from;
      let chars = sizes[from - 1]!;
      while (to < of && cost(from, chars + sizes[to]!) <= room) chars += sizes[to++]!;
      slices.push({ path, from, to, of, tokens: cost(from, chars) });
      from = to + 1;
    }
  }

  const batches: FileSlice[][] = [];
  let current: FileSlice[] = [];
  let used = 0;
  for (const s of slices) {
    if (current.length && used + s.tokens > room) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(s);
    used += s.tokens;
  }
  if (current.length) batches.push(current);

  return {
    files: paths.length,
    lines,
    tokens: slices.reduce((n, s) => n + s.tokens, 0),
    batches,
    excluded: excluded.sort(),
  };
}
