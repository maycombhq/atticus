import {
  canaryClaimText,
  canaryNeedleOf,
  foldCanary,
  isSecretPath,
  seededShuffle,
  type CanaryPlantedT,
  type CanaryRemovedT,
  type CanaryWhat,
  type Fact,
} from "@maycombhq/core";
import type { FileSource } from "./source.js";

/**
 * Canaries (plan item Z2, ADR 0196): what to plant in a scratch copy of a repo and which of its
 * real lines to comment out, decided from the copy's files, the repo's verified facts and a seed
 * alone, so the same three give the same plan on any machine. Planting is by template, one per
 * stack the readers already cover (Spring on Java, Node on TypeScript or JavaScript, Python);
 * nothing is parsed beyond finding a folder of that stack's source to plant beside. Pure: the
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
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|e2e|fixtures?)\//i;
const TEST_FILE =
  /(\.(test|spec)\.[cm]?[jt]sx?$|_test\.py$|^test_.*\.py$|Test\.java$|Tests\.java$)/;
const NODE_SOURCE = /\.(ts|tsx|js|jsx|mjs)$/;
const NOT_NODE_SOURCE = /(\.d\.ts$|\.config\.[cm]?[jt]s$|\.min\.js$)/;

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
  host?: { file: string; v: string; line: number; cjs?: boolean };
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const source = (p: string) => !TEST_PATH.test(p) && !TEST_FILE.test(baseOf(p));

/** The variable a pattern's match names, and the line it is on. */
function hostOf(file: string, text: string, re: RegExp) {
  const m = re.exec(text);
  if (!m) return undefined;
  return { file, v: m[1]!, line: text.slice(0, m.index).split("\n").length };
}

/** A module-level app or router, by the call that makes it. */
const NODE_APP =
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:express\s*\.\s*Router|express|Router)\s*\(\s*\)/m;
const PY_APP = /^([A-Za-z_]\w*)\s*=\s*(?:APIRouter|FastAPI|Flask|Blueprint)\s*\(/m;

/** The stacks the copy holds source of, each with the folder a plant goes in, chosen by seed. */
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
  const spring = pick(springFiles, "spring");
  if (spring) {
    const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(src.read(spring) ?? "")?.[1];
    const config = files
      .filter((f) => /(^|\/)application\.(ya?ml|properties)$/.test(f) && source(f))
      .sort((a, b) => a.length - b.length || (a < b ? -1 : 1))[0];
    out.push({
      stack: "spring",
      dir: dirOf(spring),
      ...(pkg ? { pkg } : {}),
      ...(config ? { config } : {}),
    });
  }

  if (files.some((f) => baseOf(f) === "package.json")) {
    const nodeFiles = files.filter(
      (f) => NODE_SOURCE.test(f) && !NOT_NODE_SOURCE.test(f) && source(f),
    );
    const ext = nodeFiles.some((f) => /\.tsx?$/.test(f)) ? ("ts" as const) : ("js" as const);
    const app = pick(
      nodeFiles.filter((f) => NODE_APP.test(src.read(f) ?? "")),
      "node-app",
    );
    const under = nodeFiles.filter((f) => /(^|\/)src\//.test(f));
    const node = app ?? pick(under.length ? under : nodeFiles, "node");
    if (node) {
      const text = app ? (src.read(app) ?? "") : "";
      const cjs = !/^\s*(import|export)\s/m.test(text) && /\brequire\(/.test(text);
      out.push({
        stack: "node",
        dir: dirOf(node),
        ext,
        ...(app ? { host: { ...hostOf(app, text, NODE_APP)!, ...(cjs ? { cjs } : {}) } } : {}),
      });
    }
  }

  const pyFiles = files.filter(
    (f) => f.endsWith(".py") && source(f) && baseOf(f) !== "__init__.py",
  );
  const pyApp = pick(
    pyFiles.filter((f) => PY_APP.test(src.read(f) ?? "")),
    "python-app",
  );
  const py = pyApp ?? pick(pyFiles, "python");
  if (py)
    out.push({
      stack: "python",
      dir: dirOf(py),
      ...(pyApp ? { host: hostOf(pyApp, src.read(pyApp) ?? "", PY_APP)! } : {}),
    });
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
    h.config ? `  @Value("\${${key}}")` : { text: `  @Value("\${${key}}")`, what: "config" },
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
      { path: free(join(h.dir, `${name}Resource.java`), taken), lines: resource },
      { path: free(join(h.dir, `${name}Events.java`), taken), lines: events },
    ],
  };
  if (h.config)
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
  const v = at?.v ?? "router";
  const kafka = `${camel(n.entry)}Kafka`;
  const producer = `${camel(n.topicOut)}Events`;
  const consumer = `${camel(n.topicIn)}Updates`;
  const url = `${camel(n.config)}Url`;
  const body: Line[] = [
    `const ${kafka} = new Kafka({ brokers: [] });`,
    `const ${producer} = ${kafka}.producer();`,
    `const ${consumer} = ${kafka}.consumer({ groupId: "${n.topicIn.join("-")}" });`,
    { text: `const ${url} = process.env.${env} ?? "";`, what: "config" },
    "",
    { text: `${v}.get("/${n.entry.join("-")}/:id", async (req, res) => {`, what: "entry" },
    {
      text: `  const r = await fetch(\`\${${url}}/${n.call.join("-")}/\${req.params.id}\`);`,
      what: "call",
    },
    {
      text: `  await ${producer}.send({ topic: "${n.topicOut.join(".")}.viewed", messages: [{ value: req.params.id }] });`,
      what: "topic-out",
    },
    "  res.json(await r.json());",
    "});",
    "",
    {
      text: `void ${consumer}.subscribe({ topic: "${n.topicIn.join(".")}.updated" });`,
      what: "topic-in",
    },
  ];
  const kafkaImport = at?.cjs
    ? 'const { Kafka } = require("kafkajs");'
    : 'import { Kafka } from "kafkajs";';
  if (at) return { files: [], append: { path: at.file, lines: ["", kafkaImport, "", ...body] } };
  return {
    files: [
      {
        path: free(join(h.dir, `${n.entry.join("-")}.${h.ext ?? "js"}`), taken),
        lines: [
          'import express from "express";',
          kafkaImport,
          "",
          `export const ${v} = express.Router();`,
          "",
          ...body,
          "",
        ],
      },
    ],
  };
}

