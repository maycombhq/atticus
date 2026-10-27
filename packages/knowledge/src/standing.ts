import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  authorityRank,
  orgPackDirOf,
  pageStanding,
  platformsMatch,
  Sources,
  type PageSignals,
  type PageStanding,
  type SourceScope,
} from "@maycombhq/core";
import type { KnowledgePage, WikiSource } from "./sources.js";

/**
 * What a page's word counts for, and where it applies (ADR 0132): its source's settings in
 * sources.yaml, read where they are (a change to sources.yaml applies without a new sync), and
 * what the page says of itself. Used by the sync (which page of a mirror is read), the conflicts
 * (which page is suggested) and each task's knowledge (which page leads a topic, and whether a
 * scoped source's page applies at all).
 */

export type SourceSettings = Map<string, WikiSource>;

const cache = new Map<string, { key: string; settings: SourceSettings }>();

/** Each source's settings by id, from the org pack's sources.yaml; none when it can't be read. */
export function readSourceSettings(root: string): SourceSettings {
  const file = join(orgPackDirOf(root), "sources.yaml");
  let key = "none";
  try {
    const s = statSync(file);
    key = `${s.mtimeMs}:${s.size}`;
  } catch {
    // no sources.yaml
  }
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.settings;
  const settings: SourceSettings = new Map();
  try {
    const r = Sources.safeParse(parse(readFileSync(file, "utf8")));
    if (r.success) for (const w of r.data.wikis) settings.set(w.id, w);
  } catch {
    // not readable: every source as a team's, everywhere
  }
  cache.set(file, { key, settings });
  return settings;
}

const strList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map(String)
    : typeof v === "string"
      ? v
          .split(/[;,]/)
          .map((x) => x.trim())
          .filter(Boolean)
      : [];

const dateOf = (v: unknown): string | undefined => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v !== "string") return undefined;
  return /^(\d{4}-\d{2}-\d{2})/.exec(v.trim())?.[1];
};

/** What a page says of itself: its labels, status, space's status, review date and text. */
export function pageSignalsOf(
  p: Pick<KnowledgePage, "frontMatter" | "date" | "text">,
): PageSignals {
  const fm = p.frontMatter;
  const labels = [...strList(fm.labels), ...strList(fm.tags)];
  const status = typeof fm.status === "string" ? fm.status : undefined;
  const space = fm["space-status"] ?? fm.spaceStatus;
  const reviewed = dateOf(fm.reviewed) ?? dateOf(fm["last-reviewed"]) ?? p.date;
  return {
    ...(labels.length ? { labels } : {}),
    ...(status ? { status } : {}),
    ...(typeof space === "string" ? { spaceStatus: space } : {}),
    ...(reviewed ? { updated: reviewed } : {}),
    ...(p.text ? { text: p.text } : {}),
  };
}

/** A page's standing as its source's settings and the page say (now: for the review age). */
export function pageStandingOf(
  p: Pick<KnowledgePage, "source" | "pagePath" | "frontMatter" | "date" | "text">,
  settings: SourceSettings,
  now?: string,
): PageStanding {
  return pageStanding(settings.get(p.source) ?? {}, p.pagePath, pageSignalsOf(p), now);
}

/** The page's words, front matter and markup aside: two pages with the same key are one page. */
export function bodyKey(text: string): { key: string; words: number } {
  const body = text.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "");
  const words = body.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return { key: createHash("sha256").update(words.join(" ")).digest("hex"), words: words.length };
}

/** A page under view restrictions: front matter `restricted: true`, or `restrictions` it lists. */
export function pageRestricted(fm: Record<string, unknown>): boolean {
  if (
    fm.restricted === true ||
    (typeof fm.restricted === "string" && /^(true|yes)$/i.test(fm.restricted))
  )
    return true;
  const r = fm.restrictions ?? fm["view-restrictions"];
  return (
    (Array.isArray(r) && r.length > 0) ||
    (typeof r === "string" && r.trim() !== "" && !/^none$/i.test(r))
  );
}

/** An authority in words, for a suggestion: "a standard", "a team's page". */
export const authorityWords: Record<string, string> = {
  standard: "a standard",
  platform: "a platform team's guidance",
  framework: "a framework's own documentation",
  team: "a team's page",
  reference: "reference material",
};

export { authorityRank };

