import { join } from "node:path";
import type * as Api from "./api-types";
import type { Item, Open } from "./sidebar-data";

/**
 * Knowledge managed in the metarepo, in the editor (ADR 0101): the wiki sources, the items the
 * knowledge scan read (by kind, each with a person's review), what the last scan changed, the
 * searches of the wikis (`atticus knowledge find`), and what a change needs from the
 * organisation. As plain data and argv: no `vscode` here, so it is tested outside the editor.
 * Every command runs through the command line, which does every check.
 */

// ------------------------------------------------------------------ what the command line gives

export type KnowledgeKind =
  | "pattern"
  | "standard"
  | "process"
  | "request"
  | "decision"
  | "constraint"
  | "team"
  | "vendor"
  | "product"
  | "project";

export const KNOWLEDGE_KINDS: KnowledgeKind[] = [
  "request",
  "process",
  "standard",
  "pattern",
  "decision",
  "constraint",
  "team",
  "vendor",
  "product",
  "project",
];

/** A person's review of an item, as `knowledge list --json` gives it. */
export interface Review {
  state: "verified" | "corrected" | "rejected" | "stale";
  verdict: string;
  by: string;
  at: string;
  note?: string;
  corrected?: string[];
}

export interface Quote {
  source: string;
  page: string;
  section: string;
  text: string;
  snapshot: string;
  line?: number;
}

/** A link a page gave: a request form, a service-desk catalogue item. */
export interface Url {
  url: string;
  label?: string;
}

/** One item of `atticus knowledge list --json`; only the fields the extension reads. */
export interface KnowledgeEntry {
  id: string;
  /** The record kind: ProcessDefinition, Pattern, Decision, Party, Product. */
  kind: string;
  knowledgeKind?: string;
  title?: string;
  name?: string;
  appliesWhen?: string;
  leadTime?: string;
  handledBy?: string;
  catalogueItem?: string;
  inputs?: string[];
  steps?: string[];
  rules?: string[];
  quote?: Quote;
  /** The page's own links (ADR 0101). A Decision's `links` are other records, never these. */
  urls?: Url[];
  review?: Review;
  [field: string]: unknown;
}

/** One need of `atticus needs --change <id> --all --json`. */
export interface NeedEntry {
  change: string;
  item: string;
  kind: string;
  title: string;
  for: string;
  why: string;
  because?: { file: string; quote: string; line?: number };
  when?: string;
  from: string;
  leadTime?: string;
  handledBy?: string;
  catalogueItem?: string;
  inputs: string[];
  steps: string[];
  rules: string[];
  page?: string;
  status: "open" | "done" | "not-needed";
  note?: string;
  by?: string;
  at?: string;
  /** Who verified the knowledge item it comes from. */
  verified?: string;
  urls?: Url[];
}

export interface KnowledgePaths {
  root: string;
  /** knowledge, or .atticus/knowledge when a repo adopted Atticus. */
  knowledgeRel?: string;
}

