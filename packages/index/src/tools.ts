import { existsSync, readdirSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { RecordId, specsRelOf, stateDirOf, type ToolDefinition } from "@maycombhq/core";
import type { CatalogIndex } from "./catalog-index.js";
import type { GraphNodeRow } from "./select.js";

/**
 * The context tools (ADR 0107 addendum, point 4): read-only tools a step's model may call
 * beside its pack, defined once here and run against the index and the workspace checkout.
 * The model runtime offers them through its provider's tool calls, the VS Code extension
 * through the language model API (each call is `atticus context call`), Claude Code through
 * the MCP server. They never write, and the code they show is read from the base clones under
 * `workspace/` only: a path that leaves a clone, by `..`, an absolute path or a link, is refused.
 */

/** Said to the model when a tool can't do what it was asked; the runtime marks the call an error. */
export class ContextToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export const CONTEXT_TOOL_NAMES = [
  "search",
  "show",
  "walk",
  "show_code",
  "grep",
  "files",
  "outline",
] as const;
export type ContextToolName = (typeof CONTEXT_TOOL_NAMES)[number];

/** The tools that read the code itself, not the index (ADR 0118). */
export const CODE_TOOL_NAMES = ["grep", "files", "outline"] as const;

/** Bounds the tools keep to whatever they are asked. */
export const CONTEXT_TOOL_BOUNDS = {
  searchLimit: 20,
  walkHops: 2,
  walkLimit: 40,
  codeContext: 20,
  codeCites: 3,
  codeFileBytes: 2_000_000,
  /** grep (ADR 0118): hits a call shows at most, and by default. */
  grepLimit: 100,
  grepDefault: 30,
  /** The longest pattern grep takes, and the most of a hit's line it shows. */
  grepPattern: 200,
  grepLineChars: 200,
  /** Files one grep or files call walks at most, and bytes grep reads at most. */
  walkFiles: 20_000,
  grepBytes: 64_000_000,
  filesLimit: 500,
  filesDefault: 200,
  outlineLines: 300,
} as const;

export const CONTEXT_TOOLS: ToolDefinition[] = [
  {
    name: "search",
    description:
      "Search everything Atticus knows by words: catalog records, knowledge items, flows and their steps, changes, answered questions and wiki sections. Names and ids rank first. Each hit gives its kind, id, name and the file it was read from.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The words to look for." },
        kinds: {
          type: "array",
          items: { type: "string" },
          description:
            "Only these kinds, for example System, Flow, ProcessDefinition, WikiSection.",
        },
        limit: { type: "integer", minimum: 1, maximum: CONTEXT_TOOL_BOUNDS.searchLimit },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "show",
    description:
      "Show one record, flow, flow step (flow-id#n), knowledge item, change, answered question or wiki section in full, by its id, with the file it was read from and whether it was verified.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The id, as the pack or a search names it." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "walk",
    description:
      "Walk the links from one id: what it calls, contains, names or is named by, one line each with how the link was made, at most two hops.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        hops: { type: "integer", minimum: 1, maximum: CONTEXT_TOOL_BOUNDS.walkHops },
        kinds: { type: "array", items: { type: "string" }, description: "Only these kinds." },
        limit: { type: "integer", minimum: 1, maximum: CONTEXT_TOOL_BOUNDS.walkLimit },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "show_code",
    description:
      "Show the code a fact cites: a few lines around each file and line a record or flow step cites, read from the workspace checkout. Give the fact's id; or a repo, path and line that a fact cites or that a grep or outline hit of this run returned.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "A record or flow step (flow-id#n) id." },
        repo: { type: "string" },
        path: { type: "string" },
        line: { type: "integer", minimum: 1 },
        context: {
          type: "integer",
          minimum: 0,
          maximum: CONTEXT_TOOL_BOUNDS.codeContext,
          description: "Lines before and after the cited line (default 6).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "grep",
    description:
      "Search the repos' code for the lines that match what you give: literal text, or a regular expression with regex true. Each hit is repo:path:line: the line. Use it to find code the material doesn't show, for example an in-house annotation, a wrapper or where a value is set. A hit is a pointer, not a fact: show_code shows the lines around it. Files .gitignore ignores are skipped.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          maxLength: CONTEXT_TOOL_BOUNDS.grepPattern,
          description: "The text to find, or a regular expression (JavaScript syntax).",
        },
        regex: { type: "boolean", description: "The pattern is a regular expression." },
        ignoreCase: { type: "boolean" },
        repo: { type: "string", description: "Only this repo. Default: every cloned repo." },
        paths: {
          type: "string",
          description:
            "Only paths that match this glob, for example src/**/*.java; a glob with no / matches at any depth.",
        },
        limit: { type: "integer", minimum: 1, maximum: CONTEXT_TOOL_BOUNDS.grepLimit },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "files",
    description:
      "List the repos' files whose paths match a glob (src/**/*.java; a glob with no / matches at any depth), each as repo:path. Files .gitignore ignores are left out.",
    inputSchema: {
      type: "object",
      properties: {
        glob: { type: "string" },
        repo: { type: "string", description: "Only this repo. Default: every cloned repo." },
        limit: { type: "integer", minimum: 1, maximum: CONTEXT_TOOL_BOUNDS.filesLimit },
      },
      required: ["glob"],
      additionalProperties: false,
    },
  },
  {
    name: "outline",
    description:
      "Outline one file: its declarations (classes, functions, methods and the like, nested, each with the annotations or decorators written on it) from its syntax tree, each as line: what is declared there; for Markdown its headings, for YAML or properties its keys.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        path: { type: "string", description: "The file's path in the repo." },
      },
      required: ["repo", "path"],
      additionalProperties: false,
    },
  },
];

