import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  parseRecord,
  sourceReadsPage,
  type CatalogRecord,
  type OrgPack,
  type RecordOf,
  orgPackDirOf,
} from "@maycombhq/core";
import type { ProfileSystem } from "@maycombhq/reconcile";
import { screenDocuments } from "@maycombhq/ai";
import { readMarkdown, type MarkdownDoc, type MdSection } from "./markdown.js";
import { mentionIndex, type MentionIndex } from "./mentions.js";
import { confluenceExportAdapter, sharepointExportAdapter } from "./exports.js";
import { authorityRank, bodyKey, pageRestricted, pageStandingOf } from "./standing.js";

export type WikiSource = OrgPack["sources"]["wikis"][number];
export type SourceDocumentRecord = RecordOf<"SourceDocument">;

/** One page as an adapter hands it over, before it is read. */
export interface RawPage {
  /** Path of the page inside its source, "/"-separated. */
  pagePath: string;
  /** Path recorded as evidence: relative to the metarepo root for folders. */
  path: string;
  content: string;
  /** Date the source system reports (an API's last-updated), when it has one. */
  updatedAt?: string;
  version?: string;
}

/**
 * Reads pages from one kind of knowledge source. Adapters only read: there is no method to
 * write, so Atticus can't write back to a wiki even by mistake.
 */
export interface KnowledgeSourceAdapter {
  pages(source: WikiSource, ctx: { root: string; orgPackDir: string }): Promise<RawPage[]>;
}

/** The read-only part of the C4 wiki adapter (Confluence, ADO wiki, SharePoint); mocks in tests. */
export interface WikiApi {
  listPages(
    space: string,
  ): Promise<
    { id: string; space: string; title: string; version: number; updatedAt: string; url: string }[]
  >;
  getPage(id: string): Promise<{
    id: string;
    space: string;
    title: string;
    body: string;
    version: number;
    updatedAt: string;
    url: string;
    /** ADR 0132, optional: the page's labels and whether it is under view restrictions. */
    labels?: string[];
    restricted?: boolean;
  }>;
}

const toPosix = (p: string) => p.split(sep).join("/");
const isUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);

/** Where a folder source lives: relative to the org-pack folder, where sources.yaml is. */
const folderOf = (source: WikiSource, orgPackDir: string) =>
  isAbsolute(source.location) ? source.location : resolve(orgPackDir, source.location);

class FolderUnreadable extends Error {}

/**
 * A folder of Markdown files: a `markdown-folder` source, an export folder, or a wiki kept
 * as a Git clone (ADO and GitHub wikis are Git repos). Dot folders such as .git are skipped.
 */
export const markdownFolderAdapter: KnowledgeSourceAdapter = {
  async pages(source, { root, orgPackDir }) {
    const dir = folderOf(source, orgPackDir);
    const out: RawPage[] = [];
    async function walk(d: string, top: boolean) {
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch {
        if (top) throw new FolderUnreadable(source.location);
        return;
      }
      for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (e.name.startsWith(".")) continue;
        const full = join(d, e.name);
        if (e.isDirectory()) await walk(full, false);
        else if (/\.(md|markdown)$/i.test(e.name))
          out.push({
            pagePath: toPosix(relative(dir, full)),
            path: toPosix(relative(root, full)),
            content: await readFile(full, "utf8"),
          });
      }
    }
    await walk(dir, true);
    return out;
  },
};

/** An API wiki read through the C4 wiki adapter: every page of each listed space. */
export function wikiApiAdapter(api: WikiApi): KnowledgeSourceAdapter {
  return {
    async pages(source) {
      const out: RawPage[] = [];
      for (const space of source.spaces) {
        const heads = await api.listPages(space);
        for (const h of [...heads].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
          const p = await api.getPage(h.id);
          // ADR 0132: what the API says of the page goes in front matter, as an export's does.
          const fm = [
            ...(p.labels?.length
              ? [`labels: [${p.labels.map((l) => JSON.stringify(l)).join(", ")}]`]
              : []),
            ...(p.restricted ? ["restricted: true"] : []),
          ];
          out.push({
            pagePath: `${space}/${p.id}`,
            path: `${source.id}:${space}/${p.id}`,
            content:
              fm.length && !p.body.startsWith("---\n")
                ? `---\n${fm.join("\n")}\n---\n${p.body}`
                : p.body,
            updatedAt: p.updatedAt,
            version: String(p.version),
          });
        }
      }
      return out;
    },
  };
}

export type StaleReason =
  | { reason: "too-old"; days: number; maxDays: number }
  | { reason: "code-newer"; system: string; codeAt: string };

