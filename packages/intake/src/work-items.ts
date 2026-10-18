import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";

/**
 * Exported work items: Azure DevOps (and Jira-like) exports dropped into inputs/ (ADR 0032).
 * When the work tracker can't be reached, or its adapter is manual, its exports are what
 * Atticus reads to suggest links between features and work items. Read-only, deterministic,
 * files only. Three shapes are read: the ADO REST shape (`value[].fields["System.Title"]`),
 * a flat list (`id`, `type` or `Work Item Type`, `title`), and a CSV query export. An item
 * may carry `pullRequests: [{ id, repo, paths }]` (Atticus's own extension of an export);
 * pull-request artifact links in the REST shape give the repo.
 */

export const WORK_ITEM_READER = "work-items@0.1.0";

export type ExportedWorkItemType = "epic" | "feature" | "story" | "task" | "bug";

export interface ExportedPullRequest {
  id?: string;
  repo?: string;
  paths: string[];
}

export interface ExportedWorkItem {
  system: "ado" | "jira";
  id: string;
  type: ExportedWorkItemType;
  title: string;
  state?: string;
  tags: string[];
  parent?: string;
  description?: string;
  url?: string;
  pullRequests: ExportedPullRequest[];
  /** Where the item is: the metarepo-relative file and the line of its id. */
  source: { path: string; line?: number };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const text = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (isObj(v)) return text(v.displayName ?? v.name ?? v.id);
  const s = String(v).trim();
  return s.length ? s : undefined;
};

function typeOf(t: string): ExportedWorkItemType {
  const k = t.toLowerCase();
  if (k.includes("epic")) return "epic";
  if (k.includes("feature")) return "feature";
  if (k.includes("story") || k.includes("backlog item") || k.includes("requirement"))
    return "story";
  if (k.includes("bug") || k.includes("defect")) return "bug";
  return "task";
}

const tagsOf = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map((t) => String(t).trim()).filter(Boolean)
    : typeof v === "string"
      ? v
          .split(/[;,]/)
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

const stripHtml = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

/** Case- and space-insensitive field lookup: "Work Item Type" = workItemType = System.WorkItemType. */
function field(o: Record<string, unknown>, ...names: string[]): unknown {
  const norm = (k: string) =>
    k
      .toLowerCase()
      .replace(/^system\./, "")
      .replace(/[^a-z0-9]/g, "");
  const want = names.map(norm);
  for (const [k, v] of Object.entries(o)) if (want.includes(norm(k))) return v;
  return undefined;
}

function pullRequestsOf(o: Record<string, unknown>): ExportedPullRequest[] {
  const out: ExportedPullRequest[] = [];
  const add = (pr: ExportedPullRequest) => {
    const same = out.find((x) => (pr.id && x.id === pr.id) || (!pr.id && x.repo === pr.repo));
    if (same) {
      same.repo ??= pr.repo;
      same.paths = [...new Set([...same.paths, ...pr.paths])];
    } else out.push(pr);
  };
  for (const p of Array.isArray(o.pullRequests) ? o.pullRequests : []) {
    if (!isObj(p)) continue;
    const id = text(p.id);
    const repo = text(p.repo ?? p.repository);
    add({
      ...(id ? { id } : {}),
      ...(repo ? { repo } : {}),
      paths: Array.isArray(p.paths) ? p.paths.map(String) : [],
    });
  }
  for (const r of Array.isArray(o.relations) ? o.relations : []) {
    if (!isObj(r) || r.rel !== "ArtifactLink" || typeof r.url !== "string") continue;
    const m = /^vstfs:\/\/\/Git\/PullRequestId\/(.+)$/i.exec(r.url);
    if (!m) continue;
    const parts = decodeURIComponent(m[1]!).split("/");
    if (parts.length < 3) continue;
    add({ id: parts[2]!, repo: parts[1]!, paths: [] });
  }
  return out;
}

function parentOf(o: Record<string, unknown>, fields: Record<string, unknown>): string | undefined {
  const direct = text(field(fields, "Parent") ?? field(o, "parent"));
  if (direct) return direct;
  for (const r of Array.isArray(o.relations) ? o.relations : []) {
    if (!isObj(r) || r.rel !== "System.LinkTypes.Hierarchy-Reverse" || typeof r.url !== "string")
      continue;
    const m = /\/(\d+)\/?$/.exec(r.url);
    if (m) return m[1];
  }
  return undefined;
}

