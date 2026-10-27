import type { SourceScope } from "@maycombhq/core";
import type { PageRef, SupersededPage } from "./knowledge-scan.js";
import type { SnapshotManifest } from "./snapshot.js";
import type { KnowledgePage } from "./sources.js";

/**
 * Which page owns a topic two pages disagree on, by what the snapshot says about the pages, never
 * a model's pick (ADR 0124 addendum B-task-knowledge). The knowledge reader extracts an item "from
 * the page that owns it"; these signals check that pick deterministically, in this order, and the
 * first that tells the pages apart suggests the page (a person still decides, conflicts.ts):
 *
 * 1. replaces: one page says it replaces the other (a superseded page the scan recorded);
 * 2. owner: one page's owner (its front matter or an "Owner:" line, else its source's owner in
 *    sources.yaml) is the team that handles the item;
 * 3. source-kind: the pages are in different sources and one source is tagged with the item's kind;
 * 4. space: one page is in the space of the team that handles the item (front matter `space`, else
 *    the page's folder);
 * 5. last-edited: both pages give a last-edited date, and one is later.
 *
 * Either way the conflict is a question for a person, never a silent pick; the signal's page is
 * named in it as suggested.
 */

export type OwnerSignal =
  | "replaces"
  | "owner"
  | "source-kind"
  | "space"
  | "last-edited"
  // ADR 0132, read from sources.yaml and the pages when the conflict is shown (standing.ts):
  | "status"
  | "exception"
  | "authority";

export interface ConflictOwner extends PageRef {
  signal: OwnerSignal;
  /** What the signal read, in words: "b.md says it replaces a.md". */
  detail: string;
  /** An exception: where it applies (its source's appliesTo); everywhere when left out. */
  scope?: SourceScope;
  /** An exception: the page suggested outside its scope. */
  otherwise?: ConflictOwner;
}

/** What the signals read about one page of a conflict. */
export interface PageFacts extends PageRef {
  /** Its source's owner in sources.yaml, as kept with the snapshot. */
  sourceOwner?: string;
  /** Its source's tagged kinds in sources.yaml. */
  sourceKinds: string[];
  /** The page's own owner: front matter `owner`, or an "Owner:" line. */
  pageOwner?: string;
  /** The page's space: front matter `space`, else the folder the page is in. */
  space?: string;
  /** When the page was last edited, when the snapshot says (YYYY-MM-DD). */
  date?: string;
}

const dateOnly = (v: unknown): string | undefined => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v !== "string") return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  return m && !Number.isNaN(Date.parse(m[1]!)) ? m[1] : undefined;
};

/** A page's facts from its snapshot. */
export function pageFacts(p: KnowledgePage, m: SnapshotManifest): PageFacts {
  const fm = p.frontMatter;
  const space =
    typeof fm.space === "string" && fm.space.trim()
      ? fm.space.trim()
      : p.pagePath.includes("/")
        ? p.pagePath.split("/").slice(0, -1).join("/")
        : undefined;
  const date = p.date ?? dateOnly(fm["last-updated"]) ?? dateOnly(fm["last-edited"]);
  return {
    source: p.source,
    page: p.pagePath,
    ...(m.owner ? { sourceOwner: m.owner } : {}),
    sourceKinds: m.tags.kinds,
    ...(p.owner ? { pageOwner: p.owner } : {}),
    ...(space ? { space } : {}),
    ...(date ? { date } : {}),
  };
}

/** A team's words that name it: lower case, "team" and "the" left out. */
const teamWords = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && w !== "team" && w !== "the" && w !== "squad");

/** Whether two names are the same team: every word of one is in the other. */
function sameTeam(a: string, b: string): boolean {
  const x = teamWords(a);
  const y = new Set(teamWords(b));
  if (!x.length || !y.size) return false;
  return x.every((w) => y.has(w)) || [...y].every((w) => x.includes(w));
}