export interface KnowledgePage {
  source: string;
  sourceType: string;
  /** Evidence path: relative to the metarepo root for folder sources. */
  path: string;
  /** Path inside the source. */
  pagePath: string;
  title: string;
  frontMatter: Record<string, unknown>;
  sections: MdSection[];
  doc: MarkdownDoc;
  /** Page date: front matter (updated, last_updated, date), a "Last updated:" line, or the API's. */
  date?: string;
  /** Front matter owner, or an "Owner:" line. */
  owner?: string;
  classification: string;
  version?: string;
  /** sha-256 of the page text. */
  hash: string;
  /** The page text as read: a sync copies it to the dated snapshot (ADR 0083). */
  text?: string;
  /** Systems the page mentions, resolved like diagram names. */
  systems: string[];
  /** The system the page is about, from its title (or front matter `system`). */
  subject?: string;
  freshness: "fresh" | "stale" | "unknown";
  stale: StaleReason[];
  /**
   * What the ingested-content defences found (ADR 0042), set only for medium and high risk.
   * The page is kept (it is data either way); a high-risk page never reaches an AI step.
   */
  defences?: { risk: "medium" | "high"; reason: string; rules: string[] };
}

export interface SyncResult {
  pages: KnowledgePage[];
  /** One SourceDocument per page read (docType wiki-page). Pages skipped get none. */
  documents: SourceDocumentRecord[];
  skipped: { source: string; path: string; reason: string }[];
  problems: { source: string; message: string }[];
  /** The highest classification read. */
  classificationLimit: string;
}

export interface SyncOptions {
  /** The metarepo root; evidence paths are relative to it. */
  root: string;
  orgPack: OrgPack;
  /** Where sources.yaml lives; folder locations are relative to it. Default: <root>/org-pack. */
  orgPackDir?: string;
  /** The catalog, for system mentions and the code-newer check. */
  records?: CatalogRecord[];
  /** The clock, from the caller (ISO date-time). Without it no page is aged. */
  now?: string;
  /** Pages older than this are stale. Default: pack freshness for SourceDocument, else 365. */
  maxAgeDays?: number;
  /**
   * The highest classification Atticus may read. C6 lists the levels (pack.yaml
   * `classification`) but no limit, so it is a parameter. Default: "internal" when it is a
   * level, else the lowest level.
   */
  maxClassification?: string;
  /** Classification of a page that states none. Same default as maxClassification. */
  defaultClassification?: string;
  /** Adapters by source type; a folder adapter is built in. */
  adapters?: Partial<Record<WikiSource["type"], KnowledgeSourceAdapter>>;
  /**
   * Adapters for single sources by id, before the one for their type: the built-in `inputs`
   * source (ADR 0122), whose files are documents read into text, not Markdown pages.
   */
  adaptersById?: Record<string, KnowledgeSourceAdapter>;
}

const DEFAULT_LEVELS = ["public", "internal", "confidential", "restricted"];
const DAY = 86_400_000;

export const daysBetween = (from: string, to: string) =>
  Math.floor((Date.parse(to) - Date.parse(from)) / DAY);

const dateOnly = (v: unknown): string | undefined => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v !== "string") return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  return m && !Number.isNaN(Date.parse(m[1]!)) ? m[1] : undefined;
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** A line such as "Owner: ..." or "Last updated: ..." in the page's prose. */
function metaLine(doc: MarkdownDoc, key: RegExp): { value: string; line: number } | undefined {
  for (const s of doc.sections)
    for (const b of s.blocks) {
      if (b.type !== "paragraph") continue;
      const lines = b.text.split("\n");
      for (let k = 0; k < lines.length; k++) {
        const m = new RegExp(`^${key.source}\\s*:\\s*(.+)$`, "i").exec(lines[k]!);
        if (m) return { value: m[1]!.trim(), line: b.line + k };
      }
    }
  return undefined;
}

export function pageOwnerLine(doc: MarkdownDoc) {
  return metaLine(doc, /owner/);
}

export interface ReadPageInput {
  source: string;
  sourceType?: string;
  path: string;
  pagePath?: string;
  content: string;
  updatedAt?: string;
  version?: string;
  records?: CatalogRecord[];
  systems?: ProfileSystem[];
  defaultClassification?: string;
  /** Reuse one index for many pages. */
  mentions?: MentionIndex;
}

