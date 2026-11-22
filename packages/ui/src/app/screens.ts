import { COPY } from "../copy.js";

/**
 * The app's map (the product owner's Surfaces design; ADR 0119 before it, plan 4.5, B1 and ADR
 * 0105). Six entries: Home (one page: what needs you, then the estate and the changes in flight),
 * Map (the map, its flows and its read status), Change (every change, one at a glance, then a tab
 * per stage), Questions (everything open), Knowledge (the org's wikis and documents, cited) and
 * Set up (what the files hold, as forms, and Activity). The app shows files and asks questions; it
 * runs no scans, model calls or git.
 *
 * Every other page is under More pages, at the bottom of the menu (the D-app addendum's
 * follow-up, 2026-10-25: hidden behind `atticus ui --full` they were too hard to find, and seeing
 * what the AI was asked is part of trusting it), grouped by section, and Ctrl+K finds every page.
 * With `atticus ui --full` More pages starts open and every page is a tab of its section too.
 *
 * v30 slice 8 (fewer pages): the Map keeps Map, Flows and Read status; Contracts, Impact and
 * Decided by AI open from a box's panel, for that box. Model runs, Prompt history, Scans and
 * Catalog builds are the tabs of one Activity page. The Ecosystem map, a second drawing of the
 * Map, is gone: its address opens the Map, and its coverage and guides are on Systems. A page folded away keeps its address
 * (MOVED), which opens its new place, so every bookmark and editor link still works.
 */

export const SECTIONS = ["Home", "Map", "Change", "Questions", "Knowledge", "SetUp"] as const;
/** Every section a page belongs to: the six, then Atticus's own pages (under More pages). */
export const FULL_SECTIONS = [...SECTIONS, "Atticus"] as const;
export type Section = (typeof FULL_SECTIONS)[number];

/** The phases a change's pages are grouped by, within Change (More pages, and the tabs with --full). */
export const PHASES = ["Define", "Design", "Plan", "Build", "Release"] as const;
export type Phase = (typeof PHASES)[number];

export interface ScreenDef {
  id: string;
  label: string;
  section: Section;
  /** Within Change: the phase the page belongs to (the tabs are grouped by it with --full). */
  group?: Phase;
  /** A page out of the tabs: the tab it is a part of. */
  under?: string;
  /**
   * A page of the six reached by a link from another (a change's picture, the Ask page, a
   * system's page, the words, the first steps): not a tab, but in Ctrl+K. A tab with --full.
   */
  aside?: true;
  /** Under More pages: not a tab of its section unless the app runs with `atticus ui --full`. */
  full?: true;
  /** Other words Ctrl+K finds the page by: the names of pages merged into it. */
  also?: readonly string[];
}

const N = COPY.nav;
const S = COPY.nav.screens;
const K = COPY.knowledge.nav;
/** The names pages had before v30 slice 8: Ctrl+K still finds a page by them. */
const F = COPY.nav.formerly;

