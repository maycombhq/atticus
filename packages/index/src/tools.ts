import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
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

export const CONTEXT_TOOL_NAMES = ["search", "show", "walk", "show_code"] as const;
export type ContextToolName = (typeof CONTEXT_TOOL_NAMES)[number];

/** Bounds the tools keep to whatever they are asked. */
export const CONTEXT_TOOL_BOUNDS = {
  searchLimit: 20,
  walkHops: 2,
  walkLimit: 40,
  codeContext: 20,
  codeCites: 3,
  codeFileBytes: 2_000_000,
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
      "Show the code a fact cites: a few lines around each file and line a record or flow step cites, read from the workspace checkout. Give the fact's id; or a repo, path and line that a fact cites.",
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
];

export interface ContextToolOptions {
  /** The base clone of a repo, where its code is read. Default: workspace/<repo>. */
  codeDir?: (repo: string) => string | undefined;
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
    return `${c.what} cites ${c.repo}/${c.path}:${c.line}, but ${c.repo} isn't cloned in the workspace.`;
  let file: string;
  try {
    file = await insideClone(base, c.path);
  } catch (e) {
    return `${c.what} cites ${c.repo}/${c.path}:${c.line}: ${(e as Error).message}`;
  }
  const size = (await stat(file)).size;
  if (size > CONTEXT_TOOL_BOUNDS.codeFileBytes)
    return `${c.what} cites ${c.repo}/${c.path}:${c.line}, a file too big to show (${size} bytes).`;
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  if (c.line > lines.length)
    return `${c.what} cites ${c.repo}/${c.path}:${c.line}, but the file has ${lines.length} lines now: the cite is stale.`;
  const from = Math.max(1, c.line - around);
  const to = Math.min(lines.length, c.line + around);
  const width = String(to).length;
  return [
    `${c.what} cites ${c.repo}/${c.path}:${c.line}:`,
    ...lines
      .slice(from - 1, to)
      .map((l, i) => `${from + i === c.line ? ">" : " "}${String(from + i).padStart(width)}  ${l}`),
  ].join("\n");
}

async function showCodeTool(
  ix: CatalogIndex,
  root: string,
  input: Record<string, unknown>,
  o: ContextToolOptions,
): Promise<string> {
  const around = int(input.context, 0, CONTEXT_TOOL_BOUNDS.codeContext, 6);
  const id = str(input.id);
  let cites: Cite[];
  if (id) {
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
    if (!isCited(ix, root, { repo, path, line }))
      throw new ContextToolError(
        `No fact cites ${repo}/${path}:${line}; show_code shows only code a fact cites. Give a record's id instead.`,
      );
    cites = [{ repo, path, line, what: "A fact" }];
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

/** The context tools of a metarepo as a tool box: each call opens the index, runs, closes. */
export function contextToolBox(
  root: string,
  open: () => Promise<CatalogIndex>,
  o: ContextToolOptions = {},
): {
  definitions: ToolDefinition[];
  call(name: string, input: Record<string, unknown>): Promise<string>;
} {
  return {
    definitions: CONTEXT_TOOLS,
    async call(name, input) {
      const ix = await open();
      try {
        return await runContextTool(ix, root, name, input, o);
      } finally {
        ix.close();
      }
    },
  };
}
