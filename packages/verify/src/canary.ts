import {
  canaryClaimText,
  canaryNeedleOf,
  foldCanary,
  isSecretPath,
  removedBy,
  seededShuffle,
  type CanaryPlantedT,
  type CanaryRemovedT,
  type CanarySkippedT,
  type CanaryWhat,
  type Fact,
} from "@maycombhq/core";
import type { FileSource } from "./source.js";

/**
 * Canaries (plan item Z2, ADR 0196): what to plant in a scratch copy of a repo and which of its
 * real lines to comment out, decided from the copy's files, the repo's verified facts and a seed
 * alone, so the same three give the same plan on any machine. Planting is by template, one per
 * stack the readers already cover (Spring on Java, Node on TypeScript or JavaScript, Python);
 * nothing is parsed beyond finding a folder of that stack's source to plant beside, the app or
 * router to plant a route on, and the libraries its build files declare (an item is planted only
 * with a library the repo already has, so it is served as the repo's own code is). Pure: the
 * caller writes the files it gives back.
 */

export const CANARY_STACKS = ["spring", "node", "python"] as const;
export type CanaryStack = (typeof CANARY_STACKS)[number];

/** How many real lines a plant comments out, unless asked for another number. */
export const CANARY_DEFAULT_REMOVALS = 3;

/**
 * Plain words for the planted names: unremarkable in any domain, none an organisation's. Two
 * make a name (`heron-quartz`), every one drawn once a plant, none that a fact of the repo uses.
 */
const WORDS = [
  "amber",
  "aspen",
  "basalt",
  "birch",
  "bramble",
  "cedar",
  "cobalt",
  "coral",
  "cypress",
  "dune",
  "ember",
  "fennel",
  "fjord",
  "garnet",
  "glacier",
  "hazel",
  "heron",
  "indigo",
  "juniper",
  "kelp",
  "kestrel",
  "larch",
  "lumen",
  "maple",
  "marlin",
  "meadow",
  "nimbus",
  "nutmeg",
  "onyx",
  "orchid",
  "pebble",
  "plover",
  "quartz",
  "quill",
  "raven",
  "reed",
  "saffron",
  "sorrel",
  "spruce",
  "tamarack",
  "thistle",
  "tundra",
  "umber",
  "vale",
  "willow",
  "wren",
  "yarrow",
  "zephyr",
];

const SPRING = /\borg\.springframework\b/;
const SPRING_APP = /@SpringBootApplication\b/;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|e2e|fixtures?)\//i;
const TEST_FILE =
  /(\.(test|spec)\.[cm]?[jt]sx?$|_test\.py$|^test_.*\.py$|Test\.java$|Tests\.java$)/;
const NODE_SOURCE = /\.(ts|tsx|js|jsx|mjs)$/;
const NOT_NODE_SOURCE = /(\.d\.ts$|\.config\.[cm]?[jt]s$|\.min\.js$)/;

/**
 * Files a canary's copy never holds (review of ADR 0196), beyond the secrets' files no map
 * quotes (`isSecretPath`): credentials for package registries, hosts, clusters and containers,
 * env files by any name, secrets' and service accounts' files, Terraform's variables and state,
 * password files, keys and key stores. Stricter than `isSecretPath`, on purpose: the copy needs no
 * line of them, while a map may cite (say) a `.tfvars` file a deploy is configured by. A hard link
 * to a file outside the repo can't be told from the repo's own file; the copy leaves out any file
 * with more than one link as a precaution.
 */
const NEVER_COPIED = [
  // registries, hosts, databases, clouds and vaults (second review of ADR 0196: the rest of them)
  /(^|\/)[._]?(npmrc|pypirc|netrc|git-credentials|htpasswd|envrc|pgpass|my\.cnf|s3cfg|boto|vault-token|dockercfg|yarnrc|terraformrc|bowerrc)$/i,
  /(^|\/)\.yarnrc\.yml$/i,
  /(^|\/)kubeconfig([._-][^/]*)?$/i,
  /(^|\/)\.kube\/config$/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)\.ssh\//i,
  /(^|\/)\.config\/gh\/hosts\.ya?ml$/i,
  /(^|\/)\.cargo\/credentials(\.toml)?$/i,
  /(^|\/)\.gradle\/gradle\.properties$/i,
  /(^|\/)credentials\.tfrc\.json$/i,
  /(^|\/)settings-security\.xml$/i,
  /(^|\/)wallet\.dat$/i,
  /\.env$/i,
  /(^|\/)\.env\.[^/]+$/i,
  /(^|\/|[-_.])secrets?\.(ya?ml|json)$/i,
  /(^|\/)local\.settings\.json$/i,
  /(^|\/)appsettings\.[^/]*secrets?[^/]*\.json$/i,
  /(^|\/)auth\.json$/i,
  /(^|\/)service[-_]?account[^/]*\.json$/i,
  /(^|\/)[^/]*sa[-_]key[^/]*\.json$/i,
  /(^|\/)[^/]*[-_]key\.json$/i,
  /(^|\/)firebase-adminsdk[^/]*\.json$/i,
  /(^|\/)client_secret[^/]*\.json$/i,
  /\.tfvars(\.json)?$/i,
  /\.tfstate([.][^/]*)?$/i,
  /\.(p8|p12|pfx|kdbx|keystore|jks|pem|key|ppk|keytab|asc|gpg|ovpn)$/i,
];
/** A backup's or editor's copy of a file: `.netrc.bak`, `.git-credentials.old`, `id_rsa~`. */
const BACKUP = /(\.(bak|old|orig|backup|save|swp|tmp)|~)$/i;

