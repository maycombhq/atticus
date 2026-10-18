import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { clean, parseDoc, sectionLines, sectionMatching, tableWith, type Doc } from "./doc.js";

/**
 * The change folder's Markdown artifacts, read once per critic run, and the structured parts
 * the checks need (hops, data changes, stories, tasks, service-desk drafts). Only the tables
 * and headings the org-flow templates define are read; everything else is free text.
 */

export type ArtifactName =
  | "brief"
  | "proposal"
  | "specs"
  | "interfaces"
  | "mappings"
  | "data"
  | "design"
  | "ux"
  | "stories"
  | "tasks"
  | "snow";

export interface ChangeFiles {
  dir: string;
  /** Change-folder-relative path → document, in path order. */
  docs: Map<string, Doc>;
}

/** Which artifact a change-folder file belongs to, or undefined for anything else. */
export function artifactOf(rel: string): ArtifactName | undefined {
  if (rel.startsWith("specs/") && rel.endsWith(".md")) return "specs";
  if (rel === "stories.md" || (rel.startsWith("stories/") && rel.endsWith(".md"))) return "stories";
  const m = /^(brief|proposal|interfaces|mappings|data|design|ux|tasks|snow)\.md$/.exec(rel);
  return m ? (m[1] as ArtifactName) : undefined;
}

async function walk(dir: string, rel = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!rel && e.name === "review") continue;
      out.push(...(await walk(dir, p)));
    } else out.push(p);
  }
  return out;
}

export async function readChangeFiles(dir: string): Promise<ChangeFiles> {
  const docs = new Map<string, Doc>();
  for (const rel of (await walk(dir)).sort()) {
    if (!artifactOf(rel)) continue;
    docs.set(rel, parseDoc(rel, await readFile(join(dir, rel), "utf8")));
  }
  return { dir, docs };
}

export function filesOf(files: ChangeFiles, artifact: ArtifactName): Doc[] {
  return [...files.docs.values()].filter((d) => artifactOf(d.path) === artifact);
}

export const docOf = (files: ChangeFiles, rel: string) => files.docs.get(rel);

// ------------------------------------------------------------------ interfaces.md

export interface Hop {
  /** Line of the row in interfaces.md. */
  line: number;
  /** A catalog interface id, or "new". */
  id: string;
  caller: string;
  callee: string;
  /** The pattern code as written ("" when the cell is empty). */
  pattern: string;
  operation: string;
  method?: string;
  path?: string;
  contract: string;
  status: string;
}

const idCell = (s: string) => clean(s).split(/\s+/)[0]?.toLowerCase() ?? "";

export function readHops(files: ChangeFiles): Hop[] {
  const t = tableWith(docOf(files, "interfaces.md"), ["interface id", "caller", "callee"]);
  if (!t) return [];
  return t.rows
    .filter((r) => Object.values(r.cells).some((c) => c !== ""))
    .map((r) => {
      const op = r.cells.operation ?? "";
      const m = /^([A-Za-z]+)\s+(\S+)/.exec(op);
      return {
        line: r.line,
        id: idCell(r.cells["interface id"] ?? ""),
        caller: idCell(r.cells.caller ?? ""),
        callee: idCell(r.cells.callee ?? ""),
        pattern: clean(r.cells.pattern ?? ""),
        operation: op,
        ...(m ? { method: m[1]!.toUpperCase(), path: m[2]! } : {}),
        contract: r.cells.contract ?? "",
        status: idCell(r.cells.status ?? ""),
      };
    });
}

/** "/accounts/{id}/limit" → "/accounts/{}/limit", like the catalog's normalizedPath. */
export const normalizePath = (p: string) => p.replace(/\{[^}]*\}/g, "{}").replace(/\/+$/, "");

/** Notes lines in interfaces.md that talk about this hop (by its path or operation). */
export function hopNotes(files: ChangeFiles, hop: Hop): { n: number; text: string }[] {
  const doc = docOf(files, "interfaces.md");
  const s = sectionMatching(doc, /^notes$/i);
  if (!doc || !s) return [];
  const needle = (hop.path ?? hop.operation).toLowerCase();
  if (!needle) return [];
  return sectionLines(doc, s).filter((l) => l.text.toLowerCase().includes(needle));
}

/** Gateway route ids (gw-…) the hop's notes name. */
export function hopRoutes(files: ChangeFiles, hop: Hop): string[] {
  const out = new Set<string>();
  for (const l of hopNotes(files, hop))
    for (const m of l.text.matchAll(/\bgw-[a-z0-9][a-z0-9-]*[a-z0-9]\b/gi))
      out.add(m[0].toLowerCase());
  return [...out].sort();
}