/** Read one page: Markdown sections, metadata, hash and the systems it mentions. */
export function readPage(i: ReadPageInput): KnowledgePage {
  const doc = readMarkdown(i.content);
  const fm = doc.frontMatter;
  const fmStr = (k: string) => (typeof fm[k] === "string" ? (fm[k] as string) : undefined);
  const date =
    dateOnly(fm.updated) ??
    dateOnly(fm.last_updated) ??
    dateOnly(fm.lastUpdated) ??
    dateOnly(fm.date) ??
    dateOnly(metaLine(doc, /last\s+updated/)?.value) ??
    dateOnly(i.updatedAt);
  const owner = fmStr("owner") ?? pageOwnerLine(doc)?.value;
  const index = i.mentions ?? mentionIndex(i.records ?? [], i.systems ?? []);
  const text = [
    doc.title ?? "",
    ...doc.sections.flatMap((s) => [
      s.heading,
      ...s.blocks.map((b) =>
        b.type === "paragraph"
          ? b.text
          : b.type === "list"
            ? b.items.map((x) => x.text).join("\n")
            : "",
      ),
    ]),
  ].join("\n");
  const systems = [...new Set(index.find(text).map((m) => m.system))].sort();
  const subject =
    (fmStr("system") && index.systemOf(fmStr("system")!)) || index.find(doc.title ?? "")[0]?.system;
  const title =
    doc.title ??
    (i.pagePath ?? i.path)
      .split("/")
      .pop()!
      .replace(/\.[^.]+$/, "");
  return {
    source: i.source,
    sourceType: i.sourceType ?? "markdown-folder",
    path: i.path,
    pagePath: i.pagePath ?? i.path,
    title,
    frontMatter: fm,
    sections: doc.sections,
    doc,
    ...(date ? { date } : {}),
    ...(owner ? { owner } : {}),
    classification: fmStr("classification") ?? i.defaultClassification ?? "internal",
    ...(i.version ? { version: i.version } : fmStr("version") ? { version: fmStr("version") } : {}),
    hash: createHash("sha256").update(i.content).digest("hex"),
    text: i.content,
    systems,
    ...(subject ? { subject } : {}),
    freshness: date ? "fresh" : "unknown",
    stale: [],
  };
}

/** Newest scan time of non-document evidence per system. */
function newestCodePerSystem(records: CatalogRecord[], index: MentionIndex): Map<string, string> {
  const out = new Map<string, string>();
  const owner = (r: CatalogRecord): string | undefined => {
    const anyR = r as Record<string, unknown>;
    for (const k of ["system", "component", "ownerComponent", "from"]) {
      const v = anyR[k];
      if (typeof v === "string") {
        const s = index.systemOf(v);
        if (s) return s;
      }
    }
    return index.systemOf(r.id);
  };
  for (const r of records) {
    const sys = owner(r);
    if (!sys) continue;
    for (const e of r.evidence) {
      if (!e.scannedAt || e.source === "document" || e.source === "diagram") continue;
      const prev = out.get(sys);
      if (!prev || Date.parse(e.scannedAt) > Date.parse(prev)) out.set(sys, e.scannedAt);
    }
  }
  return out;
}

/**
 * Read every wiki listed in sources.yaml. Wikis are read-only: this never writes to them.
 * Pages above the classification limit are skipped and leave nothing behind but their path.
 * A page is stale when its date is older than the age limit, or older than the newest code
 * evidence for a system it describes. A page with no date can't be judged: "unknown".
 */