function pythonPlanting(h: StackHere, n: Names, taken: Set<string>): Planting {
  const env = `${n.config[0]}_${n.config[1]}_URL`.toUpperCase();
  const at = h.host;
  const v = at?.v ?? "router";
  const url = `${snake(n.config)}_url`;
  const producer = `${snake(n.topicOut)}_events`;
  const body: Line[] = [
    { text: `${url} = os.environ.get("${env}", "")`, what: "config" },
    `${producer} = KafkaProducer()`,
    "",
    "",
    { text: `@${v}.get("/${n.entry.join("-")}/{item_id}")`, what: "entry" },
    `def ${snake(n.entry)}(item_id: str):`,
    {
      text: `    body = httpx.get(f"{${url}}/${n.call.join("-")}/{item_id}").json()`,
      what: "call",
    },
    {
      text: `    ${producer}.send("${n.topicOut.join(".")}.viewed", item_id.encode())`,
      what: "topic-out",
    },
    "    return body",
    "",
    "",
    {
      text: `${snake(n.topicIn)}_updates = KafkaConsumer("${n.topicIn.join(".")}.updated")`,
      what: "topic-in",
    },
  ];
  const imports = ["import os", "", "import httpx"];
  const kafkaImport = "from kafka import KafkaConsumer, KafkaProducer";
  if (at)
    return {
      files: [],
      append: { path: at.file, lines: ["", "", ...imports, kafkaImport, "", ...body] },
    };
  return {
    files: [
      {
        path: free(join(h.dir, `${snake(n.entry)}.py`), taken),
        lines: [
          ...imports,
          "from fastapi import APIRouter",
          kafkaImport,
          "",
          `${v} = APIRouter()`,
          ...body,
          "",
        ],
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
  // Another fact of the kind claiming the same value beside the line would be scored as the
  // removed one; such a line isn't drawn.
  const near = (a: Fact, b: Fact) =>
    a.id !== b.id &&
    a.kind === b.kind &&
    a.cite.file === b.cite.file &&
    Math.abs(a.cite.line - b.cite.line) <= 1 &&
    foldCanary(a.cite.value) === foldCanary(b.cite.value);
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
      !isSecretPath(f.cite.file) &&
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
  const writes: Record<string, string> = {};
  stacks.forEach((h) => {
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
  return { stacks: stacks.map((s) => s.stack), planted, removed, writes };
}

/** A fact's claim in a few words, for the report: its method and path, topic, key or value. */
export function canaryClaimOf(f: Fact): string {
  const x = f as unknown as Record<string, string | undefined>;
  if (f.kind === "entry" || f.kind === "call")
    return [x.method?.toUpperCase(), x.path].filter(Boolean).join(" ") || f.cite.value;
  if (f.kind === "config") return x.key ?? f.cite.value;
  return f.cite.value;
}