const day = (at: string | undefined) => (at ?? "").slice(0, 10);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** Words from a page or the assistant, shown as Markdown: never as links or markup. */
const md = (s: string) =>
  s
    .replace(/([\\`*_[\]<>])/g, "\\$1")
    .replace(/\n/g, " ")
    .replace(/^([#>+-])/, "\\$1")
    .replace(/^(\d+)\./, "$1\\.");
const listOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const textOf = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v : undefined;

/** The links a page gave, http(s) only: nothing else is opened from what was read. */
export function urlsOf(x: { urls?: unknown }): Url[] {
  if (!Array.isArray(x.urls)) return [];
  return x.urls.flatMap((u: unknown) => {
    const o = u as { url?: unknown; label?: unknown };
    if (!o || typeof o.url !== "string" || !/^https?:\/\/\S+$/i.test(o.url)) return [];
    return [{ url: o.url, ...(typeof o.label === "string" && o.label ? { label: o.label } : {}) }];
  });
}

const linkLine = (us: Url[]) =>
  us.length ? `Links: ${us.map((u) => `[${md(u.label ?? u.url)}](${u.url})`).join(", ")}` : "";

// ------------------------------------------------------------------ items by kind

export interface KnowledgeGroup {
  id: string;
  label: string;
  kinds: string[];
  icon: string;
}

export const KNOWLEDGE_GROUPS: KnowledgeGroup[] = [
  { id: "requests", label: "Requests and processes", kinds: ["request", "process"], icon: "inbox" },
  { id: "standards", label: "Standards and patterns", kinds: ["standard", "pattern"], icon: "law" },
  {
    id: "decisions",
    label: "Decisions and constraints",
    kinds: ["decision", "constraint"],
    icon: "milestone",
  },
  { id: "teams", label: "Teams", kinds: ["team"], icon: "organization" },
  { id: "vendors", label: "Vendors", kinds: ["vendor"], icon: "briefcase" },
  {
    id: "products",
    label: "Products and projects",
    kinds: ["product", "project"],
    icon: "package",
  },
];
const OTHER: KnowledgeGroup = { id: "other", label: "Other", kinds: [], icon: "book" };

export const itemTitle = (i: KnowledgeEntry): string => textOf(i.title) ?? textOf(i.name) ?? i.id;

const groupOf = (i: KnowledgeEntry) =>
  KNOWLEDGE_GROUPS.find((g) => g.kinds.includes(i.knowledgeKind ?? "")) ?? OTHER;

/** The items in their groups, in a fixed order; a group with nothing in it is left out. */
export function groupKnowledge(
  items: KnowledgeEntry[],
): { group: KnowledgeGroup; items: KnowledgeEntry[] }[] {
  return [...KNOWLEDGE_GROUPS, OTHER]
    .map((group) => ({
      group,
      items: items
        .filter((i) => groupOf(i) === group)
        .sort((a, b) => itemTitle(a).localeCompare(itemTitle(b))),
    }))
    .filter((g) => g.items.length);
}

/** The group rows under Items: each with how many, and how many to check again. */
export function knowledgeGroupItems(items: KnowledgeEntry[]): Item[] {
  return groupKnowledge(items).map(({ group, items: is }) => {
    const stale = is.filter((i) => i.review?.state === "stale").length;
    return {
      id: `kgroup:${group.id}`,
      label: group.label,
      description: `${is.length}${stale ? ` · ${stale} to check again` : ""}`,
      icon: group.icon,
      expand: { kind: "knowledge-group", group: group.id },
    };
  });
}

/** The items of one group, by its id. */
export const itemsOfGroup = (items: KnowledgeEntry[], group: string) =>
  groupKnowledge(items).find((g) => g.group.id === group)?.items ?? [];

/** How a review shows: its icon, the icon's colour, and the words beside the item. */
export function reviewLook(r: Review | undefined): { icon: string; color?: string; word: string } {
  if (!r) return { icon: "circle-large-outline", word: "not reviewed" };
  if (r.state === "verified")
    return { icon: "pass-filled", color: "testing.iconPassed", word: `✓ ${r.by}` };
  if (r.state === "corrected")
    return { icon: "pass-filled", color: "testing.iconPassed", word: `✓ corrected by ${r.by}` };
  if (r.state === "rejected")
    return { icon: "error", color: "testing.iconFailed", word: `✗ rejected by ${r.by}` };
  return { icon: "warning", color: "list.warningForeground", word: "check again" };
}

/** The snapshot's copy of the page the item was read from, at the quote's line. */
export function snapshotOpen(i: KnowledgeEntry, p: KnowledgePaths): Open {
  const rel = p.knowledgeRel ?? "knowledge";
  const q = i.quote;
  if (!q?.source || !q.page || !q.snapshot)
    return { kind: "file", path: join(p.root, rel, "items", i.kind.toLowerCase(), `${i.id}.yaml`) };
  // As the snapshot names its files (ADR 0083): the page's path, .md added, no "..".
  const page = q.page
    .split("/")
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");
  const file = /\.(md|markdown)$/i.test(page) ? page : `${page}.md`;
  return {
    kind: "file",
    path: join(p.root, rel, "snapshots", q.source, q.snapshot, file),
    ...(q.line ? { line: q.line } : {}),
  };
}

/** Fields shown in a tooltip, by record kind, with their words. */
const SHOWN: [string, string][] = [
  ["appliesWhen", "Applies when"],
  ["definition", "What it is"],
  ["description", "What it is"],
  ["reason", "Why"],
  ["leadTime", "Lead time"],
  ["handledBy", "Handled by"],
  ["catalogueItem", "Catalogue item"],
  ["owner", "Owner"],
  ["ownedBy", "Owned by"],
  ["responsibilities", "Responsibilities"],
  ["owns", "Owns"],
  ["uses", "Uses"],
  ["usedBy", "Used by"],
  ["vendor", "Vendor"],
  ["systems", "Systems"],
  ["channel", "Channel"],
  ["contacts", "Contacts"],
  ["inputs", "It needs"],
  ["notes", "Notes"],
];

function reviewLine(r: Review | undefined): string {
  if (!r) return "Not reviewed by a person yet.";
  const note = r.note ? `: ${md(r.note)}` : "";
  if (r.state === "verified") return `Verified by ${md(r.by)} on ${day(r.at)}${note}`;
  if (r.state === "corrected")
    return `Corrected by ${md(r.by)} on ${day(r.at)}${r.corrected?.length ? ` (${r.corrected.join(", ")})` : ""}${note}`;
  if (r.state === "rejected") return `Rejected by ${md(r.by)} on ${day(r.at)}${note}`;
  return `Its page changed since ${md(r.by)} verified it on ${day(r.at)}: check it again.`;
}

/** The item's tooltip, as Markdown: what it says, its how-to, where it was read, its review. */
export function knowledgeTooltip(i: KnowledgeEntry): string {
  const blocks: string[] = [`**${md(itemTitle(i))}** · ${i.knowledgeKind ?? i.kind}`];
  const fields = SHOWN.flatMap(([f, w]) => {
    const v = i[f];
    if (Array.isArray(v)) return listOf(v).length ? [`${w}: ${listOf(v).map(md).join(", ")}`] : [];
    return textOf(v) ? [`${w}: ${md(v as string)}`] : [];
  });
  const links = linkLine(urlsOf(i));
  if (links) fields.push(links);
  if (fields.length) blocks.push(fields.join("  \n"));
  const steps = listOf(i.steps);
  if (steps.length)
    blocks.push(`Steps:\n\n${steps.map((s, n) => `${n + 1}. ${md(s)}`).join("\n")}`);
  const rules = listOf(i.rules);
  if (rules.length) blocks.push(`Rules:\n\n${rules.map((s) => `- ${md(s)}`).join("\n")}`);
  const q = i.quote;
  if (q) {
    blocks.push(`> ${md(q.text)}`);
    blocks.push(
      `From ${md(`${q.source}/${q.page}`)}${q.section ? `, ${md(q.section)}` : ""}${q.line ? `, line ${q.line}` : ""} (snapshot ${q.snapshot})`,
    );
  }
  blocks.push(reviewLine(i.review));
  return blocks.join("\n\n");
}

/** Each item's row: its title, who reviewed it, its tick, and what clicking opens. */
export function knowledgeItemRows(items: KnowledgeEntry[], p: KnowledgePaths): Item[] {
  return items.map((k) => {
    const look = reviewLook(k.review);
    return {
      id: `knowledge:${k.id}`,
      label: itemTitle(k),
      description: look.word,
      tooltip: knowledgeTooltip(k),
      markdown: true,
      icon: look.icon,
      ...(look.color ? { color: look.color } : {}),
      open: snapshotOpen(k, p),
      context: `atticus.knowledgeItem${urlsOf(k).length ? ".urls" : ""}`,
      knowledge: k,
    };
  });
}

// ------------------------------------------------------------------ correcting an item

const WORDS: Record<string, string> = {
  title: "Title",
  urls: "Links (label=address)",
  aliases: "Other names",
  appliesWhen: "Applies when",
  leadTime: "Lead time",
  handledBy: "Handled by",
  catalogueItem: "Catalogue item",
  inputs: "Inputs",
  steps: "Steps",
  notes: "Notes",
  name: "Name",
  definition: "Definition",
  rules: "Rules",
  reason: "Reason",
  owner: "Owner",
  responsibilities: "Responsibilities",
  owns: "Owns",
  uses: "Uses",
  contacts: "Contacts",
  channel: "Channel",
  description: "Description",
  ownedBy: "Owned by",
  usedBy: "Used by",
  vendor: "Vendor",
  systems: "Systems",
};

/** The fields a person may correct, by record kind, as the command line has them (ADR 0101). */
const CORRECTABLE: Record<string, [string, "text" | "list" | "links"][]> = {
  ProcessDefinition: [
    ["title", "text"],
    ["appliesWhen", "text"],
    ["leadTime", "text"],
    ["handledBy", "text"],
    ["catalogueItem", "text"],
    ["inputs", "list"],
    ["steps", "list"],
    ["notes", "text"],
    ["urls", "links"],
  ],
  Pattern: [
    ["name", "text"],
    ["definition", "text"],
    ["rules", "list"],
    ["appliesWhen", "text"],
    ["handledBy", "text"],
    ["urls", "links"],
  ],
  Decision: [
    ["title", "text"],
    ["appliesWhen", "text"],
    ["handledBy", "text"],
    ["reason", "text"],
    ["urls", "links"],
  ],
  Party: [
    ["name", "text"],
    ["owner", "text"],
    ["responsibilities", "list"],
    ["owns", "list"],
    ["uses", "list"],
    ["contacts", "list"],
    ["channel", "text"],
    ["aliases", "list"],
    ["urls", "links"],
  ],
  Product: [
    ["name", "text"],
    ["description", "text"],
    ["ownedBy", "text"],
    ["usedBy", "list"],
    ["vendor", "text"],
    ["systems", "list"],
    ["aliases", "list"],
    ["urls", "links"],
  ],
};

/** A list's values as one line, for an input box. */
export const LIST_SEPARATOR = " | ";

export interface CorrectChoice {
  field: string;
  label: string;
  list: boolean;
  /** Its value now: a list's values joined by " | ". */
  current: string;
}

export function correctChoices(i: KnowledgeEntry): CorrectChoice[] {
  return (CORRECTABLE[i.kind] ?? []).map(([field, type]) => ({
    field,
    label: WORDS[field] ?? field,
    list: type !== "text",
    // A link is label=address, or just the address (ADR 0101).
    current:
      type === "links"
        ? urlsOf(i)
            .map((u) => (u.label ? `${u.label}=${u.url}` : u.url))
            .join(LIST_SEPARATOR)
        : type === "list"
          ? listOf(i[field]).join(LIST_SEPARATOR)
          : (textOf(i[field]) ?? ""),
  }));
}

/** "a | b | c" as the values a, b and c. */
export const listFromText = (t: string) =>
  t
    .split("|")
    .map((x) => x.trim())
    .filter(Boolean);

export function correctArgv(
  id: string,
  sets: { field: string; value: string | string[] }[],
  note?: string,
): string[] {
  return [
    "knowledge",
    "correct",
    id,
    ...sets.flatMap((s) => [
      "--set",
      `${s.field}=${Array.isArray(s.value) ? s.value.join("|") : s.value}`,
    ]),
    ...(note?.trim() ? ["--note", note.trim()] : []),
  ];
}

// ------------------------------------------------------------------ the sources

/** The kinds of knowledge a source holds that Atticus suggests; an organisation adds its own. */
export const SOURCE_KINDS: { id: string; label: string }[] = [
  { id: "enterprise-architecture", label: "Enterprise architecture" },
  { id: "integration-patterns", label: "Integration patterns" },
  { id: "platform-runbook", label: "Platform runbooks" },
  { id: "security-standard", label: "Security standards" },
  { id: "change-process", label: "Change process (requests, approvals, lead times)" },
  { id: "framework", label: "A framework's docs" },
];

export type WikiType = "git" | "markdown-folder" | "ado-wiki" | "confluence" | "sharepoint";

/** A name for a new source: its repository's or folder's last part, as a slug. */
export function defaultSourceId(location: string): string {
  const parts = location
    .replace(/[\\/]+$/, "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .split(/[\\/:]/)
    .filter(Boolean);
  const last = (parts.at(-1) ?? "").replace(/\.git$/i, "").replace(/\.wiki$/i, "");
  return last
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface WikiAnswers {
  type: WikiType;
  location: string;
  id?: string;
  /** The folder its pages are in, inside the repository. */
  path?: string;
  /** A branch or tag. */
  ref?: string;
  submodule?: boolean;
  kinds: string[];
  frameworks?: string[];
  owner?: string;
  /** Write it into sources.yaml; without, the command prints the entry. */
  save: boolean;
}

export function sourcesAddArgv(a: WikiAnswers): string[] {
  const opt = (flag: string, v: string | undefined) => (v?.trim() ? [flag, v.trim()] : []);
  return [
    "sources",
    "add",
    a.type,
    a.location,
    ...opt("--id", a.id),
    ...opt("--path", a.path),
    ...opt("--ref", a.ref),
    ...(a.submodule ? ["--submodule"] : []),
    ...(a.kinds.length ? ["--kind", a.kinds.join(",")] : []),
    ...(a.frameworks?.length ? ["--framework", a.frameworks.join(",")] : []),
    ...opt("--owner", a.owner),
    ...(a.save ? ["--save"] : []),
  ];
}

/** The newest of a source's snapshot folders (each named by its date). */
export const latestSnapshot = (names: string[]) =>
  names
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .sort()
    .at(-1);

/** The commit a git wiki's snapshot read, short, from its snapshot.yaml. */
export const snapshotCommit = (text: string) =>
  /^commit:\s*["']?([0-9a-f]{7,40})/m.exec(text)?.[1]?.slice(0, 7);

export function wikiItems(
  s: Api.Sources,
  snapshots: Record<string, { date: string; commit?: string }>,
  p: KnowledgePaths,
): Item[] {
  const file: Open = { kind: "file", path: join(p.root, s.path) };
  return [
    ...s.wikis.map((w) => {
      const snap = snapshots[w.id];
      return {
        id: `source:${w.id}`,
        label: w.id,
        description: `${w.type}${w.authority ? ` · ${w.authority}` : ""} · ${snap ? `snapshot ${snap.date}${snap.commit ? ` at ${snap.commit}` : ""}` : "not synced yet"}`,
        // ADR 0132: how much its word counts, and where it applies.
        tooltip: `${w.id}: ${w.type} at ${w.location}${w.spaces.length ? ` (${w.spaces.join(", ")})` : ""}${w.owner ? `, owned by ${w.owner}` : ""}.${w.authority ? ` Authority: ${w.authority}.` : ""} ${w.scope ? `Applies to ${w.scope}.` : "Applies to every task."}${snap ? ` Last copied on ${snap.date}${snap.commit ? `, at commit ${snap.commit}` : ""}.` : " Sync it to copy its pages."}`,
        icon: w.type === "git" ? "repo" : w.type === "markdown-folder" ? "folder-library" : "globe",
        open: file,
        context: "atticus.source",
        source: w.id,
      };
    }),
    ...s.absorbed.map((a) => ({
      id: `absorbed:${a.id}`,
      label: a.id,
      description: `absorbed · ${a.format}`,
      tooltip: a.url,
      icon: "repo-clone",
      open: file,
    })),
  ];
}

/** A row that runs a step when clicked: the first step of an empty part of the section. */
export const actionRow = (id: string, label: string, command: string, tooltip: string): Item => ({
  id,
  label,
  tooltip,
  icon:
    command === "atticus.searchWikis"
      ? "search"
      : command === "atticus.knowledgeScan"
        ? "sparkle"
        : "add",
  command: { command },
});

/** The Knowledge section's rows: sources, items, what the last scan changed, searches. */
export function knowledgeTop(o: {
  sourcesPath: string;
  sources: number;
  items: KnowledgeEntry[];
  problem?: string;
  report?: ScanReport;
  finds: FindSummary[];
}): Item[] {
  const reviewed = o.items.filter((i) => i.review && i.review.state !== "stale").length;
  const stale = o.items.filter((i) => i.review?.state === "stale").length;
  const rows: Item[] = [
    {
      id: "sources",
      label: `Sources (${o.sources})`,
      description: o.sourcesPath,
      tooltip:
        "The wikis and docs repos Atticus reads, from sources.yaml. Sync one to copy its pages; read it with Copilot to find what is on them.",
      icon: "library",
      expand: { kind: "sources" },
    },
    o.items.length
      ? {
          id: "knowledge-items",
          label: `Items (${o.items.length})`,
          description: [
            reviewed ? `${reviewed} reviewed` : "none reviewed yet",
            stale ? `${stale} to check again` : "",
          ]
            .filter(Boolean)
            .join(" · "),
          tooltip:
            "What the scan read from the pages, by kind: requests, standards, decisions, teams, vendors and products. Each quotes its page; a person verifies, corrects or rejects it.",
          icon: "book",
          expand: { kind: "knowledge-items" },
        }
      : actionRow(
          "knowledge-items",
          o.sources ? "No items yet: read the sources with Copilot" : "No items yet",
          o.sources ? "atticus.knowledgeScan" : "atticus.addWiki",
          o.problem ?? "Sync the sources, then read them with Copilot (atticus knowledge scan).",
        ),
  ];
  const r = o.report;
  const changed = r ? r.added.length + r.changed.length + r.removed.length : 0;
  if (r && (changed || stale))
    rows.push({
      id: "last-scan",
      label: "What the last scan changed",
      description: [
        day(r.at),
        [
          r.added.length ? `${r.added.length} new` : "",
          r.changed.length ? `${r.changed.length} changed` : "",
          r.removed.length ? `${r.removed.length} gone` : "",
        ]
          .filter(Boolean)
          .join(", "),
        stale ? `${stale} to check again` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      icon: "history",
      expand: { kind: "last-scan" },
    });
  rows.push({
    id: "finds",
    label: `Searches (${o.finds.length})`,
    tooltip:
      "Search every page of the wikis for a phrase: your assistant reads the pages it is on and says what is there that isn't an item yet, each quote checked. Keep what is right.",
    icon: "search",
    expand: { kind: "finds" },
  });
  return rows;
}

// ------------------------------------------------------------------ the last scan

export interface ScanReport {
  at: string;
  added: string[];
  changed: string[];
  removed: string[];
  snapshots: { source: string; date: string; pages: number }[];
}

/** What scan.yaml says the last scan changed, and the snapshots it read. */
export function scanReportFrom(y: unknown): ScanReport | undefined {
  if (!y || typeof y !== "object" || Array.isArray(y)) return undefined;
  const o = y as { scannedAt?: unknown; changes?: Record<string, unknown>; snapshots?: unknown };
  const c = o.changes && typeof o.changes === "object" ? o.changes : {};
  return {
    at: textOf(c.at) ?? textOf(o.scannedAt) ?? "",
    added: listOf(c.added),
    changed: listOf(c.changed),
    removed: listOf(c.removed),
    snapshots: (Array.isArray(o.snapshots) ? o.snapshots : []).flatMap((s: unknown) => {
      const x = s as { source?: unknown; date?: unknown; pages?: unknown };
      return typeof x?.source === "string"
        ? [{ source: x.source, date: String(x.date ?? ""), pages: Number(x.pages ?? 0) }]
        : [];
    }),
  };
}

/** New, changed and gone items, then the reviews to check again. */
export function lastScanItems(r: ScanReport, items: KnowledgeEntry[], p: KnowledgePaths): Item[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const row = (id: string, word: string, icon: string): Item => {
    const k = byId.get(id);
    return {
      id: `scan:${word}:${id}`,
      label: k ? itemTitle(k) : id,
      description: word,
      ...(k
        ? {
            tooltip: knowledgeTooltip(k),
            markdown: true,
            open: snapshotOpen(k, p),
            context: `atticus.knowledgeItem${urlsOf(k).length ? ".urls" : ""}`,
            knowledge: k,
          }
        : { tooltip: `${id} was on a page that changed or is gone; it isn't an item any more.` }),
      icon,
    };
  };
  return [
    ...r.added.map((id) => row(id, "new", "diff-added")),
    ...r.changed.map((id) => row(id, "changed", "diff-modified")),
    ...r.removed.map((id) => ({ ...row(id, "gone", "diff-removed") })),
    ...items
      .filter((i) => i.review?.state === "stale")
      .map((i) => ({ ...row(i.id, "check again", "warning"), color: "list.warningForeground" })),
  ];
}