/** Whether a file is never copied into a canary's copy, nor any line of it taken out. */
export function canaryNeverCopied(path: string): boolean {
  if (isSecretPath(path)) return true;
  // read as isSecretPath reads it: an NTFS stream's name and trailing dots and spaces dropped
  let p = path
    .replace(/\\/g, "/")
    .split("/")
    .map((x) => x.replace(/:.*$/, "").replace(/[. ]+$/, ""))
    .join("/");
  for (;;) {
    if (NEVER_COPIED.some((re) => re.test(p))) return true;
    // a backup of a file never copied is never copied either
    const q = p.replace(BACKUP, "");
    if (q === p) return false;
    if (isSecretPath(q)) return true;
    p = q;
  }
}

/** How much of a file's start `canaryHoldsSecret` is given to read: no file is read whole for it. */
export const CANARY_SECRET_PREFIX = 64 * 1024;

/**
 * Whether a file's start holds a secret by its content, whatever the file is named (second review
 * of ADR 0196): a private key's header, an AWS secret key, a service account's `"private_key":`,
 * a registry's `_authToken`. A file that does is never copied.
 */
export function canaryHoldsSecret(prefix: string): boolean {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----/.test(prefix) ||
    /\baws_secret_access_key\s*[=:]/i.test(prefix) ||
    /"private_key"\s*:/.test(prefix) ||
    /_authToken\s*=/.test(prefix)
  );
}

/** An item a stack's template has that this repo can't serve, and why. */
interface Skip {
  what: CanaryWhat;
  reason: string;
}