/** A scope in words: "components forge-stock; platforms gcp; new components". */
export function scopeWords(s: SourceScope | undefined): string {
  if (!s) return "everywhere";
  const parts = [
    ...(s.systems?.length ? [`systems ${s.systems.join(", ")}`] : []),
    ...(s.components?.length ? [`components ${s.components.join(", ")}`] : []),
    ...(s.platforms?.length ? [`platforms ${s.platforms.join(", ")}`] : []),
    ...(s.repoTypes?.length ? [`repo types ${s.repoTypes.join(", ")}`] : []),
    ...(s.frameworks?.length ? [`frameworks ${s.frameworks.join(", ")}`] : []),
    ...(s.newComponents ? ["new components"] : []),
  ];
  return parts.join("; ");
}

const APPROVAL = /\b(?:WVR|WAIVER|EXC|EXCEPTION|ADR|RISK|RA)[- ]?\d{2,}\b/i;

/**
 * An approved exception a page records to another page (ADR 0132): the page says "exception" or
 * "waiver", gives an approval (an ADR, waiver or exception id, or "approved by"), and names the
 * other page by its title or its path. The approval's id, or the "approved by" words.
 */
export function exceptionTo(
  text: string,
  other: { page: string; source: string; title?: string },
): string | undefined {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  if (!/\b(?:exception|waiver|waived)\b/i.test(body)) return undefined;
  const ref = APPROVAL.exec(body)?.[0] ?? (/\bapproved by\b[^.\n]*/i.exec(body)?.[0] || undefined);
  if (!ref) return undefined;
  const low = body.toLowerCase();
  const names = [
    other.title,
    other.page,
    other.page.replace(/\.(md|markdown)$/i, ""),
    `${other.source}/${other.page}`,
  ].filter((n): n is string => !!n && n.trim().length > 3);
  return names.some((n) => low.includes(n.toLowerCase())) ? ref : undefined;
}

/**
 * The places a task works in, for a source's scope (ADR 0132): where its code is (its components,
 * their systems, where they run, their repos' types and frameworks), what it calls (components
 * and their systems), and the components it creates, which only the target state has. Each value
 * (lower case) maps to the words that say where it comes from: "forge-orders runs on openshift".
 */
export interface ScopePlaces {
  components: Map<string, string>;
  systems: Map<string, string>;
  platforms: Map<string, string>;
  repoTypes: Map<string, string>;
  frameworks: Map<string, string>;
  /** What the task calls: a scope's systems and components take these in too. */
  calls: { components: Map<string, string>; systems: Map<string, string> };
  /** Components the task creates that the catalog doesn't have yet. */
  creates: string[];
}

export const emptyPlaces = (): ScopePlaces => ({
  components: new Map(),
  systems: new Map(),
  platforms: new Map(),
  repoTypes: new Map(),
  frameworks: new Map(),
  calls: { components: new Map(), systems: new Map() },
  creates: [],
});

/**
 * Whether a source's scope takes in a task's places, and the first match in words ("platforms
 * openshift: forge-orders runs on openshift"); undefined when it doesn't. A source with no scope
 * applies everywhere: the caller doesn't ask. Any dimension the scope names may match: a scope
 * is where its pages apply, so a platform's guidance applies to a component on that platform and,
 * with `newComponents`, to a task that creates one.
 */
export function scopeMatch(scope: SourceScope, places: ScopePlaces): string | undefined {
  const low = (s: string) => s.trim().toLowerCase();
  const inMap = (dim: string, wanted: string[] | undefined, ...maps: Map<string, string>[]) => {
    for (const w of wanted ?? [])
      for (const m of maps) {
        const why = m.get(low(w));
        if (why) return `${dim} ${w}: ${why}`;
      }
    return undefined;
  };
  const platform = () => {
    for (const w of scope.platforms ?? []) {
      const hit = platformsMatch([w], [...places.platforms.keys()]);
      if (hit) return `platforms ${w}: ${places.platforms.get(hit)}`;
    }
    return undefined;
  };
  return (
    inMap("components", scope.components, places.components, places.calls.components) ??
    inMap("systems", scope.systems, places.systems, places.calls.systems) ??
    (scope.newComponents && places.creates.length
      ? `new components: this task creates ${places.creates.join(", ")}`
      : undefined) ??
    platform() ??
    inMap("repo types", scope.repoTypes, places.repoTypes) ??
    inMap("frameworks", scope.frameworks, places.frameworks)
  );
}