// ------------------------------------------------------------------ a change's needs

/** What a need is for, in words: "the change", "story s-2". */
export const forWords = (t: string) => (t === "change" ? "the change" : t.replace(":", " "));

export function needDescription(n: NeedEntry): string {
  const parts = [`for ${forWords(n.for)}`, n.leadTime, n.handledBy].filter(Boolean);
  if (n.status === "done") parts.push(n.note ? `done: ${n.note}` : "done");
  if (n.status === "not-needed") parts.push(n.note ? `not needed: ${n.note}` : "not needed");
  if (n.verified) parts.push(`✓ ${n.verified}`);
  return parts.join(" · ");
}

export function needLook(n: NeedEntry): { icon: string; color?: string } {
  const icon =
    n.status === "done"
      ? "pass"
      : n.status === "not-needed"
        ? "circle-slash"
        : "circle-large-outline";
  return n.verified ? { icon, color: "testing.iconPassed" } : { icon };
}

const WHEN: Record<string, string> = {
  "before-design": "before the design",
  "before-build": "before it is built",
  "before-release": "before it is released",
};

export function needTooltip(n: NeedEntry): string {
  const blocks = [`**${md(n.title)}** · ${n.kind}, for ${forWords(n.for)}`, `Why: ${md(n.why)}`];
  if (n.because)
    blocks.push(
      `> ${md(n.because.quote)}\n\n${md(n.because.file)}${n.because.line ? `:${n.because.line}` : ""}`,
    );
  const fields = [
    n.when ? `When: ${WHEN[n.when] ?? n.when}` : "",
    n.leadTime ? `Lead time: ${md(n.leadTime)}` : "",
    n.handledBy ? `Handled by: ${md(n.handledBy)}` : "",
    n.catalogueItem ? `Catalogue item: ${md(n.catalogueItem)}` : "",
    n.inputs.length ? `It needs: ${n.inputs.map(md).join(", ")}` : "",
    linkLine(urlsOf(n)),
  ].filter(Boolean);
  if (fields.length) blocks.push(fields.join("  \n"));
  if (n.steps.length)
    blocks.push(`How:\n\n${n.steps.map((s, i) => `${i + 1}. ${md(s)}`).join("\n")}`);
  if (n.rules.length) blocks.push(`Rules:\n\n${n.rules.map((s) => `- ${md(s)}`).join("\n")}`);
  blocks.push(
    `Found by ${n.from === "stories" ? "the stories stage" : "your assistant"}${n.page ? `; read on ${md(n.page)}` : ""}.`,
  );
  if (n.verified) blocks.push(`✓ A person verified its knowledge item: ${md(n.verified)}.`);
  if (n.status !== "open")
    blocks.push(
      `${n.status === "done" ? "Done" : "Not needed"}${n.by ? `, by ${md(n.by)}` : ""}${n.at ? ` on ${day(n.at)}` : ""}${n.note ? `: ${md(n.note)}` : ""}`,
    );
  return blocks.join("\n\n");
}