interface StackHere {
  stack: CanaryStack;
  /** The folder the code is planted in, beside a source file of the stack. */
  dir: string;
  /** Spring: the package of that file; Node: `ts` or `js`. */
  pkg?: string;
  ext?: "ts" | "js";
  /** Spring: the config file a key is appended to, when the repo has one. */
  config?: string;
  /**
   * Node, Python: the file that makes the app or a router, and its variable: the plant goes at
   * its end, on that variable, so what is planted is served as the repo's own routes are.
   */
  host?: { file: string; v: string; line: number; cjs?: boolean; flask?: boolean };
  /** The items the repo can serve: its build files declare what each uses. */
  can: ReadonlySet<CanaryWhat>;
  skipped: Skip[];
  /** Python: the HTTP client the build files declare. */
  http?: "httpx" | "requests";
  /** Node: the package runs in a browser (no server declared, a browser library is). */
  browser?: boolean;
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const source = (p: string) => !TEST_PATH.test(p) && !TEST_FILE.test(baseOf(p));

/** The variable a pattern's match names, and the line it is on. */
function hostOf(file: string, text: string, re: RegExp) {
  const m = re.exec(text);
  if (!m) return undefined;
  return { file, v: m[1]!, line: text.slice(0, m.index).split("\n").length, call: m[2] };
}

/**
 * A module-level app or router, by the call that makes it: typed or not (`const app: Express =
 * express()`), a router with its options (`express.Router({ mergeParams: true })`).
 */
const NODE_APP =
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w$.<>[\], ]+?\s*)?=\s*(express\s*\.\s*Router|express|Router)\s*\(\s*(?:\{[^(){}]*\}\s*)?\)/m;
/** A module-level app or router (`app = FastAPI()`, `app: FastAPI = FastAPI()`, `bp = Blueprint(`). */
const PY_APP =
  /^([A-Za-z_]\w*)\s*(?::\s*[\w.[\], ]+?\s*)?=\s*(APIRouter|FastAPI|Flask|Blueprint)\s*\(/m;
/** A Flask or FastAPI app made inside a function: an app factory, no module-level app. */
const PY_FACTORY = /^\s+[A-Za-z_]\w*\s*(?::[^=\n]+)?=\s*(Flask|FastAPI)\s*\(/m;

/** Whether a folder is the other or one above it (`""` is the repo's root). */
const within = (dir: string, of: string) => of === "" || dir === of || dir.startsWith(`${of}/`);

/**
 * The build files a module is built by (second review of ADR 0196: per module, not pooled): those
 * in the file's folder or one above it, a file in a `requirements/` folder counted as its parent's.
 */
function buildFilesOf(files: readonly string[], file: string, isBuild: (p: string) => boolean) {
  const at = dirOf(file);
  return files.filter((f) => {
    if (!isBuild(f)) return false;
    const home = /(^|\/)requirements\/[^/]+$/.test(f) ? dirOf(dirOf(f)) : dirOf(f);
    return within(at, home);
  });
}

const GRADLE_BUILD = /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/;
const CONVENTION = /(^|\/)(buildSrc|build-logic)\/.*\.gradle(\.kts)?$/;
const CATALOG = /(^|\/)gradle\/([^/]+)\.versions\.toml$/;
/** `.` and `_` read as `-`: `libs.spring.boot.starter.web` and `spring-boot-starter-web` alike. */
const dashed = (s: string) => s.replace(/[._]/g, "-");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The text a Spring module's libraries are looked for in: its own and its parents' build files,
 * the convention plugins of `buildSrc` or `build-logic` they apply (by id, to a fixpoint), and
 * the artifacts a version catalog's aliases they use stand for (`libs.boot.web` for
 * `spring-boot-starter-web`); `.` and `_` read as `-`.
 */
function springBuildText(src: FileSource, files: readonly string[], file: string): string {
  const parts = buildFilesOf(files, file, (f) => GRADLE_BUILD.test(f) && !CONVENTION.test(f)).map(
    (f) => src.read(f) ?? "",
  );
  const conventions = files
    .filter((f) => CONVENTION.test(f))
    .map((f) => ({ id: baseOf(f).replace(/\.gradle(\.kts)?$/, ""), text: src.read(f) ?? "" }));
  const applied = new Set<string>();
  for (let more = true; more;) {
    more = false;
    const all = parts.join("\n");
    for (const c of conventions)
      if (!applied.has(c.id) && new RegExp(`["'\`]${escapeRe(c.id)}["'\`]`).test(all)) {
        applied.add(c.id);
        parts.push(c.text);
        more = true;
      }
  }
  let text = dashed(parts.join("\n"));
  for (const f of files.filter((x) => CATALOG.test(x))) {
    const name = dashed(CATALOG.exec(f)![2]!);
    for (const l of (src.read(f) ?? "").split("\n")) {
      const m =
        /^\s*([A-Za-z0-9_.-]+)\s*=\s*(?:\{[^}]*?\bmodule\s*=\s*"[^":]+:([^":]+)"|\{[^}]*?\bname\s*=\s*"([^"]+)"|"[^":]+:([^":]+)(?::[^"]*)?")/.exec(
          l,
        );
      const artifact = m && (m[2] ?? m[3] ?? m[4]);
      if (!artifact) continue;
      if (new RegExp(`\\b${escapeRe(`${name}-${dashed(m[1]!)}`)}(?![A-Za-z0-9-])`).test(text))
        text += `\n${artifact}`;
    }
  }
  return text;
}

const SPRING_WEB =
  /spring-boot-starter-web\b|spring-boot-starter-webflux|spring-webmvc|spring-webflux|spring-web\b/;
/** Spring Kafka, or Spring Cloud Stream's Kafka binder, which brings it. */
const SPRING_KAFKA =
  /\bspring-kafka\b|\bspring-cloud-stream-binder-kafka\b|\bspring-cloud-starter-stream-kafka\b/;

/** Servers a Node package may serve routes with, and the libraries of an app run in a browser. */
const NODE_SERVERS = ["express", "fastify", "koa", "@hapi/hapi", "@nestjs/core", "hono", "next"];
const BROWSER_LIBS = [
  "react",
  "react-dom",
  "vue",
  "svelte",
  "@angular/core",
  "preact",
  "solid-js",
  "vite",
  "@vitejs/plugin-react",
  "webpack",
  "parcel",
];

/** The package.json nearest a file: its own folder's, else the nearest folder above's. */
function packageOf(files: readonly string[], file: string): string | undefined {
  const all = new Set(files);
  for (let d = dirOf(file); ; d = dirOf(d)) {
    if (all.has(join(d, "package.json"))) return join(d, "package.json");
    if (d === "") return undefined;
  }
}

/** Every package a package.json declares, of any kind of dependency. */
function nodePackages(src: FileSource, files: string[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    try {
      const j = JSON.parse(src.read(f) ?? "") as Record<string, unknown>;
      for (const k of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        const d = j[k];
        if (d && typeof d === "object") for (const n of Object.keys(d)) out.add(n);
      }
    } catch {
      // a package.json that doesn't read declares nothing
    }
  }
  return out;
}

const skip = (what: CanaryWhat[], reason: string): Skip[] => what.map((w) => ({ what: w, reason }));

/**
 * The stacks the copy holds source of, each with the folder a plant goes in, chosen by seed, and
 * the items it can serve (review of ADR 0196): an item is planted only with a library the repo's
 * build files already declare, a route only on an app or router the repo makes, and Spring's
 * classes beside the `@SpringBootApplication` class, so its scan finds them.
 */
export function canaryStacks(src: FileSource, seed: string): StackHere[] {
  const files = src.list();
  const pick = (list: string[], what: string) =>
    seededShuffle(
      list.map((id) => ({ id })),
      `${seed}:${what}`,
    )[0]?.id;
  const out: StackHere[] = [];

  const springFiles = files.filter(
    (f) => f.endsWith(".java") && source(f) && SPRING.test(src.read(f) ?? ""),
  );
  if (springFiles.length) {
    const app = pick(
      springFiles.filter((f) => SPRING_APP.test(src.read(f) ?? "")),
      "spring-app",
    );
    const spring = app ?? pick(springFiles, "spring")!;
    const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(src.read(spring) ?? "")?.[1];
    // the module the class is built in: the folder of the nearest build file above it
    const module = buildFilesOf(files, spring, (f) => GRADLE_BUILD.test(f) && !CONVENTION.test(f))
      .map(dirOf)
      .sort((a, b) => b.length - a.length)[0];
    const configs = files
      .filter((f) => /(^|\/)application\.(ya?ml|properties)$/.test(f) && source(f))
      .sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
    const config =
      configs.find((f) => module !== undefined && within(dirOf(f), module)) ??
      (module === undefined || module === "" ? configs[0] : undefined);
    const build = springBuildText(src, files, spring);
    const web = SPRING_WEB.test(build);
    const kafka = SPRING_KAFKA.test(build);
    const can = new Set<CanaryWhat>();
    const skipped: Skip[] = [];
    if (!app)
      skipped.push(
        ...skip(
          ["entry", "call", "topic-in", "topic-out"],
          "no @SpringBootApplication class, so no scan would find a new class",
        ),
      );
    else {
      if (web) can.add("entry").add("call");
      else
        skipped.push(
          ...skip(
            ["entry", "call"],
            "the app's module's build files declare no Spring web library (spring-web)",
          ),
        );
      if (kafka) can.add("topic-in").add("topic-out");
      else
        skipped.push(
          ...skip(
            ["topic-in", "topic-out"],
            "the app's module's build files declare no Kafka client (spring-kafka, or Spring Cloud Stream's Kafka binder)",
          ),
        );
    }
    if (config || can.has("entry")) can.add("config");
    else
      skipped.push(
        ...skip(["config"], "no application config file, and no web class to read a key in"),
      );
    out.push({
      stack: "spring",
      dir: dirOf(spring),
      ...(pkg ? { pkg } : {}),
      ...(config ? { config } : {}),
      can,
      skipped,
    });
  }

  if (files.some((f) => baseOf(f) === "package.json")) {
    const nodeFiles = files.filter(
      (f) => NODE_SOURCE.test(f) && !NOT_NODE_SOURCE.test(f) && source(f),
    );
    const ext = nodeFiles.some((f) => /\.tsx?$/.test(f)) ? ("ts" as const) : ("js" as const);
    // Second review of ADR 0196: what a file can use is what its own package declares (the
    // package.json nearest it), not what any package of a workspace does.
    const pkgsCache = new Map<string, Set<string>>();
    const pkgsOf = (f: string) => {
      const p = packageOf(files, f) ?? "";
      if (!pkgsCache.has(p)) pkgsCache.set(p, nodePackages(src, p ? [p] : []));
      return pkgsCache.get(p)!;
    };
    const app = pick(
      nodeFiles.filter((f) => pkgsOf(f).has("express") && NODE_APP.test(src.read(f) ?? "")),
      "node-app",
    );
    const under = nodeFiles.filter((f) => /(^|\/)src\//.test(f));
    const node = app ?? pick(under.length ? under : nodeFiles, "node");
    if (node) {
      const pkgs = pkgsOf(node);
      const text = app ? (src.read(app) ?? "") : "";
      const cjs = !/^\s*(import|export)\s/m.test(text) && /\brequire\(/.test(text);
      // an app run in a browser has no process.env: no config is planted there, and its call
      // goes to a path of its own origin
      const browser =
        !NODE_SERVERS.some((s) => pkgs.has(s)) && BROWSER_LIBS.some((s) => pkgs.has(s));
      // fetch is global in Node 18 and in browsers
      const can = new Set<CanaryWhat>(["call"]);
      const skipped: Skip[] = [];
      if (browser)
        skipped.push(
          ...skip(["config"], "a browser app (its package declares no server) has no process.env"),
        );
      else can.add("config");
      if (app) can.add("entry");
      else
        skipped.push(
          ...skip(
            ["entry"],
            pkgs.has("express")
              ? "no express app or router made at a module's top level to serve a route on"
              : "its package declares no server (express): a browser app serves no route",
          ),
        );
      if (pkgs.has("kafkajs") && !browser) can.add("topic-in").add("topic-out");
      else
        skipped.push(
          ...skip(["topic-in", "topic-out"], "its package declares no Kafka client (kafkajs)"),
        );
      const h = app ? hostOf(app, text, NODE_APP)! : undefined;
      out.push({
        stack: "node",
        dir: dirOf(node),
        ext,
        ...(h ? { host: { file: h.file, v: h.v, line: h.line, ...(cjs ? { cjs } : {}) } } : {}),
        ...(browser ? { browser } : {}),
        can,
        skipped,
      });
    }
  }

  const pyFiles = files.filter(
    (f) => f.endsWith(".py") && source(f) && baseOf(f) !== "__init__.py",
  );
  const pyText = (f: string) => src.read(f) ?? "";
  // pip-tools' requirements.in, a requirements/ folder, Pipfile, setup files, pyproject (PEP 621
  // or Poetry), each module's own and those above it (second review of ADR 0196)
  const PY_BUILD =
    /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg|Pipfile|requirements[^/]*\.(txt|in)|requirements\/[^/]+\.(txt|in))$/;
  const declaresIn = (f: string) => {
    const text = buildFilesOf(files, f, (p) => PY_BUILD.test(p))
      .map(pyText)
      .join("\n");
    return (name: string) =>
      new RegExp(`(^|[^A-Za-z0-9_.-])${name}([^A-Za-z0-9_.-]|$)`, "im").test(text);
  };
  const allPy = files.filter((f) => f.endsWith(".py") && source(f));
  /** A Blueprint or APIRouter is served only when some module registers it on its app. */
  const registered = (v: string, call: string) =>
    call !== "Blueprint" && call !== "APIRouter"
      ? true
      : allPy.some((f) =>
          new RegExp(
            `\\b${call === "Blueprint" ? "register_blueprint" : "include_router"}\\s*\\(\\s*(?:[A-Za-z_]\\w*\\.)?${v}\\b`,
          ).test(pyText(f)),
        );
  const served = (f: string) => {
    const m = PY_APP.exec(pyText(f));
    if (!m || !registered(m[1]!, m[2]!)) return false;
    return m[2] === "Flask" || m[2] === "Blueprint"
      ? declaresIn(f)("flask")
      : declaresIn(f)("fastapi");
  };
  const pyApp = pick(
    pyFiles.filter((f) => PY_APP.test(pyText(f)) && served(f)),
    "python-app",
  );
  const py = pyApp ?? pick(pyFiles, "python");
  if (py) {
    const declares = declaresIn(py);
    const h = pyApp ? hostOf(pyApp, pyText(pyApp), PY_APP)! : undefined;
    const http = declares("httpx") ? "httpx" : declares("requests") ? "requests" : undefined;
    const can = new Set<CanaryWhat>(["config"]);
    const skipped: Skip[] = [];
    if (h) can.add("entry");
    else
      skipped.push(
        ...skip(
          ["entry"],
          files.some((f) => f.endsWith(".py") && PY_FACTORY.test(pyText(f)))
            ? "the app is made inside a function (an app factory), and no module-level router or blueprint is registered on it to serve a route on"
            : "no app or router the build files' web framework makes to serve a route on",
        ),
      );
    if (http) can.add("call");
    else
      skipped.push(...skip(["call"], "the build files declare no HTTP client (httpx, requests)"));
    if (declares("kafka-python")) can.add("topic-in").add("topic-out");
    else
      skipped.push(
        ...skip(
          ["topic-in", "topic-out"],
          "the build files declare no Kafka client (kafka-python)",
        ),
      );
    out.push({
      stack: "python",
      dir: dirOf(py),
      ...(h
        ? {
            host: {
              file: h.file,
              v: h.v,
              line: h.line,
              ...(h.call === "Flask" || h.call === "Blueprint" ? { flask: true } : {}),
            },
          }
        : {}),
      ...(http ? { http } : {}),
      can,
      skipped,
    });
  }
  return out;
}

/** One line of a template, and the item it plants, if any. */
type Line = string | { text: string; what: CanaryWhat };

interface Names {
  entry: [string, string];
  call: [string, string];
  topicIn: [string, string];
  topicOut: [string, string];
  config: [string, string];
}

const pascal = (w: string) => w[0]!.toUpperCase() + w.slice(1);

/** What each planted item claims, and its needle, from the names drawn. */
function claims(
  n: Names,
  stack: CanaryStack,
): Record<CanaryWhat, { claim: string; needle: string }> {
  const key =
    stack === "spring"
      ? `${n.config[0]}.${n.config[1]}-url`
      : `${n.config[0]}_${n.config[1]}_url`.toUpperCase();
  return {
    entry: { claim: `entry GET /${n.entry.join("-")}/{id}`, needle: n.entry.join("-") },
    call: { claim: `call GET /${n.call.join("-")}/{id}`, needle: n.call.join("-") },
    "topic-in": {
      claim: `entry topic ${n.topicIn.join(".")}.updated`,
      needle: foldCanary(`${n.topicIn.join(".")}.updated`),
    },
    "topic-out": {
      claim: `call topic ${n.topicOut.join(".")}.viewed`,
      needle: foldCanary(`${n.topicOut.join(".")}.viewed`),
    },
    config: { claim: `config ${key}`, needle: foldCanary(key) },
  };
}

interface Planting {
  files: { path: string; lines: Line[] }[];
  /** Lines appended to an existing file (a config file). */
  append?: { path: string; lines: Line[] };
}

function springPlanting(h: StackHere, n: Names, taken: Set<string>): Planting {
  const name = `${pascal(n.entry[0])}${pascal(n.entry[1])}`;
  const key = `${n.config[0]}.${n.config[1]}-url`;
  const head = h.pkg ? [`package ${h.pkg};`, ""] : [];
  const resource: Line[] = [
    ...head,
    "import org.springframework.beans.factory.annotation.Value;",
    "import org.springframework.web.bind.annotation.GetMapping;",
    "import org.springframework.web.bind.annotation.PathVariable;",
    "import org.springframework.web.bind.annotation.RestController;",
    "import org.springframework.web.client.RestTemplate;",
    "",
    "@RestController",
    `public class ${name}Resource {`,
    "  private final RestTemplate http = new RestTemplate();",
    "",
    // with a default, so an app whose config file doesn't set the key still starts
    h.config ? `  @Value("\${${key}:}")` : { text: `  @Value("\${${key}:}")`, what: "config" },
    "  private String baseUrl;",
    "",
    { text: `  @GetMapping("/${n.entry.join("-")}/{id}")`, what: "entry" },
    "  public String find(@PathVariable String id) {",
    {
      text: `    return http.getForObject(baseUrl + "/${n.call.join("-")}/{id}", String.class, id);`,
      what: "call",
    },
    "  }",
    "}",
    "",
  ];
  const events: Line[] = [
    ...head,
    "import org.springframework.kafka.annotation.KafkaListener;",
    "import org.springframework.kafka.core.KafkaTemplate;",
    "import org.springframework.stereotype.Component;",
    "",
    "@Component",
    `public class ${name}Events {`,
    "  private final KafkaTemplate<String, String> kafka;",
    "",
    `  public ${name}Events(KafkaTemplate<String, String> kafka) {`,
    "    this.kafka = kafka;",
    "  }",
    "",
    { text: `  @KafkaListener(topics = "${n.topicIn.join(".")}.updated")`, what: "topic-in" },
    "  public void onUpdated(String id) {",
    { text: `    kafka.send("${n.topicOut.join(".")}.viewed", id);`, what: "topic-out" },
    "  }",
    "}",
    "",
  ];
  const out: Planting = {
    files: [
      ...(h.can.has("entry")
        ? [{ path: free(join(h.dir, `${name}Resource.java`), taken), lines: resource }]
        : []),
      ...(h.can.has("topic-in")
        ? [{ path: free(join(h.dir, `${name}Events.java`), taken), lines: events }]
        : []),
    ],
  };
  if (h.config && h.can.has("config"))
    out.append = {
      path: h.config,
      lines: h.config.endsWith(".properties")
        ? [{ text: `${key}=https://${n.config.join("-")}.example`, what: "config" }]
        : [
            `${n.config[0]}:`,
            { text: `  ${n.config[1]}-url: https://${n.config.join("-")}.example`, what: "config" },
          ],
    };
  return out;
}

const camel = (w: [string, string]) => `${w[0]}${pascal(w[1])}`;
const snake = (w: [string, string]) => w.join("_");

function nodePlanting(h: StackHere, n: Names, taken: Set<string>): Planting {
  const env = `${n.config[0]}_${n.config[1]}_URL`.toUpperCase();
  const at = h.host;
  const kafkaOn = h.can.has("topic-in");
  const kafka = `${camel(n.entry)}Kafka`;
  const producer = `${camel(n.topicOut)}Events`;
  const consumer = `${camel(n.topicIn)}Updates`;
  const url = `${camel(n.config)}Url`;
  // Second review of ADR 0196: nothing planted would crash if it ran. The client is made only
  // when used; the producer connects before it sends and the consumer before it subscribes;
  // the route answers 502 on any failure, so an async handler never rejects unhandled; and the
  // consumer's start catches its own failure.
  const kafkaLines: Line[] = kafkaOn ? [`const ${kafka} = () => new Kafka({ brokers: [] });`] : [];
  const pad = at ? "    " : "  ";
  const send: Line[] = kafkaOn
    ? [
        `${pad}const ${producer} = ${kafka}().producer();`,
        `${pad}await ${producer}.connect();`,
        {
          text: `${pad}await ${producer}.send({ topic: "${n.topicOut.join(".")}.viewed", messages: [{ value: ${at ? "req.params.id" : "id"} }] });`,
          what: "topic-out",
        },
        `${pad}await ${producer}.disconnect();`,
      ]
    : [];
  const subscribe: Line[] = kafkaOn
    ? [
        "",
        `async function ${consumer}() {`,
        `  const consumer = ${kafka}().consumer({ groupId: "${n.topicIn.join("-")}" });`,
        "  await consumer.connect();",
        {
          text: `  await consumer.subscribe({ topic: "${n.topicIn.join(".")}.updated" });`,
          what: "topic-in",
        },
        "}",
        `${consumer}().catch(() => undefined);`,
      ]
    : [];
  const kafkaImport = kafkaOn
    ? [at?.cjs ? 'const { Kafka } = require("kafkajs");' : 'import { Kafka } from "kafkajs";']
    : [];
  // A browser app has no process.env: its call goes to a path of its own origin, no config.
  const config: Line[] = h.can.has("config")
    ? [{ text: `const ${url} = process.env.${env} ?? "";`, what: "config" }]
    : [];
  const base = h.can.has("config") ? `\${${url}}` : "";
  if (at) {
    // on the repo's own app or router: a route that calls out, and the topics beside it
    const body: Line[] = [
      ...kafkaLines,
      ...config,
      "",
      { text: `${at.v}.get("/${n.entry.join("-")}/:id", async (req, res) => {`, what: "entry" },
      "  try {",
      {
        text: `    const r = await fetch(\`${base}/${n.call.join("-")}/\${req.params.id}\`);`,
        what: "call",
      },
      ...send,
      "    res.json(await r.json());",
      "  } catch {",
      "    res.status(502).end();",
      "  }",
      "});",
      ...subscribe,
    ];
    return {
      files: [],
      append: { path: at.file, lines: ["", ...kafkaImport, ...(kafkaOn ? [""] : []), ...body] },
    };
  }
  // no app or router to serve a route on: a module of the repo's that calls out
  const id = h.ext === "ts" ? "id: string" : "id";
  return {
    files: [
      {
        path: free(join(h.dir, `${n.entry.join("-")}.${h.ext ?? "js"}`), taken),
        lines: [
          ...kafkaImport,
          ...(kafkaOn ? [""] : []),
          ...kafkaLines,
          ...config,
          ...(kafkaLines.length || config.length ? [""] : []),
          `export async function ${camel(n.entry)}(${id}) {`,
          {
            text: `  const r = await fetch(\`${base}/${n.call.join("-")}/\${id}\`);`,
            what: "call",
          },
          ...send,
          "  return r.json();",
          "}",
          ...subscribe,
          "",
        ],
      },
    ],
  };
}

function pythonPlanting(h: StackHere, n: Names, taken: Set<string>): Planting {
  const env = `${n.config[0]}_${n.config[1]}_URL`.toUpperCase();
  const at = h.host;
  const kafkaOn = h.can.has("topic-in");
  const url = `${snake(n.config)}_url`;
  const producer = `${snake(n.topicOut)}_events`;
  const param = at?.flask ? "<item_id>" : "{item_id}";
  const work: Line[] = [
    ...(h.http
      ? [
          {
            text: `    body = ${h.http}.get(f"{${url}}/${n.call.join("-")}/{item_id}").json()`,
            what: "call" as const,
          },
        ]
      : []),
    // the producer made where it sends (second review of ADR 0196: one made at import would
    // fail the import with no broker), so a failure is the route's own, answered 500
    ...(kafkaOn
      ? [
          {
            text: `    ${producer}().send("${n.topicOut.join(".")}.viewed", item_id.encode())`,
            what: "topic-out" as const,
          },
        ]
      : []),
  ];
  // a function only when it serves a route or does something
  const fn: Line[] =
    at || work.length
      ? [
          "",
          "",
          ...(at
            ? [{ text: `@${at.v}.get("/${n.entry.join("-")}/${param}")`, what: "entry" as const }]
            : []),
          `def ${snake(n.entry)}(item_id: str):`,
          ...work,
          h.http ? "    return body" : '    return {"id": item_id}',
        ]
      : [];
  const body: Line[] = [
    { text: `${url} = os.environ.get("${env}", "")`, what: "config" },
    ...(kafkaOn ? ["", "", `def ${producer}():`, "    return KafkaProducer()"] : []),
    ...fn,
    ...(kafkaOn
      ? [
          "",
          "",
          `def ${snake(n.topicIn)}_updates():`,
          {
            text: `    return KafkaConsumer("${n.topicIn.join(".")}.updated")`,
            what: "topic-in" as const,
          },
        ]
      : []),
  ];
  const imports = [
    "import os",
    ...(h.http ? ["", `import ${h.http}`] : []),
    ...(kafkaOn ? ["from kafka import KafkaConsumer, KafkaProducer"] : []),
  ];
  if (at)
    return {
      files: [],
      append: { path: at.file, lines: ["", "", ...imports, "", ...body] },
    };
  return {
    files: [
      {
        path: free(join(h.dir, `${snake(n.entry)}.py`), taken),
        lines: [...imports, "", ...body, ""],
      },
    ],
  };
}

/** A path no file of the copy has: the name, else the name with a number before its extension. */
function free(path: string, taken: Set<string>): string {
  let p = path;
  for (let i = 2; taken.has(p); i++) p = path.replace(/(\.[^./]+)$/, `${i}$1`);
  taken.add(p);
  return p;
}

const KIND_OF: Record<CanaryWhat, CanaryPlantedT["kind"]> = {
  entry: "entry",
  call: "call",
  "topic-in": "entry",
  "topic-out": "call",
  config: "config",
};

/** The comment a line is put behind, by the file's extension; none for a file we don't comment. */
function commentFor(path: string): "//" | "#" | undefined {
  if (/\.(java|kt|kts|groovy|scala|ts|tsx|js|jsx|mjs|cjs|go|cs|gradle)$/.test(path)) return "//";
  if (/\.(py|ya?ml|properties)$/.test(path)) return "#";
  return undefined;
}

const COMMENTED = /^\s*(\/\/|#|\/\*|\*|<!--|--)/;

function balanced(line: string): boolean {
  const n = (c: string) => line.split(c).length - 1;
  return n("(") === n(")") && n("[") === n("]") && n("{") === n("}");
}

/** Whether a fact's cited line can be commented out alone and leave the file as it reads. */
function removable(f: Fact, line: string | undefined): boolean {
  if (line === undefined || !line.trim()) return false;
  if (!line.toLowerCase().includes(f.cite.value.toLowerCase())) return false;
  if (COMMENTED.test(line) || !balanced(line)) return false;
  if (/\.ya?ml$/.test(f.cite.file))
    // a key with a value of its own on the line (not a block's head, not a folded scalar)
    return /^\s*(-\s+)?[^#:\s][^:]*:\s+[^\s|>#]/.test(line);
  if (f.cite.file.endsWith(".properties")) return /[=:]/.test(line);
  return true;
}

export interface CanaryPlan {
  stacks: CanaryStack[];
  planted: CanaryPlantedT[];
  removed: CanaryRemovedT[];
  /** The items a stack's template has that the repo can't serve, so not planted, and why. */
  skipped: CanarySkippedT[];
  /** The copy's files to write, whole: new files, and files a line was appended to or commented in. */
  writes: Record<string, string>;
}

/**
 * The plan for one canary: the names drawn by seed (never a word the repo's facts use), each
 * stack's template planted beside its source (at the end of the file that makes the app or
 * router, where there is one), and `removals` (default 3) of the verified facts' cited lines
 * commented out, drawn by seed across kinds (entry, call, config), each a line that can stand
 * commented alone, claiming a path or key no other fact of its kind claims.
 */
export function planCanary(o: {
  source: FileSource;
  facts: readonly Fact[];
  seed: string;
  removals?: number;
}): CanaryPlan {
  const files = o.source.list();
  const taken = new Set(files);
  const texts = new Map<string, string[]>();
  const linesOf = (p: string) => {
    if (!texts.has(p)) texts.set(p, (o.source.read(p) ?? "").split("\n"));
    return texts.get(p)!;
  };

  // Where each stack's plant goes; then the removals, from the copy as it is. A line that makes
  // the app or router a plant is added to is never taken out.
  const stacks = canaryStacks(o.source, o.seed);
  const hostLine = (f: Fact) =>
    stacks.some((h) => h.host?.file === f.cite.file && h.host.line === f.cite.line);
  const kept = o.facts.filter(
    (f) =>
      f.verified !== "none" &&
      f.by !== "person" &&
      (f.kind === "entry" || f.kind === "call" || f.kind === "config"),
  );
  // Another fact of the repo's that the score would take as a claim of the removed line (the
  // score's own `removedBy`, second review of ADR 0196) is still right once the line goes: a
  // read that writes it would be counted as a fabrication, so such a line isn't drawn.
  const near = (a: Fact, b: Fact) =>
    a.id !== b.id &&
    removedBy(
      {
        id: `remove:${a.id}`,
        fact: a.id,
        kind: a.kind,
        file: a.cite.file,
        line: a.cite.line,
        claim: a.kind,
        value: a.cite.value || "-",
        needle: canaryNeedleOf(a),
        how: "commented",
      },
      b,
    ) === "near";
  // A path or key another fact of the kind also claims is still in the code once one line goes:
  // a read that names it is right, so such a fact isn't drawn.
  const claimCount = new Map<string, number>();
  for (const f of o.facts) {
    const k = `${f.kind}\u0000${canaryNeedleOf(f)}`;
    claimCount.set(k, (claimCount.get(k) ?? 0) + 1);
  }
  const candidates = kept.filter(
    (f) =>
      claimCount.get(`${f.kind}\u0000${canaryNeedleOf(f)}`) === 1 &&
      !hostLine(f) &&
      taken.has(f.cite.file) &&
      !canaryNeverCopied(f.cite.file) &&
      commentFor(f.cite.file) !== undefined &&
      !o.facts.some((g) => near(f, g)) &&
      removable(f, linesOf(f.cite.file)[f.cite.line - 1]?.replace(/\r$/, "")),
  );
  const byKind = ["entry", "call", "config"].map((k) =>
    seededShuffle(
      candidates.filter((f) => f.kind === k),
      `${o.seed}:remove:${k}`,
    ),
  );
  const order = seededShuffle(
    byKind.map((l, i) => ({ id: String(i), l })),
    `${o.seed}:remove`,
  ).map((x) => x.l);
  const want = Math.max(0, Math.floor(o.removals ?? CANARY_DEFAULT_REMOVALS));
  const chosen: Fact[] = [];
  for (let round = 0; chosen.length < want && order.some((l) => l.length > round); round++)
    for (const l of order) {
      const f = l[round];
      if (!f || chosen.length >= want) continue;
      if (chosen.some((c) => c.cite.file === f.cite.file && c.cite.line === f.cite.line)) continue;
      chosen.push(f);
    }
  const changed = new Set<string>();
  const removed: CanaryRemovedT[] = chosen
    .map((f) => {
      const lines = linesOf(f.cite.file);
      const line = lines[f.cite.line - 1]!;
      const indent = /^\s*/.exec(line)![0];
      lines[f.cite.line - 1] = `${indent}${commentFor(f.cite.file)} ${line.slice(indent.length)}`;
      changed.add(f.cite.file);
      return {
        id: `remove:${f.id}`,
        fact: f.id,
        kind: f.kind,
        file: f.cite.file,
        line: f.cite.line,
        claim: `${f.kind} ${canaryClaimOf(f)}`,
        value: f.cite.value,
        needle: canaryNeedleOf(f),
        how: "commented" as const,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // The names: words no fact of the repo uses, drawn once each.
  const used = new Set(
    o.facts.flatMap((f) => `${canaryClaimText(f)} ${foldCanary(f.cite.file)}`.split(/[\s-]+/)),
  );
  const words = seededShuffle(
    WORDS.filter((w) => !used.has(w)).map((id) => ({ id })),
    `${o.seed}:words`,
  ).map((w) => w.id);
  const planted: CanaryPlantedT[] = [];
  const skipped: CanarySkippedT[] = [];
  const writes: Record<string, string> = {};
  stacks.forEach((h) => {
    skipped.push(...h.skipped.map((x) => ({ stack: h.stack, ...x })));
    if (!h.can.size) return;
    const w = words.splice(0, 10);
    if (w.length < 10) return;
    const names: Names = {
      entry: [w[0]!, w[1]!],
      call: [w[2]!, w[3]!],
      topicIn: [w[4]!, w[5]!],
      topicOut: [w[6]!, w[7]!],
      config: [w[8]!, w[9]!],
    };
    const said = claims(names, h.stack);
    const p =
      h.stack === "spring"
        ? springPlanting(h, names, taken)
        : h.stack === "node"
          ? nodePlanting(h, names, taken)
          : pythonPlanting(h, names, taken);
    const place = (path: string, lines: Line[], from: number) =>
      lines.forEach((l, i) => {
        if (typeof l === "string") return;
        planted.push({
          id: "",
          kind: KIND_OF[l.what],
          what: l.what,
          stack: h.stack,
          file: path,
          line: from + i + 1,
          ...said[l.what],
        });
      });
    for (const f of p.files) {
      place(f.path, f.lines, 0);
      writes[f.path] = f.lines.map((l) => (typeof l === "string" ? l : l.text)).join("\n");
    }
    if (p.append) {
      const lines = linesOf(p.append.path);
      // a file that ends without a newline gets one before the appended lines
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      const eol = lines.some((l) => l.endsWith("\r")) ? "\r" : "";
      const from = lines.length - 1;
      lines.splice(
        from,
        1,
        ...p.append.lines.map((l) => (typeof l === "string" ? l : l.text) + eol),
        "",
      );
      place(p.append.path, p.append.lines, from);
      changed.add(p.append.path);
    }
  });
  planted.forEach((p, i) => (p.id = `plant:${i + 1}`));
  for (const path of changed) writes[path] = linesOf(path).join("\n");
  return {
    stacks: stacks.filter((s) => planted.some((p) => p.stack === s.stack)).map((s) => s.stack),
    planted,
    removed,
    skipped,
    writes,
  };
}

/** A fact's claim in a few words, for the report: its method and path, topic, key or value. */
export function canaryClaimOf(f: Fact): string {
  const x = f as unknown as Record<string, string | undefined>;
  if (f.kind === "entry" || f.kind === "call")
    return [x.method?.toUpperCase(), x.path].filter(Boolean).join(" ") || f.cite.value;
  if (f.kind === "config") return x.key ?? f.cite.value;
  return f.cite.value;
}
