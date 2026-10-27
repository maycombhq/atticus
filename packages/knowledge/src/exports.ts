import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { stringify } from "yaml";
import type { KnowledgeSourceAdapter, RawPage, WikiSource } from "./sources.js";

/**
 * Wikis read from an export folder when there is no API (ADR 0130): a Confluence space exported
 * as HTML (`confluence-export`) and a SharePoint site's pages saved with the library's metadata
 * (`sharepoint-export`). Each page becomes Markdown with front matter holding what the export
 * says of it (title, last update, author, labels, status, restrictions), so the sync, the
 * snapshot, a page's standing and the scan read an export like any other page. Page text is
 * data, never instructions: nothing in it is followed.
 */

const toPosix = (p: string) => p.split(sep).join("/");
const folderOf = (source: WikiSource, orgPackDir: string) =>
  isAbsolute(source.location) ? source.location : resolve(orgPackDir, source.location);

// ------------------------------------------------------------------ HTML to Markdown

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const BLOCKS = new Set(
  "p div section article header footer main aside nav table thead tbody tfoot tr td th ul ol li blockquote pre h1 h2 h3 h4 h5 h6 hr dl dt dd figure figcaption form fieldset address".split(
    " ",
  ),
);

interface Block {
  kind: "text" | "item";
  text: string;
  prefix: string;
}

/**
 * HTML as Markdown: headings, paragraphs, ordered and unordered lists (nested by two spaces),
 * blockquotes, table rows as `a | b` lines and preformatted text as a fence. Scripts, styles and
 * comments are dropped. Inline markup is reduced to its text.
 */
export function htmlToMarkdown(html: string): string {
  const src = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, "");
  const blocks: Block[] = [];
  const lists: { ordered: boolean; n: number }[] = [];
  let quote = 0;
  let heading = 0;
  let pre = false;
  let item: string | undefined;
  let buf = "";
  let row: string[] | undefined;
  let cell: string | undefined;
  const qp = () => "> ".repeat(quote);
  const flush = () => {
    const text = pre
      ? buf.replace(/^\n+|\s+$/g, "")
      : buf
          .split("\n")
          .map((l) => l.replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .join("\n");
    buf = "";
    if (!text) return;
    if (pre) {
      blocks.push({ kind: "text", text: `\`\`\`\n${text}\n\`\`\``, prefix: qp() });
      return;
    }
    if (heading) {
      blocks.push({
        kind: "text",
        text: `${"#".repeat(heading)} ${text.replace(/\n/g, " ")}`,
        prefix: qp(),
      });
      return;
    }
    if (item !== undefined) {
      const depth = Math.max(0, lists.length - 1);
      blocks.push({ kind: "item", text: `${"  ".repeat(depth)}${item}${text}`, prefix: qp() });
      // A second paragraph of the same item is indented under it.
      item = " ".repeat(item.length);
      return;
    }
    blocks.push({ kind: "text", text, prefix: qp() });
  };
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  let last = 0;
  for (let m = tag.exec(src); m; m = tag.exec(src)) {
    const raw = src.slice(last, m.index);
    last = tag.lastIndex;
    const t = decodeEntities(pre ? raw : raw.replace(/\s+/g, " "));
    if (cell !== undefined) cell += t;
    else buf += t;
    const close = m[1] === "/";
    const name = m[2]!.toLowerCase();
    if (name === "br") {
      if (cell !== undefined) cell += " ";
      else buf += "\n";
      continue;
    }
    if (!BLOCKS.has(name)) continue;
    if (name === "td" || name === "th") {
      if (!close) cell = "";
      else if (cell !== undefined) {
        row?.push(cell.replace(/\s+/g, " ").trim());
        cell = undefined;
      }
      continue;
    }
    if (name === "tr") {
      if (!close) {
        flush();
        row = [];
      } else if (row) {
        const cells = row.filter((c) => c);
        if (cells.length) blocks.push({ kind: "item", text: cells.join(" | "), prefix: qp() });
        row = undefined;
      }
      continue;
    }
    flush();
    const h = /^h([1-6])$/.exec(name);
    if (h) heading = close ? 0 : Number(h[1]);
    else if (name === "ul" || name === "ol") {
      if (close) lists.pop();
      else lists.push({ ordered: name === "ol", n: 0 });
      item = undefined;
    } else if (name === "li") {
      const l = lists.at(-1);
      if (close) item = undefined;
      else if (l) item = l.ordered ? `${++l.n}. ` : "- ";
      else item = "- ";
    } else if (name === "blockquote") quote = Math.max(0, quote + (close ? -1 : 1));
    else if (name === "pre") pre = !close;
  }
  buf += decodeEntities(src.slice(last).replace(/\s+/g, " "));
  flush();
  let out = "";
  blocks.forEach((b, i) => {
    const lines = b.text.split("\n").map((l) => `${b.prefix}${l}`.trimEnd());
    if (i > 0) {
      const prev = blocks[i - 1]!;
      out +=
        prev.kind === "item" && b.kind === "item"
          ? "\n"
          : prev.prefix && prev.prefix === b.prefix
            ? `\n${b.prefix.trimEnd()}\n`
            : "\n\n";
    }
    out += lines.join("\n");
  });
  return out ? `${out}\n` : "";
}