/** The Needs row under a change: its open count, or the step that finds them. */
export function needsNode(change: string, needs: NeedEntry[] | undefined): Item {
  if (!needs)
    return {
      id: `needs:${change}`,
      label: "Find what it needs",
      description: "with Copilot",
      tooltip:
        "Your assistant reads the change and the knowledge items and says what it needs from the organisation: requests to raise, standards to follow, teams and vendors to involve. Atticus checks each against the change's own words (atticus change needs).",
      icon: "sparkle",
      command: { command: "atticus.findNeeds", args: [change] },
    };
  const open = needs.filter((n) => n.status === "open").length;
  return {
    id: `needs:${change}`,
    label: `Needs (${open ? `${open} open` : "none open"})`,
    tooltip: `What ${change} needs from the organisation: ${plural(needs.length, "need")}, ${open} open. Raise each, then mark it done.`,
    icon: open ? "inbox" : "pass",
    expand: { kind: "needs", change },
    context: "atticus.needs",
  };
}

/** The line of needs.md (1-based) where a need is written. */
export function needLine(text: string, n: NeedEntry): number | undefined {
  const lines = text.split(/\r?\n/);
  const named = (l: string) => l.includes(`**${n.title}**`) || l.includes(`~~${n.title}~~`);
  const target = `(${n.for === "change" ? "the whole change" : n.for.replace(":", " ")})`;
  let i = lines.findIndex((l) => /^- \[[ x]\] /.test(l) && named(l) && l.includes(target));
  if (i < 0) i = lines.findIndex((l) => /^- \[[ x]\] /.test(l) && named(l));
  return i < 0 ? undefined : i + 1;
}

