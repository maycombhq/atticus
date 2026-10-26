import { globToRegExp } from "@maycombhq/sdk";
import type { FileSource } from "./source.js";
import { isSourceFile } from "./verify.js";

/**
 * The batches of a repo read by an assistant that can't open files itself (ADR 0124 §4, tiers 2
 * and 3): the repo's source files in reading order (build and deploy files, config, then the files
 * that look like entry points and boundaries, tests last), sliced into batches whose numbered text
 * fits the room a model's limit leaves (ADR 0112), beside the topic rules its kinds of file need
 * (addendum A-lean). Every source line is in exactly one batch; a
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
  /**
   * The least room any file had for its lines once its own kinds' topic rules were counted
   * (`overhead`); the room itself when there are none. Under the room a prompt is worth, the
   * model is too small for this repo's batches.
   */
  leastRoom: number;
}

export interface PlanOptions {
  /** Tokens the files of one batch may take. */
  room: number;
  /** Accepted exclusion globs (ADR 0075 scan settings). */
  exclude?: readonly string[];
  /**
   * Tokens a batch's instructions take beyond the room's for the kinds of file it holds (ADR 0124
   * addendum A-lean: the topic rules its files need). A batch's files and this together fit the
   * room. None: every batch's instructions are the same, already outside the room.
   */
  overhead?: (kinds: readonly FileKind[]) => number;
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

/**
 * The kinds of file a batch can hold, each a topic of the reading protocol's rules (ADR 0124
 * addendum A-lean): a batch prompt carries the core rules and the topic rules of its files' kinds
 * only. The same words as the protocol's topics (`RULE_TOPICS` in @maycombhq/assistant-files).
 */
export const FILE_KINDS = [
  "frontend",
  "backend",
  "routes",
  "data",
  "deploy",
  "config",
  "protocols",
  "flows",
  "gateway",
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/**
 * An API gateway's bundle (ADR 0124 addendum A-gateway): an Apigee proxy or shared flow (its XML
 * and its JavaScript), or the TargetServers, KVMs and environment config deployed with them. Its
 * path says what it is, so no other file gets the gateway's rules.
 */
const GATEWAY_FILE =
  /(^|\/)(apiproxy|sharedflowbundle)\/|(^|\/)(targetservers?|kvms?)\.json$|(^|\/)resources\/edge\/(env|org|api)\//i;
const GATEWAY_KINDS: readonly FileKind[] = ["config", "gateway"];
/** A file of no kind the path says: every kind it might be but the gateway's, which paths always say. */
const ANY_KINDS: readonly FileKind[] = FILE_KINDS.filter((k) => k !== "gateway");

/** Server-side code, every code topic but the front end's. */
const BACKEND_KINDS: readonly FileKind[] = ["backend", "routes", "data", "protocols", "flows"];
/** A single-page app's own code and templates. */
const FRONTEND_KINDS: readonly FileKind[] = ["frontend", "flows"];
/** A page or template a server renders: it serves its route too. */
const PAGE_KINDS: readonly FileKind[] = ["frontend", "routes", "flows"];
/** Code that could be either side. */
const CODE_KINDS: readonly FileKind[] = ["frontend", ...BACKEND_KINDS];
/** A structured file of no kind the paths say (YAML, JSON, XML): every topic but the code's. */
export const DATAFILE_KINDS: readonly FileKind[] = [
  "routes",
  "data",
  "deploy",
  "config",
  "protocols",
];

/** Languages run on a server (or a mainframe). */
const SERVER_CODE =
  /\.(java|kt|kts|scala|groovy|cs|vb|fs|py|rb|go|rs|php|c|cc|cpp|h|hpp|cob|cbl|cpy|jcl)$/i;
/** Languages an app on a device is written in, as often as a server. */
const DEVICE_CODE = /\.(swift|m|mm)$/i;
const SCRIPT_CODE = /\.(ts|js|mjs|cjs)$/i;
/** A single-page app's screens and templates. */
const SPA_FILE = /\.(tsx|jsx|vue|svelte)$|\.(component|directive|pipe)\.([jt]s|html)$/i;
/** A page or template a server renders (or a static page). */
const PAGE_FILE = /\.(html?|cshtml|razor|aspx|ascx|master|jsp|ftl|hbs)$/i;
/** Code behind a page (`Index.cshtml.cs`, `Default.aspx.cs`) is both sides. */
const PAGE_CODE = /\.(cshtml|razor|aspx|ascx|master)\.(cs|vb)$/i;
/** Where a .tsx or .jsx file may run on the server too (Next.js app and pages, Remix routes). */
const SERVER_UI = /(^|\/)(app|pages|routes|server|api)\//;
/** A .ts or .js file in a front end's own folders. */
const FRONT_DIR =
  /(^|\/)(components|hooks|composables|views|screens|public|static|assets|wwwroot|ClientApp|frontend|front-end)\//i;
/** A .ts or .js file that a back end's framework names (NestJS), or in a back end's folders. */
const BACK_SCRIPT =
  /\.(controller|resolver|gateway|entity|repository|module|guard|middleware|consumer|processor)\.[jt]s$|(^|\/)(server|functions|lambdas?|src\/main)\//;
/** An Android or other device app's folders, for Kotlin and Java. */
const DEVICE_DIR = /(^|\/)(android|ios|mobile|ui|screens?|activities|fragments|compose)\//i;
/** Code that holds settings: an environment or settings file, a config folder. */
const CONFIG_CODE =
  /(^|\/)(config|configuration|settings|environments?)(\/|\.[^/]+$)|(^|\/)environment[^/]*\.[jt]s$/i;
/** Infrastructure as code: it can also declare routes, queues, topics and tables. */
const IAC =
  /\.(tf|tfvars|hcl|bicep)$|(^|\/)(serverless|template)[^/]*\.ya?ml$|(^|\/)(cdk|pulumi|terraform)\//;
const DATA_FILE = /\.sql$|(^|\/)(migrations?|db|database|changelogs?|liquibase|flyway)\//i;
const CONTRACT = /\.(proto|avsc|wsdl|xsd)$/i;
const API_SCHEMA = /\.(graphql|gql)$|(^|\/)(openapi|swagger|asyncapi)[^/]*\.(ya?ml|json)$/i;
const STRUCTURED = /\.(ya?ml|json|xml|config|properties|toml|ini|conf)$/i;

/**
 * The kinds of a file, from its path alone (ADR 0124 addendum A-lean). Conservative: where the
 * path can't say which side or topic a file is, it gets every kind it might be, so a batch never
 * goes without a rule its files need.
 */
export function fileKinds(path: string): FileKind[] {
  if (GATEWAY_FILE.test(path)) return [...GATEWAY_KINDS];
  const k = new Set<FileKind>();
  const add = (ks: readonly FileKind[]) => ks.forEach((x) => k.add(x));
  if (BUILD.test(path) || DEPLOY_DIR.test(path)) {
    add(["deploy", "config"]);
    if (IAC.test(path)) add(DATAFILE_KINDS);
  }
  if (CONFIG.test(path)) add(["config"]);
  if (DATA_FILE.test(path)) add(["data"]);
  if (CONTRACT.test(path)) add(["protocols"]);
  if (API_SCHEMA.test(path)) add(["routes", "protocols"]);
  const isCode = SERVER_CODE.test(path) || DEVICE_CODE.test(path) || SCRIPT_CODE.test(path);
  if (PAGE_CODE.test(path) || DEVICE_CODE.test(path)) add(CODE_KINDS);
  else if (SPA_FILE.test(path))
    add(/\.(tsx|jsx)$/i.test(path) && SERVER_UI.test(path) ? CODE_KINDS : FRONTEND_KINDS);
  else if (PAGE_FILE.test(path)) add(PAGE_KINDS);
  else if (SERVER_CODE.test(path))
    add(/\.(kt|java)$/i.test(path) && DEVICE_DIR.test(path) ? CODE_KINDS : BACKEND_KINDS);
  else if (SCRIPT_CODE.test(path))
    add(
      BACK_SCRIPT.test(path) ? BACKEND_KINDS : FRONT_DIR.test(path) ? FRONTEND_KINDS : CODE_KINDS,
    );
  if (isCode && CONFIG_CODE.test(path)) add(["config"]);
  if (!k.size) add(STRUCTURED.test(path) ? DATAFILE_KINDS : ANY_KINDS);
  return FILE_KINDS.filter((x) => k.has(x));
}

/** The kinds of a batch: its files' kinds together, in FILE_KINDS order. */
export function kindsOf(paths: Iterable<string>): FileKind[] {
  const k = new Set<FileKind>();
  for (const p of paths) for (const x of fileKinds(p)) k.add(x);
  return FILE_KINDS.filter((x) => k.has(x));
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
    const ls = linesOf(text);
    if (!isSourceFile(p, ls[0] ?? "", ls)) continue;
    if (excludeRes.some((re) => re.test(p))) {
      excluded.push(p);
      continue;
    }
    if (!text.trim()) continue;
    paths.push(p);
    texts.set(p, text);
  }

  const costs = new Map<string, number>();
  const overhead = (kinds: readonly FileKind[]) => {
    if (!o.overhead) return 0;
    const key = kinds.join(",");
    if (!costs.has(key)) costs.set(key, o.overhead(kinds));
    return costs.get(key)!;
  };

  // Each file whole when it fits the room its topic rules leave, else in line ranges that each do.
  const slices: (FileSlice & { kinds: FileKind[] })[] = [];
  let lines = 0;
  let leastRoom = room;
  for (const path of readingOrder(paths)) {
    const kinds = fileKinds(path);
    const left = room - overhead(kinds);
    leastRoom = Math.min(leastRoom, left);
    const fileRoom = Math.max(1, left);
    const all = linesOf(texts.get(path)!);
    const of = all.length;
    lines += of;
    // The characters of each numbered line, with its line break: a range's size is a sum.
    const sizes = all.map((l, i) => `${i + 1}| ${l}`.length + 1);
    const cost = (from: number, chars: number) =>
      tokensOf(header({ path, from, to: of, of }).length + chars);
    const total = sizes.reduce((n, c) => n + c, 0);
    if (cost(1, total) <= fileRoom) {
      slices.push({ path, from: 1, to: of, of, tokens: cost(1, total), kinds });
      continue;
    }
    let from = 1;
    while (from <= of) {
      // The longest range from `from` that fits; at least one line.
      let to = from;
      let chars = sizes[from - 1]!;
      while (to < of && cost(from, chars + sizes[to]!) <= fileRoom) chars += sizes[to++]!;
      slices.push({ path, from, to, of, tokens: cost(from, chars), kinds });
      from = to + 1;
    }
  }

  // A batch takes slices while they and the topic rules of all their kinds fit the room.
  const batches: FileSlice[][] = [];
  let current: FileSlice[] = [];
  let kinds = new Set<FileKind>();
  let used = 0;
  for (const { kinds: own, ...s } of slices) {
    const joined = FILE_KINDS.filter((x) => kinds.has(x) || own.includes(x));
    if (current.length && used + s.tokens + overhead(joined) > room) {
      batches.push(current);
      current = [];
      kinds = new Set();
      used = 0;
    }
    current.push(s);
    own.forEach((x) => kinds.add(x));
    used += s.tokens;
  }
  if (current.length) batches.push(current);

  return {
    files: paths.length,
    lines,
    tokens: slices.reduce((n, s) => n + s.tokens, 0),
    batches,
    excluded: excluded.sort(),
    leastRoom,
  };
}