/** One declaration of a file, as a reader gives it (packages/extractors `declarationOutline`). */
export interface OutlineItem {
  line: number;
  depth: number;
  kind: string;
  name: string;
  marks: { line: number; text: string }[];
}

/** Reads a file's declarations; undefined when it has no reader for that kind of file. */
export type Outliner = (path: string, text: string) => Promise<OutlineItem[] | undefined>;

export interface ContextToolOptions {
  /** The base clone of a repo, where its code is read. Default: workspace/<repo>. */
  codeDir?: (repo: string) => string | undefined;
  /** The repos grep and files search when none is named. Default: every clone under workspace/. */
  repos?: () => string[];
  /** A file's declarations from its syntax tree (the CLI passes the extractors' reader). */
  outline?: Outliner;
  /**
   * The lines grep and outline returned in this run, as `repo\0path\0line`: grep and outline
   * add to it, and show_code may show what it holds (ADR 0118).
   */
  pointers?: Set<string>;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const int = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.min(max, Math.max(min, Math.floor(v)))
    : fallback;
const strs = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : undefined;

/** The base clone of a repo under the metarepo's workspace/ (or .atticus/workspace/). */
export function defaultCodeDir(root: string, repo: string): string | undefined {
  if (!RecordId.safeParse(repo).success) return undefined;
  for (const base of [join(root, "workspace"), join(stateDirOf(root), "workspace")]) {
    const d = join(base, repo);
    if (existsSync(d)) return d;
  }
  return undefined;
}

/** Run one context tool. The text is data for the model; a refusal throws ContextToolError. */
export async function runContextTool(
  ix: CatalogIndex,
  root: string,
  name: string,
  input: Record<string, unknown>,
  o: ContextToolOptions = {},
): Promise<string> {
  switch (name) {
    case "search":
      return searchTool(ix, input);
    case "show":
      return showTool(ix, input);
    case "walk":
      return walkTool(ix, input);
    case "show_code":
      return showCodeTool(ix, root, input, o);
    case "grep":
    case "files":
    case "outline":
      return runCodeTool(root, name, input, o);
    default:
      throw new ContextToolError(
        `There is no tool ${name}. The tools: ${CONTEXT_TOOL_NAMES.join(", ")}.`,
      );
  }
}

function searchTool(ix: CatalogIndex, input: Record<string, unknown>): string {
  const text = str(input.text);
  if (!text) throw new ContextToolError("search needs text: the words to look for.");
  const kinds = strs(input.kinds);
  const limit = int(input.limit, 1, CONTEXT_TOOL_BOUNDS.searchLimit, 10);
  const hits = ix.search(text, { limit, ...(kinds?.length ? { kinds } : {}) });
  if (!hits.length) return `Nothing in the index matches "${text}".`;
  return [
    `${hits.length} hit${hits.length === 1 ? "" : "s"} for "${text}", best first:`,
    ...hits.map((h) => `- ${h.kind} ${h.id}: ${h.name} [${h.file}]`),
    "Show one in full with show and its id.",
  ].join("\n");
}

function nodesOf(ix: CatalogIndex, id: string): GraphNodeRow[] {
  const nodes = ix.nodes(id);
  if (!nodes.length)
    throw new ContextToolError(
      `There is nothing called ${id} in the index. Search for it by words with search.`,
    );
  return nodes;
}

function showTool(ix: CatalogIndex, input: Record<string, unknown>): string {
  const id = str(input.id);
  if (!id) throw new ContextToolError("show needs an id.");
  const nodes = nodesOf(ix, id).slice(0, 3);
  return nodes
    .map((n) => {
      const state = n.review
        ? `a person ${n.review} it`
        : n.verified
          ? "verified"
          : "not verified by a person or a check";
      const links = ix.links(n.key).length;
      return [
        `${n.kind} ${n.id} (${state}), read from ${n.file}:`,
        n.detail.trimEnd(),
        ...(links ? [`It has ${links} link${links === 1 ? "" : "s"}; walk shows them.`] : []),
      ].join("\n");
    })
    .join("\n\n");
}

function walkTool(ix: CatalogIndex, input: Record<string, unknown>): string {
  const id = str(input.id);
  if (!id) throw new ContextToolError("walk needs an id.");
  const hops = int(input.hops, 1, CONTEXT_TOOL_BOUNDS.walkHops, 1);
  const limit = int(input.limit, 1, CONTEXT_TOOL_BOUNDS.walkLimit, 25);
  const kinds = strs(input.kinds);
  const starts = nodesOf(ix, id);
  const seen = new Set(starts.map((n) => n.key));
  const lines: string[] = [];
  let more = 0;
  let frontier = starts.map((n) => ({ key: n.key, id: n.id }));
  for (let h = 1; h <= hops && frontier.length; h++) {
    const next: { key: string; id: string }[] = [];
    for (const f of frontier)
      for (const l of ix.links(f.key)) {
        if (seen.has(l.key)) continue;
        seen.add(l.key);
        next.push({ key: l.key, id: l.id });
        if (kinds?.length && !kinds.includes(l.kind)) continue;
        if (lines.length >= limit) {
          more++;
          continue;
        }
        const what = l.dir === "out" ? `${f.id} ${l.type} ${l.id}` : `${l.id} ${l.type} ${f.id}`;
        lines.push(`- hop ${h}: ${what} (${l.how}); ${l.kind} ${l.id}`);
      }
    frontier = next.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  if (!lines.length) return `${id} has no links${kinds?.length ? ` to ${kinds.join(", ")}` : ""}.`;
  return [
    `Links from ${id}, ${hops} hop${hops === 1 ? "" : "s"}:`,
    ...lines,
    ...(more ? [`… and ${more} more; ask for fewer kinds or one hop.`] : []),
  ].join("\n");
}

interface Cite {
  repo: string;
  path: string;
  line: number;
  what: string;
  /** How the header names the line: "cites" (a fact) or "at" (a search hit). */
  verb?: string;
}

/** The files and lines a record or flow step cites, code only, in the order the record has them. */
function citesOf(ix: CatalogIndex, root: string, id: string): Cite[] {
  const out: Cite[] = [];
  const rows = ix.db
    .prepare(
      "SELECT kind, repo, path, line FROM evidence WHERE id = ? AND repo IS NOT NULL AND path IS NOT NULL AND line IS NOT NULL ORDER BY rowid",
    )
    .all(id) as { kind: string; repo: string; path: string; line: number }[];
  for (const r of rows)
    out.push({ repo: r.repo, path: r.path, line: r.line, what: `${r.kind} ${id}` });
  if (out.length) return out;
  // A flow step (flow#n) or a flow: its evidence, the spec's own repo when it names none.
  const m = /^(.+)#(\d+)$/.exec(id);
  const flowId = m ? m[1]! : id;
  for (const n of ix.nodes(flowId).filter((x) => x.kind === "Flow")) {
    const f = n.json as {
      trigger?: { evidence?: { repo?: string; path?: string; line?: number }[] };
      steps?: { evidence?: { repo?: string; path?: string; line?: number }[] }[];
    };
    const specRel = specsRelOf(root);
    const specRepo = n.file.startsWith(`${specRel}/`)
      ? n.file.slice(specRel.length + 1).split("/")[0]
      : undefined;
    const parts = m
      ? [{ what: `step ${id}`, evidence: f.steps?.[Number(m[2]) - 1]?.evidence ?? [] }]
      : [
          { what: `trigger of ${flowId}`, evidence: f.trigger?.evidence ?? [] },
          ...(f.steps ?? []).map((s, i) => ({
            what: `step ${flowId}#${i + 1}`,
            evidence: s.evidence ?? [],
          })),
        ];
    for (const p of parts)
      for (const e of p.evidence) {
        const repo = e.repo ?? specRepo;
        if (repo && e.path && e.line) out.push({ repo, path: e.path, line: e.line, what: p.what });
      }
  }
  return out;
}

/** Whether repo:path:line is cited by some record or flow (show_code shows only what a fact cites). */
function isCited(ix: CatalogIndex, root: string, c: { repo: string; path: string; line: number }) {
  const hit = ix.db
    .prepare("SELECT 1 FROM evidence WHERE repo = ? AND path = ? AND line = ? LIMIT 1")
    .get(c.repo, c.path, c.line);
  if (hit) return true;
  const flows = ix.db.prepare("SELECT id FROM nodes WHERE kind = 'Flow'").all() as { id: string }[];
  return flows.some((f) =>
    citesOf(ix, root, f.id).some(
      (x) => x.repo === c.repo && x.path === c.path && x.line === c.line,
    ),
  );
}

/**
 * A file inside a repo's base clone, or a refusal: no absolute path, nothing that leaves the
 * clone by `..` or by a link (both the clone and the file are resolved first).
 */
async function insideClone(base: string, path: string): Promise<string> {
  if (!path || path.includes("\0") || isAbsolute(path) || /^[a-zA-Z]:/.test(path))
    throw new ContextToolError(`${path} isn't a path inside the repo.`);
  const full = resolve(base, ...path.split(/[\\/]+/));
  const rel = relative(base, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new ContextToolError(
      `${path} leaves the repo's checkout; Atticus reads nothing outside it.`,
    );
  let real: string;
  let realBase: string;
  try {
    [real, realBase] = await Promise.all([realpath(full), realpath(base)]);
  } catch {
    throw new ContextToolError(`${path} isn't in the workspace checkout (is the repo cloned?).`);
  }
  const r = relative(realBase, real);
  if (!r || r.startsWith("..") || isAbsolute(r) || r.split(sep).includes(".."))
    throw new ContextToolError(
      `${path} leads outside the repo's checkout; Atticus reads nothing outside it.`,
    );
  return real;
}

async function excerpt(
  root: string,
  c: Cite,
  around: number,
  o: ContextToolOptions,
): Promise<string> {
  const base = (o.codeDir ?? ((r) => defaultCodeDir(root, r)))(c.repo);
  if (!base)
    return `${c.what} ${c.verb ?? "cites"} ${c.repo}/${c.path}:${c.line}, but ${c.repo} isn't cloned in the workspace.`;
  let file: string;
  try {
    file = await insideClone(base, c.path);
  } catch (e) {
    return `${c.what} ${c.verb ?? "cites"} ${c.repo}/${c.path}:${c.line}: ${(e as Error).message}`;
  }
  const size = (await stat(file)).size;
  if (size > CONTEXT_TOOL_BOUNDS.codeFileBytes)
    return `${c.what} ${c.verb ?? "cites"} ${c.repo}/${c.path}:${c.line}, a file too big to show (${size} bytes).`;
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  if (c.line > lines.length)
    return `${c.what} ${c.verb ?? "cites"} ${c.repo}/${c.path}:${c.line}, but the file has ${lines.length} lines now: the cite is stale.`;
  const from = Math.max(1, c.line - around);
  const to = Math.min(lines.length, c.line + around);
  const width = String(to).length;
  return [
    `${c.what} ${c.verb ?? "cites"} ${c.repo}/${c.path}:${c.line}:`,
    ...lines
      .slice(from - 1, to)
      .map((l, i) => `${from + i === c.line ? ">" : " "}${String(from + i).padStart(width)}  ${l}`),
  ].join("\n");
}

async function showCodeTool(
  ix: CatalogIndex | undefined,
  root: string,
  input: Record<string, unknown>,
  o: ContextToolOptions,
): Promise<string> {
  const around = int(input.context, 0, CONTEXT_TOOL_BOUNDS.codeContext, 6);
  const id = str(input.id);
  let cites: Cite[];
  if (id) {
    if (!ix) throw new ContextToolError("show_code by id needs the index.");
    nodesOf(ix, id.replace(/#\d+$/, ""));
    cites = citesOf(ix, root, id);
    if (!cites.length)
      return `${id} cites no line of code (it may cite a wiki page or a document: show it).`;
  } else {
    const repo = str(input.repo);
    const path = str(input.path);
    const line = typeof input.line === "number" ? Math.floor(input.line) : undefined;
    if (!repo || !path || !line || line < 1)
      throw new ContextToolError("show_code needs an id, or a repo, path and line.");
    if (!RecordId.safeParse(repo).success) throw new ContextToolError(`${repo} isn't a repo id.`);
    // ADR 0118: a line a grep or outline hit of this run returned is shown too, as a pointer.
    if (o.pointers?.has(pointerKey(repo, path, line)))
      cites = [{ repo, path: posixPath(path), line, what: "A search hit", verb: "at" }];
    else {
      if (!ix || !isCited(ix, root, { repo, path, line }))
        throw new ContextToolError(
          `No fact cites ${repo}/${path}:${line}, and no grep or outline hit of this run returned it; show_code shows only those. Give a record's id, or find the line with grep first.`,
        );
      cites = [{ repo, path, line, what: "A fact" }];
    }
  }
  const shown = cites.slice(0, CONTEXT_TOOL_BOUNDS.codeCites);
  const parts = [];
  for (const c of shown) parts.push(await excerpt(root, c, around, o));
  if (cites.length > shown.length)
    parts.push(
      `… and ${cites.length - shown.length} more cites; ask for one by repo, path and line.`,
    );
  return parts.join("\n\n");
}

/**
 * The context tools of a metarepo as a tool box: each call opens the index, runs, closes. The
 * code tools (grep, files, outline) and show_code at a hit they returned need no index. The box
 * keeps the run's hits; `calls`, a run's earlier calls made elsewhere, gives it theirs.
 */
export function contextToolBox(
  root: string,
  open: () => Promise<CatalogIndex>,
  o: ContextToolOptions & { calls?: { name: string; output: string }[] } = {},
): {
  definitions: ToolDefinition[];
  call(name: string, input: Record<string, unknown>): Promise<string>;
} {
  const { calls, ...rest } = o;
  const pointers = o.pointers ?? new Set<string>();
  for (const c of calls ?? []) for (const k of pointersIn(c.name, c.output)) pointers.add(k);
  const opts: ContextToolOptions = { ...rest, pointers };
  return {
    definitions: CONTEXT_TOOLS,
    async call(name, input) {
      if ((CODE_TOOL_NAMES as readonly string[]).includes(name))
        return runCodeTool(root, name, input, opts);
      const line = typeof input.line === "number" ? Math.floor(input.line) : undefined;
      if (
        name === "show_code" &&
        !str(input.id) &&
        str(input.repo) &&
        str(input.path) &&
        line &&
        pointers.has(pointerKey(str(input.repo)!, str(input.path)!, line))
      )
        return showCodeTool(undefined, root, input, opts);
      const ix = await open();
      try {
        return await runContextTool(ix, root, name, input, opts);
      } finally {
        ix.close();
      }
    },
  };
}

// ------------------------------------------------------------------ the code tools (ADR 0118)

/** A path as the tools write it: forward slashes, no leading ./ */
const posixPath = (p: string) => p.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
const pointerKey = (repo: string, path: string, line: number) =>
  `${repo}\u0000${posixPath(path)}\u0000${line}`;

const HIT = /^([a-z0-9][a-z0-9._-]*):(.+?):(\d+): /;
const OUTLINE_HEAD = /^Outline of ([a-z0-9][a-z0-9._-]*):(.+)$/;
const OUTLINE_LINE = /^\s*(\d+): /;

/** The lines a grep or outline call's text returned, as pointers (the tools' own format). */
export function pointersIn(name: string, output: string): string[] {
  const out: string[] = [];
  if (name === "grep")
    for (const l of output.split(/\r?\n/)) {
      const m = HIT.exec(l);
      if (m) out.push(pointerKey(m[1]!, m[2]!, Number(m[3])));
    }
  if (name === "outline") {
    let at: { repo: string; path: string } | undefined;
    for (const l of output.split(/\r?\n/)) {
      const h = OUTLINE_HEAD.exec(l);
      if (h) {
        at = { repo: h[1]!, path: h[2]! };
        continue;
      }
      const m = at && OUTLINE_LINE.exec(l);
      if (at && m) out.push(pointerKey(at.repo, at.path, Number(m[1])));
    }
  }
  return out;
}

/** Every clone under workspace/ (and .atticus/workspace/), by repo id. */
export function workspaceRepos(root: string): string[] {
  const out = new Set<string>();
  for (const base of [join(root, "workspace"), join(stateDirOf(root), "workspace")]) {
    let names: string[];
    try {
      names = readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const n of names) if (RecordId.safeParse(n).success) out.add(n);
  }
  return [...out].sort();
}

/** The clone of one repo the model named, or a refusal. */
function cloneOf(root: string, repo: string, o: ContextToolOptions): string {
  if (!RecordId.safeParse(repo).success) throw new ContextToolError(`${repo} isn't a repo id.`);
  const dir = (o.codeDir ?? ((r) => defaultCodeDir(root, r)))(repo);
  if (!dir) throw new ContextToolError(`${repo} isn't cloned in the workspace.`);
  return dir;
}

/** The repos a call reads: the one named, or every clone. */
function reposOf(root: string, input: Record<string, unknown>, o: ContextToolOptions) {
  const named = str(input.repo);
  if (named) return [{ repo: named, dir: cloneOf(root, named, o) }];
  const ids = o.repos ? o.repos() : workspaceRepos(root);
  const out: { repo: string; dir: string }[] = [];
  for (const r of ids) {
    const dir = (o.codeDir ?? ((x) => defaultCodeDir(root, x)))(r);
    if (dir && RecordId.safeParse(r).success) out.push({ repo: r, dir });
  }
  if (!out.length) throw new ContextToolError("No repo is cloned in the workspace.");
  return out;
}

/**
 * A glob as a regular expression over a repo-relative path: `**` any folders, `*` and `?` within
 * one name, `[...]` a class, `{a,b}` either. A glob with no / matches a name at any depth.
 */
function globRe(glob: string, anyDepth = !glob.replace(/\/$/, "").includes("/")): RegExp {
  let g = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (g.startsWith("/")) {
    g = g.slice(1);
    anyDepth = false;
  }
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!;
    if (ch === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (ch === "[") {
      const end = g.indexOf("]", i + 2);
      if (end < 0) re += "\\[";
      else {
        const body = g
          .slice(i + 1, end)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\");
        re += `[${body}]`;
        i = end;
      }
    } else if (ch === "{") {
      const end = g.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${g
          .slice(i + 1, end)
          .split(",")
          .map((p) => globRe(p, false).source.slice(1, -1))
          .join("|")})`;
        i = end;
      }
    } else re += ch.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${anyDepth ? "(?:.*/)?" : ""}${re}$`);
}

interface IgnoreRule {
  /** The folder of the .gitignore, repo-relative ("" for the root). */
  base: string;
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

/** The rules of one .gitignore file (git's syntax: #, !, a trailing /, a leading or inner /). */
function ignoreRules(text: string, base: string): IgnoreRule[] {
  const out: IgnoreRule[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    if (!line) continue;
    const anchored = line.includes("/");
    try {
      out.push({ base, re: globRe(line.replace(/^\//, ""), !anchored), negate, dirOnly });
    } catch {
      // A line git would read some other way is left out rather than guessed at.
    }
  }
  return out;
}

/** Whether git would ignore a path: the last rule that matches decides. */
function ignored(rules: IgnoreRule[], path: string, isDir: boolean): boolean {
  let out = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.base && !path.startsWith(`${r.base}/`)) continue;
    const rel = r.base ? path.slice(r.base.length + 1) : path;
    if (r.re.test(rel)) out = !r.negate;
  }
  return out;
}

/** The rules that apply to a path in a clone: every .gitignore from the root down to its folder. */
async function rulesFor(dir: string, path: string): Promise<IgnoreRule[]> {
  const parts = path.split("/").slice(0, -1);
  const rules: IgnoreRule[] = [];
  for (let i = 0; i <= parts.length; i++) {
    const base = parts.slice(0, i).join("/");
    const text = await readFile(join(dir, ...parts.slice(0, i), ".gitignore"), "utf8").catch(
      () => undefined,
    );
    if (text) rules.push(...ignoreRules(text, base));
  }
  return rules;
}

/** Whether git would ignore a file in a clone: the file, or any folder it is in. */
async function isIgnored(dir: string, path: string): Promise<boolean> {
  const rules = await rulesFor(dir, path);
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++)
    if (ignored(rules, parts.slice(0, i).join("/"), true)) return true;
  return ignored(rules, path, false);
}

/**
 * A clone's files, sorted, repo-relative: never .git/, a link, or what a .gitignore ignores (an
 * ignored folder isn't walked). Stops after `max` files and says so.
 */
async function walkClone(
  dir: string,
  max: number,
  visit: (path: string) => Promise<boolean | void>,
): Promise<{ files: number; cut: boolean }> {
  let files = 0;
  let cut = false;
  const go = async (rel: string, inherited: IgnoreRule[]): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(rel ? join(dir, ...rel.split("/")) : dir, { withFileTypes: true });
    } catch {
      return true;
    }
    const here = entries.find((e) => e.name === ".gitignore" && e.isFile());
    const rules = here
      ? [
          ...inherited,
          ...ignoreRules(await readFile(join(dir, ...rel.split("/"), ".gitignore"), "utf8"), rel),
        ]
      : inherited;
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.isSymbolicLink() || e.name === ".git") continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (ignored(rules, p, true)) continue;
        if (!(await go(p, rules))) return false;
      } else if (e.isFile()) {
        if (ignored(rules, p, false)) continue;
        if (files >= max) {
          cut = true;
          return false;
        }
        files++;
        if ((await visit(p)) === false) return false;
      }
    }
    return true;
  };
  await go("", []);
  return { files, cut };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function runCodeTool(
  root: string,
  name: string,
  input: Record<string, unknown>,
  o: ContextToolOptions,
): Promise<string> {
  if (name === "grep") return grepTool(root, input, o);
  if (name === "files") return filesTool(root, input, o);
  return outlineTool(root, input, o);
}

async function grepTool(
  root: string,
  input: Record<string, unknown>,
  o: ContextToolOptions,
): Promise<string> {
  const B = CONTEXT_TOOL_BOUNDS;
  const pattern = typeof input.pattern === "string" && input.pattern ? input.pattern : undefined;
  if (!pattern) throw new ContextToolError("grep needs a pattern: the text or expression to find.");
  if (pattern.length > B.grepPattern)
    throw new ContextToolError(`A grep pattern is at most ${B.grepPattern} characters.`);
  const ignoreCase = input.ignoreCase === true;
  let test: (line: string) => boolean;
  if (input.regex === true) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, ignoreCase ? "i" : "");
    } catch (e) {
      throw new ContextToolError(`${pattern} isn't a regular expression: ${(e as Error).message}.`);
    }
    test = (l) => re.test(l);
  } else {
    const p = ignoreCase ? pattern.toLowerCase() : pattern;
    test = ignoreCase ? (l) => l.toLowerCase().includes(p) : (l) => l.includes(p);
  }
  const limit = int(input.limit, 1, B.grepLimit, B.grepDefault);
  const paths = str(input.paths);
  const only = paths ? globRe(paths) : undefined;
  const repos = reposOf(root, input, o);
  const hits: string[] = [];
  let more = false;
  let read = 0;
  let bytes = 0;
  let cut = false;
  for (const { repo, dir } of repos) {
    const walked = await walkClone(dir, B.walkFiles - read, async (p) => {
      if (only && !only.test(p)) return;
      const buf = await readFile(join(dir, ...p.split("/"))).catch(() => undefined);
      if (!buf || buf.length > B.codeFileBytes) return;
      if (buf.subarray(0, 8000).includes(0)) return;
      bytes += buf.length;
      if (bytes > B.grepBytes) {
        cut = true;
        return false;
      }
      read++;
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        // A long line is searched in its first 2,000 characters only, so no pattern runs away.
        const line = lines[i]!.slice(0, 2000);
        if (!test(line)) continue;
        if (hits.length >= limit) {
          more = true;
          return false;
        }
        const text = line.trimEnd();
        const shown = text.length > B.grepLineChars ? `${text.slice(0, B.grepLineChars)} …` : text;
        hits.push(`${repo}:${p}:${i + 1}: ${shown}`);
        o.pointers?.add(pointerKey(repo, p, i + 1));
      }
    });
    if (walked.cut) cut = true;
    if (more || cut) break;
  }
  const where = repos.length === 1 ? ` in ${repos[0]!.repo}` : "";
  const scope = paths ? `, paths ${paths}` : "";
  if (!hits.length)
    return `No line matches "${pattern}"${where}${scope} (${plural(read, "file")} read${cut ? "; the search stopped at its cap" : ""}).`;
  return [
    `${plural(hits.length, "hit")} for "${pattern}"${where}${scope} (${plural(read, "file")} read):`,
    ...hits,
    ...(more ? [`… more hits past the ${limit} shown; narrow the pattern or the paths.`] : []),
    ...(cut
      ? [`… the search stopped at its cap of files or bytes; name a repo or narrower paths.`]
      : []),
    "Show the lines around a hit with show_code (repo, path, line). A hit is a pointer, not a fact: a fact cites its file and line, and Atticus checks the value there.",
  ].join("\n");
}