const ORDER: Record<NeedEntry["status"], number> = { open: 0, done: 1, "not-needed": 2 };

/** A change's needs, open first, each opening needs.md at its line. */
export function needItems(needs: NeedEntry[], mdPath: string, mdText: string): Item[] {
  return [...needs]
    .sort((a, b) => ORDER[a.status] - ORDER[b.status])
    .map((n) => {
      const look = needLook(n);
      const line = needLine(mdText, n);
      return {
        id: `need:${n.change}:${n.item}:${n.for}`,
        label: n.title,
        description: needDescription(n),
        tooltip: needTooltip(n),
        markdown: true,
        icon: look.icon,
        ...(look.color ? { color: look.color } : {}),
        open: { kind: "file" as const, path: mdPath, ...(line ? { line } : {}) },
        context: `atticus.need.${n.status === "open" ? "open" : "closed"}${urlsOf(n).length ? ".urls" : ""}`,
        need: n,
      };
    });
}

export function needArgv(
  action: "done" | "skip" | "reopen",
  n: Pick<NeedEntry, "change" | "item" | "for">,
  note?: string,
): string[] {
  return [
    "needs",
    action,
    n.change,
    n.item,
    "--for",
    n.for,
    ...(note?.trim() ? ["--note", note.trim()] : []),
  ];
}