export async function syncSources(o: SyncOptions): Promise<SyncResult> {
  const orgPackDir = o.orgPackDir ?? join(orgPackDirOf(o.root));
  const levels = o.orgPack.pack?.classification ?? DEFAULT_LEVELS;
  const fallbackLevel = levels.includes("internal") ? "internal" : levels[0]!;
  const limit = o.maxClassification ?? fallbackLevel;
  const limitLevel = levels.indexOf(limit);
  const defaultClassification = o.defaultClassification ?? fallbackLevel;
  const maxDays = o.maxAgeDays ?? o.orgPack.pack?.freshness.SourceDocument ?? 365;
  const records = o.records ?? [];
  const systems = o.orgPack.profiles.flatMap((p) => p.profile?.systems ?? []);
  const index = mentionIndex(records, systems);
  const codeAt = newestCodePerSystem(records, index);

  const res: SyncResult = {
    pages: [],
    documents: [],
    skipped: [],
    problems: [],
    classificationLimit: limit,
  };
  if (limitLevel === -1) {
    res.problems.push({
      source: "*",
      message: `${limit} is not a classification level in pack.yaml, so no page was read.`,
    });
    return res;
  }

  // Every source's pages first, each source's include and exclude applied (sources.yaml version
  // 2), so a page two sources cover can be read once.
  const read: { source: WikiSource; raw: RawPage[] }[] = [];
  for (const source of o.orgPack.sources.wikis) {
    const folder =
      source.type === "markdown-folder" ||
      (source.type !== "confluence" && !isUrl(source.location));
    // ADR 0132: an export folder is read by its own adapter, with the export's metadata.
    const exportAdapter =
      source.type === "confluence-export"
        ? confluenceExportAdapter
        : source.type === "sharepoint-export"
          ? sharepointExportAdapter
          : undefined;
    const adapter =
      o.adaptersById?.[source.id] ??
      o.adapters?.[source.type] ??
      exportAdapter ??
      (folder ? markdownFolderAdapter : undefined);
    if (!adapter) {
      res.problems.push({
        source: source.id,
        message: `No adapter for the ${source.type} wiki ${source.id}, so its pages were not read.`,
      });
      continue;
    }
    let raw: RawPage[];
    try {
      raw = await adapter.pages(source, { root: o.root, orgPackDir });
    } catch (e) {
      res.problems.push({
        source: source.id,
        message:
          e instanceof FolderUnreadable
            ? `Can't read the wiki folder ${source.location}.`
            : `Can't read the ${source.type} wiki ${source.id}: ${(e as Error).message}`,
      });
      continue;
    }
    read.push({ source, raw: raw.filter((r) => sourceReadsPage(source, r.pagePath)) });
  }
  const owners = pageOwners(read.filter((x) => !o.adaptersById?.[x.source.id]));
  // ADR 0132: the same page mirrored in two wikis (the same words, front matter aside) is read
  // once, by the more authoritative source (then the first listed); the mirror is skipped.
  const mirrors = mirrorReaders(
    read
      .filter((x) => !o.adaptersById?.[x.source.id])
      // A file two sources cover is one page already, read by the nearest (above).
      .map((x) => ({
        source: x.source,
        raw: x.raw.filter((r) => {
          const owner = owners.get(r.path);
          return !owner || owner.source === x.source.id;
        }),
      })),
    o.orgPack,
  );

  for (const { source, raw: all } of read) {
    // A page another source also covers is read by the one nearest to it (its path there is
    // shortest; the first listed on a tie), and skipped here with where it is read.
    const raw: RawPage[] = [];
    for (const r of all) {
      const owner = owners.get(r.path);
      const mirror = mirrors.get(`${source.id}\0${r.pagePath}`);
      if (owner && owner.source !== source.id)
        res.skipped.push({
          source: source.id,
          path: r.path,
          reason: `also in ${owner.source} (as ${owner.pagePath}), which reads it`,
        });
      else if (mirror)
        res.skipped.push({
          source: source.id,
          path: r.path,
          reason: `the same page as ${mirror.source}/${mirror.pagePath}, which reads it`,
        });
      else raw.push(r);
    }
    // Screen every page as it was read (wiki text is untrusted); keep them all, flag the risky.
    const flagged = new Map(
      screenDocuments(raw.map((r) => ({ path: r.path, text: r.content, format: "markdown" }))).map(
        (f) => [f.path, f],
      ),
    );
    for (const r of raw) {
      const page = readPage({
        source: source.id,
        sourceType: source.type,
        path: r.path,
        pagePath: r.pagePath,
        content: r.content,
        ...(r.updatedAt ? { updatedAt: r.updatedAt } : {}),
        ...(r.version ? { version: r.version } : {}),
        records,
        systems,
        defaultClassification,
        mentions: index,
      });
      // ADR 0132: a page under view restrictions is above the limit for the metarepo's audience
      // (its snapshot is committed), unless the source says that audience may read it.
      if (!source.readRestricted && pageRestricted(page.frontMatter)) {
        res.skipped.push({
          source: source.id,
          path: r.path,
          reason:
            "under view restrictions, so above the limit for the metarepo's audience (readRestricted on the source says everyone who reads the metarepo may read it)",
        });
        continue;
      }
      const level = levels.indexOf(page.classification);
      if (level === -1 || level > limitLevel) {
        res.skipped.push({
          source: source.id,
          path: r.path,
          reason:
            level === -1
              ? `unknown classification ${page.classification}`
              : `${page.classification} is above the limit (${limit})`,
        });
        continue;
      }
      if (page.date) {
        if (o.now) {
          const days = daysBetween(page.date, o.now);
          if (days > maxDays) page.stale.push({ reason: "too-old", days, maxDays });
        }
        for (const sys of page.systems) {
          const at = codeAt.get(sys);
          if (at && Date.parse(at) > Date.parse(page.date))
            page.stale.push({ reason: "code-newer", system: sys, codeAt: at });
        }
        page.freshness = page.stale.length ? "stale" : "fresh";
      }
      const flag = flagged.get(r.path);
      if (flag && (flag.risk === "medium" || flag.risk === "high")) {
        page.defences = { risk: flag.risk, reason: flag.reason, rules: [...flag.rules] };
        if (flag.risk === "high")
          res.problems.push({
            source: source.id,
            message: `${r.path} is held back from every AI step: ${flag.reason} A person must review the page.`,
          });
      }
      res.pages.push(page);
      res.documents.push(sourceDocument(page));
    }
  }
  return res;
}