/** The inner HTML of the first element whose opening tag matches, nesting counted. */
export function elementInner(html: string, open: RegExp): string | undefined {
  const m = open.exec(html);
  if (!m) return undefined;
  const name = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(m[0])?.[1]?.toLowerCase();
  if (!name) return undefined;
  const start = m.index + m[0].length;
  const tag = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
  tag.lastIndex = start;
  let depth = 1;
  for (let t = tag.exec(html); t; t = tag.exec(html)) {
    depth += t[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, t.index);
  }
  return html.slice(start);
}

const textOf = (html: string) =>
  decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A date as an export writes it: ISO, "Jan 10, 2023", "10 Jan 2023" or "10/02/2026" (month first). */
export function exportDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const v = s.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const mdy = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(v);
  if (mdy && MONTHS.includes(mdy[1]!.toLowerCase()))
    return `${mdy[3]}-${pad(MONTHS.indexOf(mdy[1]!.toLowerCase()) + 1)}-${pad(Number(mdy[2]))}`;
  const dmy = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})/.exec(v);
  if (dmy && MONTHS.includes(dmy[2]!.toLowerCase()))
    return `${dmy[3]}-${pad(MONTHS.indexOf(dmy[2]!.toLowerCase()) + 1)}-${pad(Number(dmy[1]))}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v);
  if (us) return `${us[3]}-${pad(Number(us[1]))}-${pad(Number(us[2]))}`;
  return undefined;
}

/** What an export says of a page, written as the page's front matter. */
export interface ExportMeta {
  title: string;
  author?: string;
  updated?: string;
  labels?: string[];
  status?: string;
  restricted?: boolean;
  space?: string;
  spaceStatus?: string;
}

/** A page as Markdown with its export's metadata as front matter. */
export function exportPage(meta: ExportMeta, bodyMd: string): string {
  const fm: Record<string, unknown> = { title: meta.title };
  if (meta.author) fm.author = meta.author;
  if (meta.updated) fm.updated = meta.updated;
  if (meta.labels?.length) fm.labels = meta.labels;
  if (meta.status) fm.status = meta.status;
  if (meta.restricted) fm.restricted = true;
  if (meta.space) fm.space = meta.space;
  if (meta.spaceStatus) fm["space-status"] = meta.spaceStatus;
  const body = /^#\s/.test(bodyMd) ? bodyMd : `# ${meta.title}\n\n${bodyMd}`;
  return `---\n${stringify(fm, { lineWidth: 0 })}---\n${body}`;
}

/** A title as a path segment: words joined by "-", nothing that isn't a letter or digit. */
export const titleSegment = (t: string) =>
  t
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "page";

// ------------------------------------------------------------------ export metadata (CSV)