/** The words a source tag uses for a knowledge kind, singular: a plural tag matches too. */
const KIND_WORDS: Record<string, string[]> = {
  process: ["process", "runbook"],
  request: ["request", "catalogue", "catalog"],
  decision: ["decision", "adr"],
};

/** A tag word in the singular: processes → process, standards → standard. */
const singular = (w: string) =>
  w.endsWith("sses") ? w.slice(0, -2) : w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;

const tagged = (kinds: string[], kind: string) =>
  kinds.some((t) =>
    t
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .some((w) => (KIND_WORDS[kind] ?? [kind]).includes(singular(w))),
  );

const same = (a: PageRef, b: PageRef) => a.source === b.source && a.page === b.page;
const name = (p: PageRef, all: PageRef[]) =>
  all.some((x) => x.page === p.page && x.source !== p.source) ? `${p.source}/${p.page}` : p.page;

/** The one page a test picks out, when exactly one passes it. */
function one(facts: PageFacts[], test: (f: PageFacts) => boolean): PageFacts | undefined {
  const hits = facts.filter(test);
  return hits.length === 1 && hits.length < facts.length ? hits[0] : undefined;
}

/**
 * The page that owns the conflict's topic, and the signal that says so; undefined when no signal
 * tells the pages apart. `item` is what the conflict is about: its knowledge kind and the team that
 * handles it, when the item says.
 */
export function conflictOwner(
  c: { pages: PageRef[] },
  facts: PageFacts[],
  item: { kind?: string; handledBy?: string },
  superseded: SupersededPage[] = [],
): ConflictOwner | undefined {
  const pages = c.pages;
  const of = pages.map(
    (p) => facts.find((f) => same(f, p)) ?? { source: p.source, page: p.page, sourceKinds: [] },
  );
  if (of.length < 2) return undefined;
  const pick = (f: PageFacts, signal: OwnerSignal, detail: string): ConflictOwner => ({
    source: f.source,
    page: f.page,
    signal,
    detail,
  });

  // 1. A page that says it replaces the other.
  for (const s of superseded) {
    const n = of.find((f) => same(f, s.new));
    const o = of.find((f) => same(f, s.old));
    if (n && o && n !== o)
      return pick(n, "replaces", `${name(n, of)} says it replaces ${name(o, of)}`);
  }
  // 2. The page whose owner is the team that handles the item.
  const team = item.handledBy?.trim();
  if (team) {
    const ownerOf = (f: PageFacts) => f.pageOwner ?? f.sourceOwner;
    const hit = one(of, (f) => !!ownerOf(f) && sameTeam(ownerOf(f)!, team));
    if (hit)
      return pick(
        hit,
        "owner",
        `${name(hit, of)}'s owner is ${ownerOf(hit)}${hit.pageOwner ? "" : ` (its source, ${hit.source})`}, the team that handles it`,
      );
  }
  // 3. The one source tagged with the item's kind.
  const kind = item.kind;
  if (kind && new Set(of.map((f) => f.source)).size === of.length) {
    const hit = one(of, (f) => tagged(f.sourceKinds, kind));
    if (hit) return pick(hit, "source-kind", `${hit.source} is tagged as the source of ${kind}s`);
  }
  // 4. The page in the space of the team that handles it.
  if (team) {
    const hit = one(of, (f) => !!f.space && sameTeam(f.space.replace(/[/_-]+/g, " "), team));
    if (hit) return pick(hit, "space", `${name(hit, of)} is in ${team}'s space (${hit.space})`);
  }
  // 5. The page edited last, when every page says when.
  if (of.every((f) => f.date)) {
    const sorted = [...of].sort((a, b) => b.date!.localeCompare(a.date!));
    if (sorted[0]!.date !== sorted[1]!.date) {
      const top = sorted[0]!;
      const rest = sorted.slice(1).map((f) => `${name(f, of)} (${f.date})`);
      return pick(
        top,
        "last-edited",
        `${name(top, of)} was last edited ${top.date}, after ${rest.join(" and ")}`,
      );
    }
  }
  return undefined;
}