// ------------------------------------------------------------------ searching the wikis

export interface FindCandidate {
  id: string;
  kind: string;
  title: string;
  appliesWhen?: string;
  steps?: string[];
  urls?: Url[];
  page: string;
  section: string;
  quote: string;
  /** The knowledge item it already is. */
  known?: string;
  /** Who kept it, and as what, when a person kept it already. */
  kept?: { by: string; at: string; as: string };
}

export interface FindResult {
  status?: string;
  runId?: string;
  phrase: string;
  file?: string;
  pages: string[];
  candidates: FindCandidate[];
}

/** A saved search, as `atticus knowledge finds --json` lists it. */
export interface FindSummary {
  slug: string;
  phrase: string;
  at: string;
  candidates: number;
  kept: number;
  /** Its candidates, when the command line gives them (candidateList). */
  list?: FindCandidate[];
}

const keptOf = (v: unknown) => {
  const k = v as { by?: unknown; at?: unknown; as?: unknown } | undefined;
  return k && typeof k.by === "string"
    ? { by: k.by, at: String(k.at ?? ""), as: String(k.as ?? "") }
    : undefined;
};

/** A search's result from its file or its JSON, read defensively: what isn't whole is left out. */
export function findFrom(y: unknown): FindResult | undefined {
  if (!y || typeof y !== "object" || Array.isArray(y)) return undefined;
  const o = y as Record<string, unknown>;
  const cands = Array.isArray(o.candidates) ? o.candidates : [];
  return {
    ...(textOf(o.status) ? { status: o.status as string } : {}),
    ...(textOf(o.runId) ? { runId: o.runId as string } : {}),
    phrase: textOf(o.phrase) ?? "",
    ...(textOf(o.file) ? { file: o.file as string } : {}),
    pages: listOf(o.pages),
    candidates: cands.flatMap((c: unknown) => {
      const x = (c ?? {}) as Record<string, unknown>;
      const id = textOf(x.id);
      const kind = textOf(x.kind);
      if (!id || !kind) return [];
      const urls = urlsOf(x);
      return [
        {
          id,
          kind,
          title: textOf(x.title) ?? textOf(x.name) ?? id,
          ...(textOf(x.appliesWhen) ? { appliesWhen: x.appliesWhen as string } : {}),
          ...(listOf(x.steps).length ? { steps: listOf(x.steps) } : {}),
          ...(urls.length ? { urls } : {}),
          page: textOf(x.page) ?? "",
          section: textOf(x.section) ?? "",
          quote: textOf(x.quote) ?? "",
          ...(textOf(x.known) ? { known: x.known as string } : {}),
          ...(keptOf(x.kept) ? { kept: keptOf(x.kept)! } : {}),
        },
      ];
    }),
  };
}