/** A CSV file's rows (RFC 4180 quoting), the first row as the header, lower-cased. */
export function readCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (q) {
      if (c === '"' && t[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  const [head, ...rest] = rows;
  if (!head) return [];
  const keys = head.map((h) => h.trim().toLowerCase());
  return rest.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

const col = (r: Record<string, string>, ...names: string[]) => {
  for (const n of names) if (r[n]) return r[n];
  return undefined;
};
const truthy = (v: string | undefined) => !!v && /^(true|yes|1|unique|restricted)$/i.test(v.trim());
const listOf = (v: string | undefined) =>
  (v ?? "")
    .split(/[;,|]/)
    .map((x) => x.replace(/^#/, "").trim())
    .filter(Boolean);

/** The metadata rows of an export, by the page's path in it and by its file name. */
async function exportMetadata(dir: string): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    if (!/\.csv$/i.test(f)) continue;
    for (const r of readCsv(await readFile(join(dir, f), "utf8"))) {
      const path = col(r, "path", "fileref", "url path", "serverrelativeurl");
      const name = col(r, "name", "filename", "file name");
      if (path) out.set(path.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase(), r);
      if (name) out.set(`#${name.toLowerCase()}`, r);
    }
  }
  return out;
}

function metaFromRow(r: Record<string, string> | undefined): Partial<ExportMeta> {
  if (!r) return {};
  const status = col(r, "status", "approval status", "_moderationstatus", "page status");
  const labels = listOf(col(r, "labels", "tags", "keywords", "enterprise keywords"));
  const restricted =
    truthy(col(r, "hasuniqueroleassignments", "restricted", "unique permissions")) ||
    /restrict/i.test(col(r, "permissions", "restrictions") ?? "");
  const author = col(r, "modified by", "editor", "author", "created by");
  const updated = exportDate(col(r, "modified", "last modified", "updated"));
  const title = col(r, "title");
  const spaceStatus = col(r, "space status", "site status");
  return {
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(updated ? { updated } : {}),
    ...(labels.length ? { labels } : {}),
    ...(status ? { status } : {}),
    ...(restricted ? { restricted } : {}),
    ...(spaceStatus ? { spaceStatus } : {}),
  };
}

async function walkFiles(dir: string, test: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const skip = new Set(["attachments", "images", "styles", "_catalogs"]);
  async function walk(d: string, top: boolean) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch (e) {
      if (top) throw e;
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.name.startsWith(".") || skip.has(e.name)) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full, false);
      else if (test(e.name)) out.push(full);
    }
  }
  await walk(dir, true);
  return out;
}

// ------------------------------------------------------------------ Confluence space export

/**
 * A Confluence space exported as HTML: each `<Title>_<id>.html` is a page; its place in the space
 * is its breadcrumbs (the space's home left out), so a page is `Standards/Idempotency-Keys.md` and
 * `byPage` patterns such as `Drafts/**` work. Read from the page: the title, the "Created by ...,
 * last modified by ... on <date>" line, the labels section, and a restriction marker where the
 * export has one; a `*.csv` beside the pages (path, title, labels, status, restricted) adds what
 * the HTML lacks. The space's `index.html` is its list of pages, not a page.
 */