// ------------------------------------------------------------------ data.md

export interface DataChange {
  line: number;
  store: string;
  table: string;
  change: string;
  migration: string;
  /** Catalog-style table id: <store>.<table-slug>. */
  tableId: string;
  newTable: boolean;
  /** Columns the row adds (from "add column" or "new table (...)"). */
  newColumns: { name: string; type: string }[];
}

/** Split "a int, b numeric(18,2)" at commas outside parentheses. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

export const tableSlug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export function readDataChanges(files: ChangeFiles): DataChange[] {
  const t = tableWith(docOf(files, "data.md"), ["data store", "table"]);
  if (!t) return [];
  const out: DataChange[] = [];
  for (const r of t.rows) {
    const store = idCell(r.cells["data store"] ?? "");
    const table = clean(r.cells.table ?? "");
    if (!store && !table) continue;
    const change = r.cells.change ?? "";
    const newColumns: DataChange["newColumns"] = [];
    let newTable = false;
    const nt = /new table\s+[\w.]*\s*\((.*)\)/i.exec(change);
    if (nt) {
      newTable = true;
      for (const col of splitTopLevel(nt[1]!)) {
        const [name, ...type] = col.split(/\s+/);
        if (name) newColumns.push({ name, type: type.join(" ") });
      }
    } else if (/^\s*(new|create) table/i.test(change)) newTable = true;
    for (const m of change.matchAll(/add column\s+(\w+)\s+([\w(),]+)/gi))
      newColumns.push({ name: m[1]!, type: m[2]! });
    const tid = table.includes(".") ? table.toLowerCase() : `${store}.${tableSlug(table)}`;
    out.push({
      line: r.line,
      store,
      table,
      change,
      migration: (r.cells.migration ?? "").trim(),
      tableId: tid,
      newTable,
      newColumns,
    });
  }
  return out;
}

// ------------------------------------------------------------------ stories and tasks

export interface StoryIndexRow {
  line: number;
  id: string;
  title: string;
  repos: string[];
  dependsOn: string[];
}

const list = (s: string) =>
  s
    .split(/[,;]/)
    .map((x) => idCell(x))
    .filter(Boolean);

export function readStoryIndex(files: ChangeFiles): StoryIndexRow[] {
  const t = tableWith(docOf(files, "stories.md"), ["story"]);
  if (!t) return [];
  return t.rows
    .map((r) => ({
      line: r.line,
      id: idCell(r.cells.story ?? ""),
      title: r.cells.title ?? "",
      repos: list(r.cells.repos ?? ""),
      dependsOn: list(r.cells["depends on"] ?? ""),
    }))
    .filter((r) => r.id);
}

export interface TaskLine {
  line: number;
  repo: string;
  text: string;
  stories: string[];
}

export function readTasks(files: ChangeFiles): TaskLine[] {
  const doc = docOf(files, "tasks.md");
  if (!doc) return [];
  const out: TaskLine[] = [];
  for (const s of doc.sections.filter((x) => x.level === 2)) {
    const repo = idCell(s.heading);
    for (const l of sectionLines(doc, s)) {
      if (!/^\s*[-*]\s+\[[ xX]?\]/.test(l.text)) continue;
      const stories = [...l.text.matchAll(/\bstor(?:y|ies)\s+([a-z0-9][a-z0-9._-]*)/gi)].map((m) =>
        m[1]!.toLowerCase().replace(/[.,)]+$/, ""),
      );
      out.push({ line: l.n, repo, text: l.text.trim(), stories });
    }
  }
  return out;
}

// ------------------------------------------------------------------ snow.md

export interface SnowDraft {
  heading: string;
  line: number;
  /** Field name (lower case) → value and the row's line. */
  fields: Map<string, { value: string; line: number }>;
  text: string;
}

export function readSnowDrafts(files: ChangeFiles): SnowDraft[] {
  const doc = docOf(files, "snow.md");
  if (!doc) return [];
  return doc.sections
    .filter((s) => s.level === 2)
    .map((s) => {
      const fields = new Map<string, { value: string; line: number }>();
      for (const t of doc.tables) {
        if (t.line < s.line || t.line > s.end || !t.headers.includes("field")) continue;
        for (const r of t.rows)
          fields.set((r.cells.field ?? "").toLowerCase(), {
            value: r.cells.value ?? "",
            line: r.line,
          });
      }
      return {
        heading: s.heading,
        line: s.line,
        fields,
        text: doc.lines.slice(s.line - 1, s.end).join("\n"),
      };
    });
}