export const SCREENS: ScreenDef[] = [
  // Home: one page (the product owner, 2026-10-24): what needs you, then the estate and the
  // changes in flight. The Overview is merged into it; its address opens Home (OLD_ADDRESSES).
  {
    id: "home",
    label: S.home,
    section: "Home",
    also: [COPY.commandCenter.waitingOnYou, N.dashboard],
  },
  // The words, from the link beside Help.
  { id: "words", label: S.words, section: "Home", aside: true },
  // Seventh UX walk: pages across every change sit with Home, whose Waiting on you counts the
  // manual steps; under Map or Change they showed tabs they aren't part of.
  { id: "initiatives", label: S.initiatives, section: "Home", full: true },
  // ADR 0188: the daily pages are tabs of their sections by default, not only under More pages.
  { id: "todo", label: S.todo, section: "Home" },

  // Map: the estate drawn, its flows, and how far each repo was read (v30 slice 8: three tabs).
  { id: "canvas", label: S.canvas, section: "Map", also: [F.canvas, F.map] },
  { id: "flows", label: COPY.flows.title, section: "Map" },
  { id: "trust", label: S.trust, section: "Map", also: [F.trust] },
  // v30 slice 8: about one box, so opened from its panel (for that box); the estate-wide page is
  // under More pages, and Ctrl+K finds it.
  { id: "contracts", label: S.contracts, section: "Map", full: true },
  { id: "impact", label: S.impact, section: "Map", full: true, also: [F.impact] },
  // ADR 0181: what the AI decided (Read status audits it): Correct, and each batch's Undo.
  {
    id: "decisions",
    label: S.decisions,
    section: "Map",
    full: true,
    also: [COPY.decisions.chip, COPY.decisions.batchesTitle],
  },
  // Ask (the box at the top), and a system's page (WP7.7).
  { id: "explore", label: S.explore, section: "Map", aside: true },
  { id: "systems", label: S.systems, section: "Map", aside: true },
  // O4 (ADR 0149): one page per system outside the estate, linked from Systems.
  { id: "outside", label: S.outside, section: "Map", aside: true },
  // F7 (ADR 0164): the contract check on every link, linked from Trust and Why is this linked?.
  { id: "mismatches", label: S.mismatches, section: "Map", aside: true },
  // ADR 0195 (CS3): the readers' cross-check, linked from Read status and Scans.
  { id: "crosscheck", label: S.crosscheck, section: "Map", aside: true, also: [F.crosscheck] },
  { id: "features", label: S.features, section: "Map", full: true },
  { id: "mappings", label: S.mappings, section: "Map", full: true },
  { id: "diagrams", label: S.diagrams, section: "Map", full: true },
  { id: "reconcile", label: S.reconcile, section: "Map", full: true },

  // Change: every change, one at a glance, then a tab per stage (the product owner, 2026-10-24).
  { id: "changes", label: S.changes, section: "Change" },
  // WP7.1: one change at a glance.
  { id: "cockpit", label: S.cockpit, section: "Change", group: "Define" },
  // ADR 0191 (app-only audit): the brief is a tab of a change ("Write the brief on Feature brief"
  // pointed under More pages).
  { id: "brief", label: S.brief, section: "Change", group: "Define" },
  { id: "ux", label: S.ux, section: "Change", group: "Define", full: true },
  { id: "feature-design", label: N.feature, section: "Change", group: "Define" },
  // 2026-10-27: the knowledge attached to a change, on its own page (it was only at the foot of
  // Feature, where the product owner couldn't find it). In Define: the feature stage is the first
  // that picks it, and it is confirmed or excluded before Design; later stages and tasks add to it.
  {
    id: "change-knowledge",
    label: S.changeKnowledge,
    section: "Change",
    group: "Define",
    also: [COPY.changeKnowledge.title],
  },
  { id: "architecture", label: N.architecture, section: "Change", group: "Design" },
  { id: "arch-review", label: S.archReview, section: "Change", group: "Design", full: true },
  // ADR 0108: a change's picture, from its target flows (linked from Architecture).
  { id: "change-diagram", label: S.changeDiagram, section: "Change", group: "Design", aside: true },
  { id: "stories", label: N.stories, section: "Change", group: "Plan" },
  { id: "breakdown", label: S.breakdown, section: "Change", group: "Plan", full: true },
  // ADR 0109: a change's estimate, from its target flows.
  { id: "estimate", label: S.estimate, section: "Change", group: "Plan", full: true },
  { id: "task-list", label: N.tasks, section: "Change", group: "Build" },
  { id: "tasks", label: S.tasks, section: "Change", group: "Build", full: true },
  // ADR 0114: does the code do what the design says?
  { id: "conformance", label: S.conformance, section: "Change", group: "Build", full: true },
  { id: "trace", label: S.trace, section: "Change", group: "Build", full: true },
  { id: "release", label: S.release, section: "Change", group: "Release" },
  { id: "service-desk", label: S.serviceDesk, section: "Change", group: "Release", full: true },

  // Questions: everything open, across repos and changes, with evidence.
  { id: "questions", label: COPY.questions.title, section: "Questions" },

  // Knowledge (ADR 0102): the items, the wikis they come from, the files dropped in, searching.
  { id: "knowledge", label: K.items, section: "Knowledge" },
  { id: "wikis", label: K.sources, section: "Knowledge" },
  { id: "documents", label: K.documents, section: "Knowledge" },
  { id: "wiki-search", label: K.search, section: "Knowledge" },
  { id: "parties", label: K.parties, section: "Knowledge", full: true },
  { id: "orgpack-draft", label: K.orgpack, section: "Knowledge", full: true },

  // Set up: what the files hold, as forms.
  { id: "repos", label: S.repos, section: "SetUp" },
  // ADR 0121: how AI runs here, chosen in a form.
  { id: "ai", label: S.ai, section: "SetUp" },
  // v30 slice 8: what ran, as one page with a tab each: what Atticus asked a model and what came
  // back (ADR 0106), what people asked their assistant (ADR 0110), the scans, and the catalog's
  // builds (ADR 0195). Beside how AI runs here: the first place a person looking for "what was
  // the AI asked" opens (2026-10-25).
  // Ctrl+K offers each tab by its name too (activityItems in palette.tsx).
  { id: "activity", label: S.activity, section: "SetUp" },
  { id: "orgpack", label: S.orgpack, section: "SetUp" },
  // Seventh UX walk: the org pack's checks, beside the org pack.
  { id: "governance", label: S.governance, section: "SetUp", full: true },
  // The first steps, from Home's next step.
  { id: "onboarding", label: N.onboarding, section: "SetUp", aside: true },
  { id: "intake", label: S.intake, section: "SetUp", full: true },
  { id: "settings", label: S.settings, section: "SetUp", full: true },

  // Atticus itself, under More pages: its quality and what it learned.
  { id: "evals", label: S.evals, section: "Atticus", full: true },
  { id: "learning", label: S.learning, section: "Atticus", full: true },
];