/** A candidate in the pick list: picked already unless it is kept or a knowledge item already. */
export function candidatePick(c: FindCandidate): {
  label: string;
  description: string;
  detail: string;
  picked: boolean;
} {
  return {
    label: c.title,
    description: `${c.kind}${c.page ? ` · ${c.page}` : ""}${c.kept ? ` · kept as ${c.kept.as || c.kind} by ${c.kept.by}` : c.known ? ` · already known as ${c.known}` : ""}`,
    detail: c.quote ? `“${c.quote}”` : "",
    picked: !c.known && !c.kept,
  };
}

export function keepArgv(c: FindCandidate, slug: string, as?: string): string[] {
  return ["knowledge", "keep", c.id, "--find", slug, ...(as && as !== c.kind ? ["--as", as] : [])];
}

/** The newest saved search of a phrase (the one just run), matched without case. */
export const newestFind = (finds: FindSummary[], phrase: string) =>
  finds
    .filter((f) => f.phrase.trim().toLowerCase() === phrase.trim().toLowerCase())
    .sort((a, b) => b.at.localeCompare(a.at))[0];

/** The saved searches, newest first; each opens to what it found, and its Keep button keeps more. */
export function findItems(finds: FindSummary[]): Item[] {
  return [...finds]
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((f) => ({
      id: `find:${f.slug}`,
      label: `“${f.phrase}”`,
      description: `${f.candidates ? `${f.candidates} found · ${f.kept} kept` : "nothing found"} · ${day(f.at)}`,
      tooltip: `A search of the wikis for “${f.phrase}” on ${day(f.at)}: ${plural(f.candidates, "candidate")}, ${f.kept} kept. Open it to see what was found, new and already known; Keep… keeps the new ones.`,
      icon: "search",
      expand: { kind: "find", slug: f.slug },
      context: "atticus.find",
    }));
}