async function filesTool(
  root: string,
  input: Record<string, unknown>,
  o: ContextToolOptions,
): Promise<string> {
  const B = CONTEXT_TOOL_BOUNDS;
  const glob = str(input.glob);
  if (!glob) throw new ContextToolError("files needs a glob, for example src/**/*.java.");
  const limit = int(input.limit, 1, B.filesLimit, B.filesDefault);
  const re = globRe(glob);
  const repos = reposOf(root, input, o);
  const out: string[] = [];
  let more = false;
  let seen = 0;
  for (const { repo, dir } of repos) {
    const walked = await walkClone(dir, B.walkFiles - seen, async (p) => {
      seen++;
      if (!re.test(p)) return;
      if (out.length >= limit) {
        more = true;
        return false;
      }
      out.push(`${repo}:${p}`);
    });
    if (more || walked.cut) {
      more = true;
      break;
    }
  }
  const where = repos.length === 1 ? ` in ${repos[0]!.repo}` : "";
  if (!out.length) return `No file matches ${glob}${where}.`;
  return [
    `${plural(out.length, "file")} match ${glob}${where}:`,
    ...out,
    ...(more ? [`… more past the ${limit} shown; give a narrower glob.`] : []),
  ].join("\n");
}

/** Headings of a Markdown or AsciiDoc file; keys of YAML or properties: the file's own outline. */
function textOutline(path: string, text: string): { how: string; lines: string[] } | undefined {
  const lines = text.split(/\r?\n/);
  const pick = (re: RegExp, how: string) => ({
    how,
    lines: lines.flatMap((l, i) => (re.test(l) ? [`${i + 1}: ${l.trimEnd()}`] : [])),
  });
  if (/\.(md|markdown|mdx)$/i.test(path)) {
    let fence = false;
    return {
      how: "its headings",
      lines: lines.flatMap((l, i) => {
        if (/^\s*(```|~~~)/.test(l)) fence = !fence;
        return !fence && /^#{1,6}\s/.test(l) ? [`${i + 1}: ${l.trimEnd()}`] : [];
      }),
    };
  }
  if (/\.(adoc|asciidoc)$/i.test(path)) return pick(/^={1,6}\s/, "its headings");
  if (/\.ya?ml$/i.test(path)) return pick(/^[^\s#-][^:]*:/, "its top-level keys");
  if (/\.properties$/i.test(path)) {
    const o = pick(/^\s*[^#!\s][^=:]*[=:]/, "its keys");
    return {
      how: o.how,
      lines: o.lines.map((l) => l.replace(/^(\d+: )\s*([^=:]+?)\s*[=:].*$/, "$1$2")),
    };
  }
  return undefined;
}

async function outlineTool(
  root: string,
  input: Record<string, unknown>,
  o: ContextToolOptions,
): Promise<string> {
  const repo = str(input.repo);
  const path = str(input.path);
  if (!repo || !path) throw new ContextToolError("outline needs a repo and the file's path in it.");
  const dir = cloneOf(root, repo, o);
  const file = await insideClone(dir, path);
  const rel = posixPath(
    relative(await realpath(dir), file)
      .split(sep)
      .join("/"),
  );
  if (await isIgnored(dir, rel))
    throw new ContextToolError(`${path} is a file the repo's .gitignore ignores; it isn't read.`);
  const size = (await stat(file)).size;
  if (size > CONTEXT_TOOL_BOUNDS.codeFileBytes)
    throw new ContextToolError(`${path} is too big to outline (${size} bytes).`);
  const text = await readFile(file, "utf8");
  const head = `Outline of ${repo}:${rel}`;
  let how: string;
  let lines: string[];
  const decls = o.outline ? await o.outline(rel, text) : undefined;
  if (decls) {
    how = "From its syntax tree: each line is the line number, then what is declared there.";
    lines = decls.flatMap((d) => {
      const pad = "  ".repeat(d.depth);
      return [
        ...d.marks.map((m) => `${m.line}: ${pad}${m.text}`),
        `${d.line}: ${pad}${d.kind} ${d.name}`,
      ];
    });
  } else {
    const t = textOutline(rel, text);
    if (!t)
      return `${repo}:${rel} has no outline: no reader for this kind of file. grep it, or show_code a line a hit returned.`;
    how = `From ${t.how}: each line is the line number, then the line.`;
    lines = t.lines;
  }
  if (!lines.length) return `${head}\n${how}\n(nothing)`;
  const shown = lines.slice(0, CONTEXT_TOOL_BOUNDS.outlineLines);
  for (const l of shown) {
    const m = OUTLINE_LINE.exec(l);
    if (m) o.pointers?.add(pointerKey(repo, rel, Number(m[1])));
  }
  return [
    head,
    how,
    ...shown,
    ...(lines.length > shown.length
      ? [`… and ${lines.length - shown.length} more lines; grep the file for what you need.`]
      : []),
  ].join("\n");
}