/** A section's name as the menu shows it. */
export const sectionLabel = (s: Section): string => N.sections[s];

/** A phase's name, as a group of a change's pages. */
export const groupLabel = (g: Phase): string => N.groups[g];

/**
 * The tabs of a section, in order: every page of it but those that are part of another; without
 * --full, only the six's own tabs (no page under More pages, no page reached by a link).
 */
export const tabsOf = (s: Section, full = false): ScreenDef[] =>
  SCREENS.filter((x) => x.section === s && !x.under && (full || (!x.full && !x.aside)));

/** Where a section opens: its first tab. */
export const landingOf = (s: Section, full = false): ScreenDef => tabsOf(s, full)[0]!;

/** One section's pages under More pages; Change's grouped by phase too. */
export interface MoreGroup {
  section: Section;
  pages: ScreenDef[];
  phases?: { phase: Phase; pages: ScreenDef[] }[];
}

/**
 * More pages, at the bottom of the menu: every page the six entries' tabs don't show, by section
 * in the menu's order (Map's, Change's by phase, Knowledge's, Set up's, then Atticus's own).
 */
export function morePages(): MoreGroup[] {
  return FULL_SECTIONS.flatMap((section): MoreGroup[] => {
    const pages = SCREENS.filter((s) => s.section === section && s.full);
    if (!pages.length) return [];
    if (section !== "Change") return [{ section, pages }];
    const phases = PHASES.map((phase) => ({
      phase,
      pages: pages.filter((s) => s.group === phase),
    })).filter((g) => g.pages.length);
    return [{ section, pages: phases.flatMap((g) => g.pages), phases }];
  });
}

/** The tabs of the Activity page, by the address each had as a page of its own. */
export const ACTIVITY_TABS = ["runs", "history", "scans", "catalog-builds"] as const;
export type ActivityTab = (typeof ACTIVITY_TABS)[number];

/** Each Activity tab's name: the name of the page it was before v30 slice 8. */
export const ACTIVITY_LABELS: Readonly<Record<ActivityTab, string>> = {
  runs: S.runs,
  history: S.history,
  scans: S.scans,
  "catalog-builds": S.catalogBuilds,
};

/**
 * v30 slice 8: pages folded into another. The old address is rewritten to the new place (its
 * query kept), so a bookmark, an editor's link or an old link in a page still opens it.
 */