/** The kinds a found item can be kept as: its record's kinds, the kind found first (ADR 0101). */
const KEEP_PAIRS: [string, string][] = [
  ["request", "process"],
  ["standard", "pattern"],
  ["decision", "constraint"],
  ["team", "vendor"],
  ["product", "project"],
];
export function keepKinds(kind: string): string[] {
  const pair = KEEP_PAIRS.find((p) => p.includes(kind));
  return pair ? [kind, ...pair.filter((k) => k !== kind)] : [kind];
}

/** Each knowledge kind in a few plain words, for choosing what to keep a found item as. */
export const KIND_WORDS: Record<string, string> = {
  request: "a request to raise, with its form",
  process: "a process: the steps to achieve something",
  standard: "a standard to follow",
  pattern: "a pattern to use",
  decision: "a decision made",
  constraint: "a constraint to keep to",
  team: "a team",
  vendor: "a vendor",
  product: "a product",
  project: "a project",
};

const candOrder = (c: FindCandidate) => (c.kept ? 1 : c.known ? 2 : 0);

/** What a saved search found: new first (a click keeps one), then kept, then already known. */
export function candidateItems(slug: string, cands: FindCandidate[]): Item[] {
  return [...cands]
    .sort((a, b) => candOrder(a) - candOrder(b))
    .map((c) => {
      const links = linkLine(urlsOf(c));
      const tip = [
        `**${md(c.title)}** · ${c.kind}`,
        ...(c.quote ? [`> ${md(c.quote)}`] : []),
        ...(c.page
          ? [
              `From ${md(c.page)}${c.section ? `, ${md(c.section)}` : ""}. The quote was checked on the page.`,
            ]
          : []),
        ...(links ? [links] : []),
        c.kept
          ? `Kept as ${c.kept.as || c.kind} by ${md(c.kept.by)} on ${day(c.kept.at)}: it is a knowledge item, verified.`
          : c.known
            ? `Already a knowledge item: ${md(c.known)}.`
            : "New: not a knowledge item yet. Click to keep it; you choose what kind it is.",
      ];
      const base = {
        id: `cand:${slug}:${c.id}`,
        label: c.title,
        tooltip: tip.join("\n\n"),
        markdown: true,
      };
      if (c.kept)
        return {
          ...base,
          description: `✓ kept as ${c.kept.as || c.kind} by ${c.kept.by}`,
          icon: "pass-filled",
          color: "testing.iconPassed",
        };
      if (c.known) return { ...base, description: `already known as ${c.known}`, icon: "book" };
      return {
        ...base,
        description: `new · ${c.kind}${c.page ? ` · ${c.page}` : ""}`,
        icon: "sparkle",
        command: { command: "atticus.keepCandidate", args: [slug, c.id] },
        context: "atticus.findCandidate.new",
      };
    });
}