function itemOf(
  o: Record<string, unknown>,
  path: string,
  lineOf: (id: string) => number | undefined,
): ExportedWorkItem | undefined {
  const fields = isObj(o.fields) ? o.fields : o;
  const id = text(o.id ?? field(o, "ID", "key", "number"));
  const title = text(field(fields, "Title", "summary"));
  const type = text(field(fields, "WorkItemType", "Work Item Type", "type", "issuetype"));
  if (!id || !title || !type) return undefined;
  const state = text(field(fields, "State", "status"));
  const description = text(field(fields, "Description"));
  const parent = parentOf(o, fields);
  const url = text(o.url && !/\/_apis\//.test(String(o.url)) ? o.url : undefined);
  const line = lineOf(id);
  return {
    system: isObj(o.fields) || !text(o.key) ? "ado" : "jira",
    id,
    type: typeOf(type),
    title,
    ...(state ? { state } : {}),
    tags: tagsOf(field(fields, "Tags", "labels")),
    ...(parent ? { parent } : {}),
    ...(description ? { description: stripHtml(description) } : {}),
    ...(url ? { url } : {}),
    pullRequests: pullRequestsOf(o),
    source: { path, ...(line ? { line } : {}) },
  };
}

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and line breaks inside quotes. */
function parseCsv(s: string): { cells: string[]; line: number }[] {
  const rows: { cells: string[]; line: number }[] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else {
        if (c === "\n") line++;
        cell += c;
      }
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push({ cells: row, line: rowLine });
      row = [];
      cell = "";
      line++;
      rowLine = line;
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push({ cells: row, line: rowLine });
  return rows;
}

function fromCsv(textIn: string, path: string): ExportedWorkItem[] | undefined {
  const rows = parseCsv(textIn.replace(/^\uFEFF/, ""));
  const header = rows[0]?.cells.map((h) => h.trim());
  if (!header) return undefined;
  const has = (n: string) => header.some((h) => h.toLowerCase() === n);
  if (!has("id") || !has("title") || !(has("work item type") || has("type"))) return undefined;
  const out: ExportedWorkItem[] = [];
  for (const r of rows.slice(1)) {
    const o = Object.fromEntries(header.map((h, i) => [h, r.cells[i] ?? ""]));
    const item = itemOf(o, path, () => r.line);
    if (item) out.push(item);
  }
  return out.length ? out : undefined;
}

/**
 * The work items in one exported file, or undefined when it isn't a work-item export (a
 * service-desk export, a document, a payload). Never throws.
 */
export function readWorkItemExport(
  path: string,
  bytes: Uint8Array,
): ExportedWorkItem[] | undefined {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  if (/\.csv$/i.test(path)) return fromCsv(content, path);
  if (!/\.(json|ya?ml)$/i.test(path)) return undefined;
  let data: unknown;
  try {
    data = parse(content);
  } catch {
    return undefined;
  }
  const list = Array.isArray(data)
    ? data
    : isObj(data) && Array.isArray(data.value)
      ? data.value
      : isObj(data) && Array.isArray(data.workItems)
        ? data.workItems
        : undefined;
  if (!list || !list.length || !list.every(isObj)) return undefined;
  const lines = content.split("\n");
  const lineOf = (id: string) => {
    const re = new RegExp(
      `"?(id|key)"?\\s*:\\s*"?${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`,
    );
    const i = lines.findIndex((l) => re.test(l));
    return i >= 0 ? i + 1 : undefined;
  };
  const items: ExportedWorkItem[] = [];
  for (const o of list as Record<string, unknown>[]) {
    const item = itemOf(o, path, lineOf);
    if (!item) return undefined;
    items.push(item);
  }
  return items;
}

/**
 * Every work-item export under inputs/ (wiki folders included only if they hold exports),
 * in path order. Paths are relative to the metarepo root and start with inputs/.
 */
export async function readWorkItemExports(o: { root: string; inputsDir?: string }): Promise<{
  items: ExportedWorkItem[];
  files: string[];
  problems: { path: string; message: string }[];
}> {
  const dir = o.inputsDir ?? join(o.root, "inputs");
  const files: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.name.startsWith(".")) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.(json|ya?ml|csv)$/i.test(e.name)) files.push(full);
    }
  }
  await walk(dir);
  const out = {
    items: [] as ExportedWorkItem[],
    files: [] as string[],
    problems: [] as { path: string; message: string }[],
  };
  for (const full of files) {
    const path = `inputs/${relative(dir, full).split(sep).join("/")}`;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(full));
    } catch (e) {
      out.problems.push({ path, message: `can't read it: ${(e as Error).message}` });
      continue;
    }
    const items = readWorkItemExport(path, bytes);
    if (!items) continue;
    out.files.push(path);
    out.items.push(...items);
  }
  return out;
}