export const MOVED: Readonly<Record<string, { to: string; tab?: ActivityTab }>> = {
  runs: { to: "activity", tab: "runs" },
  history: { to: "activity", tab: "history" },
  scans: { to: "activity", tab: "scans" },
  "catalog-builds": { to: "activity", tab: "catalog-builds" },
  // The Ecosystem map drew the Map a second time: its address opens the Map (Ctrl+K finds the
  // Map by its old name too); its coverage and system guides are on Systems.
  map: { to: "canvas" },
};

/**
 * Addresses of pages merged into another: the old address opens the page it is part of now, so
 * every bookmark and editor link still works. The Overview is part of Home (2026-10-24).
 */
export const OLD_ADDRESSES: Readonly<Record<string, string>> = {
  dashboard: "home",
  ...Object.fromEntries(Object.entries(MOVED).map(([from, m]) => [from, m.to])),
};

/** The address a moved page's old address opens now, its query kept; undefined if it didn't move. */
export function movedHash(hash: string): string | undefined {
  const path = hash.replace(/^#\/?/, "");
  const [id = "", ...rest] = path.split("?");
  const m = MOVED[id];
  if (!m) return undefined;
  const query = rest.join("?");
  const parts = [m.tab ? `tab=${m.tab}` : "", query].filter(Boolean).join("&");
  return `#/${m.to}${parts ? `?${parts}` : ""}`;
}

/** An Activity tab's address, with its own query (`activityHref("runs", { run })`). */
export function activityHref(tab: ActivityTab, query: Record<string, string | undefined> = {}) {
  const q = new URLSearchParams({ tab });
  for (const [k, v] of Object.entries(query)) if (v) q.set(k, v);
  return `#/activity?${q.toString()}`;
}

/**
 * A page's title, for the window, its heading and where-you-are: its name, and on Activity the
 * tab shown too ("Activity › Scans", WCAG 2.4.2).
 */
export function pageTitle(s: ScreenDef, hash: string): string {
  return s.id === "activity" ? `${s.label} › ${ACTIVITY_LABELS[activityTabOf(hash)]}` : s.label;
}

/** The Activity tab an address shows: its `?tab=`, else the old page's own address, else runs. */
export function activityTabOf(hash: string): ActivityTab {
  const asked = hashParam(hash, "tab") ?? hash.replace(/^#\/?/, "").split(/[/?]/)[0];
  return (ACTIVITY_TABS as readonly string[]).includes(asked ?? "")
    ? (asked as ActivityTab)
    : "runs";
}

/** The page a hash opens; an unknown one opens Home. */
export function screenOf(hash: string): ScreenDef {
  const asked = hash.replace(/^#\/?/, "").split(/[/?]/)[0] || "home";
  const id = OLD_ADDRESSES[asked] ?? asked;
  return SCREENS.find((s) => s.id === id) ?? SCREENS[0]!;
}

/** One value of an address's query (`#/trust?repo=forge-ledger`), or undefined. */
export function hashParam(hash: string, name: string): string | undefined {
  return new URLSearchParams(hash.split("?")[1] ?? "").get(name) ?? undefined;
}

/**
 * The change a page is about, from its address (`?change=` or `#/changes/<id>`), so moving between
 * a change's tabs keeps the change.
 */
export function changeOf(hash: string): string | undefined {
  const path = hash.replace(/^#\/?/, "");
  const m = /^changes\/([^/?]+)/.exec(path);
  if (m) {
    // A hash someone typed or mangled (#/changes/100%) is a name, never a blank page.
    try {
      return decodeURIComponent(m[1]!);
    } catch {
      return m[1];
    }
  }
  return hashParam(path, "change");
}

/** A tab's address: a change's pages keep the change they are about. */
export function tabHref(s: ScreenDef, change: string | undefined): string {
  if (s.section !== "Change" || !change) return `#/${s.id}`;
  if (s.id === "changes") return `#/changes/${encodeURIComponent(change)}`;
  return `#/${s.id}?change=${encodeURIComponent(change)}`;
}