/**
 * Which source reads each page that two or more cover, by the page's evidence path: the source
 * whose path for it has the fewest folders (the source nearest to it, likely made for it), the
 * first listed on a tie. A page one source covers isn't listed.
 */
function pageOwners(
  read: { source: WikiSource; raw: RawPage[] }[],
): Map<string, { source: string; pagePath: string }> {
  const by = new Map<string, { source: string; pagePath: string }[]>();
  for (const { source, raw } of read)
    for (const r of raw) {
      const list = by.get(r.path) ?? [];
      list.push({ source: source.id, pagePath: r.pagePath });
      by.set(r.path, list);
    }
  const out = new Map<string, { source: string; pagePath: string }>();
  for (const [path, list] of by) {
    if (new Set(list.map((x) => x.source)).size < 2) continue;
    const depth = (p: string) => p.split("/").length;
    out.set(
      path,
      list.reduce((a, b) => (depth(b.pagePath) < depth(a.pagePath) ? b : a)),
    );
  }
  return out;
}

/**
 * The pages mirrored in another wiki (ADR 0132), by `<source>\0<page>` of each copy that is not
 * read, with the copy that is: the same words (front matter and markup aside, at least a dozen
 * words) in two or more sources. The copy read is the most authoritative (its page's standing),
 * then the first source listed. A page with a few words of its own differs: it is not a mirror.
 */
function mirrorReaders(
  read: { source: WikiSource; raw: RawPage[] }[],
  orgPack: OrgPack,
): Map<string, { source: string; pagePath: string }> {
  const settings = new Map(orgPack.sources.wikis.map((w) => [w.id, w]));
  const order = new Map(orgPack.sources.wikis.map((w, i) => [w.id, i]));
  const by = new Map<string, { source: string; pagePath: string; rank: number }[]>();
  for (const { source, raw } of read)
    for (const r of raw) {
      const k = bodyKey(r.content);
      if (k.words < 12) continue;
      const doc = readMarkdown(r.content);
      const standing = pageStandingOf(
        { source: source.id, pagePath: r.pagePath, frontMatter: doc.frontMatter, text: r.content },
        settings,
      );
      const list = by.get(k.key) ?? [];
      list.push({
        source: source.id,
        pagePath: r.pagePath,
        rank: authorityRank(standing.authority),
      });
      by.set(k.key, list);
    }
  const out = new Map<string, { source: string; pagePath: string }>();
  for (const list of by.values()) {
    if (new Set(list.map((x) => x.source)).size < 2) continue;
    const best = [...list].sort(
      (a, b) => a.rank - b.rank || (order.get(a.source) ?? 0) - (order.get(b.source) ?? 0),
    )[0]!;
    for (const x of list)
      if (x.source !== best.source)
        out.set(`${x.source}\0${x.pagePath}`, { source: best.source, pagePath: best.pagePath });
  }
  return out;
}

/** The SourceDocument record for a page read from a wiki. */
export function sourceDocument(page: KnowledgePage): SourceDocumentRecord {
  const base = page.pagePath.replace(/\.(md|markdown)$/i, "");
  const p = parseRecord({
    schemaVersion: 1,
    kind: "SourceDocument",
    id: `doc.${slug(page.source)}.${slug(base)}`.slice(0, 120),
    status: "current",
    confidence: "verified",
    path: page.path,
    docType: "wiki-page",
    ...(page.version ? { version: page.version } : {}),
    ...(page.owner ? { author: page.owner } : {}),
    ...(page.date ? { date: page.date } : {}),
    hash: page.hash,
    ...(page.defences ? { flags: [`defences:${page.defences.risk}`] } : {}),
    recordsProduced: [],
    evidence: [{ source: "document", path: page.path }],
  });
  if (!p.ok) throw new Error(`SourceDocument for ${page.path}: ${JSON.stringify(p.issues)}`);
  return p.record as SourceDocumentRecord;
}