export const confluenceExportAdapter: KnowledgeSourceAdapter = {
  async pages(source, { root, orgPackDir }) {
    const dir = folderOf(source, orgPackDir);
    const files = await walkFiles(
      dir,
      (n) => /\.html?$/i.test(n) && n.toLowerCase() !== "index.html",
    );
    const meta = await exportMetadata(dir);
    const out: RawPage[] = [];
    for (const full of files) {
      const html = await readFile(full, "utf8");
      const titleText = textOf(
        elementInner(html, /<span\b[^>]*id=["']title-text["'][^>]*>/i) ??
          /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ??
          "",
      );
      const colon = titleText.indexOf(" : ");
      const space = colon > 0 ? titleText.slice(0, colon) : undefined;
      const title = colon > 0 ? titleText.slice(colon + 3) : titleText;
      if (!title) continue;
      const crumbs = [
        ...(elementInner(html, /<ol\b[^>]*id=["']breadcrumbs["'][^>]*>/i) ?? "").matchAll(
          /<li\b[^>]*>([\s\S]*?)<\/li>/gi,
        ),
      ]
        .map((m) => textOf(m[1]!))
        .filter(Boolean)
        .slice(1);
      const pagePath = [...crumbs, title].map(titleSegment).join("/") + ".md";
      const rel = toPosix(relative(dir, full));
      const line = textOf(
        elementInner(html, /<div\b[^>]*class=["'][^"']*page-metadata[^"']*["'][^>]*>/i) ?? "",
      );
      const editor = /last modified by\s+(.+?)\s+on\s/i.exec(line)?.[1];
      const creator = /created by\s+(.+?)(?:,|\s+on\s|$)/i.exec(line)?.[1];
      const when = /(?:last modified|created)(?: by .+?)? on (.+)$/i.exec(line)?.[1];
      const labels = [
        ...html.matchAll(
          /<a\b[^>]*class=["'][^"']*aui-label-split-main[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
        ),
      ].map((m) => textOf(m[1]!));
      const restricted =
        /<(?:div|span|meta)\b[^>]*(?:id|class|name)=["'][^"']*(?:page-restrictions|view-restricted|confluence-restrictions)[^"']*["']/i.test(
          html,
        );
      const status = textOf(
        elementInner(html, /<span\b[^>]*class=["'][^"']*page-status[^"']*["'][^>]*>/i) ?? "",
      );
      const row =
        meta.get(rel.toLowerCase()) ?? meta.get(`#${rel.split("/").pop()!.toLowerCase()}`);
      const body = htmlToMarkdown(
        elementInner(html, /<div\b[^>]*id=["']main-content["'][^>]*>/i) ??
          elementInner(html, /<body\b[^>]*>/i) ??
          html,
      );
      const m: ExportMeta = {
        title,
        ...(editor || creator ? { author: (editor ?? creator)!.trim() } : {}),
        ...(exportDate(when) ? { updated: exportDate(when)! } : {}),
        ...(labels.length ? { labels } : {}),
        ...(status ? { status } : {}),
        ...(restricted ? { restricted } : {}),
        ...(space ? { space } : {}),
        ...metaFromRow(row),
      };
      out.push({
        pagePath,
        path: toPosix(relative(root, full)),
        content: exportPage(m, body),
        ...(m.updated ? { updatedAt: m.updated } : {}),
      });
    }
    return out;
  },
};

// ------------------------------------------------------------------ SharePoint site export

/**
 * A SharePoint site's pages saved to a folder (`.html`, `.htm` or `.aspx`, or Markdown), with the
 * pages library exported to a `*.csv` beside them: its Title, Modified, Modified By, labels or
 * tags, status and `HasUniqueRoleAssignments` (a page with permissions of its own is restricted)
 * are read for the page whose Path or Name the row gives. A page is `<its path>.md`.
 */
export const sharepointExportAdapter: KnowledgeSourceAdapter = {
  async pages(source, { root, orgPackDir }) {
    const dir = folderOf(source, orgPackDir);
    const files = await walkFiles(dir, (n) => /\.(html?|aspx|md|markdown)$/i.test(n));
    const meta = await exportMetadata(dir);
    const out: RawPage[] = [];
    for (const full of files) {
      const rel = toPosix(relative(dir, full));
      const text = await readFile(full, "utf8");
      const row =
        meta.get(rel.toLowerCase()) ?? meta.get(`#${rel.split("/").pop()!.toLowerCase()}`);
      const md = /\.(md|markdown)$/i.test(rel);
      const htmlTitle = md
        ? undefined
        : textOf(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] ?? "");
      const fromRow = metaFromRow(row);
      const title =
        fromRow.title ??
        htmlTitle ??
        rel
          .split("/")
          .pop()!
          .replace(/\.[^.]+$/, "");
      const body = md
        ? text.replace(/^---\n[\s\S]*?\n---\n/, "")
        : htmlToMarkdown(
            elementInner(
              text,
              /<div\b[^>]*class=["'][^"']*(?:ms-rtestate-field|canvas)[^"']*["'][^>]*>/i,
            ) ??
              elementInner(text, /<main\b[^>]*>/i) ??
              elementInner(text, /<body\b[^>]*>/i) ??
              text,
          );
      const m: ExportMeta = { ...fromRow, title };
      out.push({
        pagePath: rel.replace(/\.(html?|aspx|markdown)$/i, ".md"),
        path: toPosix(relative(root, full)),
        content: exportPage(m, body),
        ...(m.updated ? { updatedAt: m.updated } : {}),
      });
    }
    return out;
  },
};
