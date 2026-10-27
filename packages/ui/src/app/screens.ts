import { COPY } from "../copy.js";

/**
 * The app's map (the product owner's Surfaces design; ADR 0119 before it, plan 4.5, B1 and ADR
 * 0105). Six entries: Home (one page: what needs you, then the estate and the changes in flight),
 * Map (the estate, its flows, contracts, impact and how far to trust it), Change (every change,
 * one at a glance, then a tab per stage), Questions (everything open), Knowledge (the org's wikis
 * and documents, cited) and Set up (what the files hold, as forms). The app shows files and asks
 * questions; it runs no scans, model calls or git.
 *
 * Every other page is under More pages, at the bottom of the menu (the D-app addendum's
 * follow-up, 2026-10-25: hidden behind `atticus ui --full` they were too hard to find, and seeing
 * what the AI was asked is part of trusting it), grouped by section, and Ctrl+K finds every page.
 * With `atticus ui --full` More pages starts open and every page is a tab of its section too.
 * Model runs is a tab of Set up, beside AI. No route is removed or renamed, so every old address
 * still opens its page.
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

  // Map: the estate drawn, its flows, contracts, what breaks, and how far to trust it.
  { id: "canvas", label: S.canvas, section: "Map" },
  { id: "flows", label: COPY.flows.title, section: "Map" },
  { id: "contracts", label: S.contracts, section: "Map" },
  { id: "impact", label: S.impact, section: "Map" },
  { id: "trust", label: S.trust, section: "Map" },
  // Ask (the box at the top), and a system's page (WP7.7).
  { id: "explore", label: S.explore, section: "Map", aside: true },
  { id: "systems", label: S.systems, section: "Map", aside: true },
  { id: "map", label: S.map, section: "Map", full: true },
  { id: "features", label: S.features, section: "Map", full: true },
  { id: "mappings", label: S.mappings, section: "Map", full: true },
  { id: "diagrams", label: S.diagrams, section: "Map", full: true },
  { id: "reconcile", label: S.reconcile, section: "Map", full: true },
  { id: "governance", label: S.governance, section: "Map", full: true },
  { id: "initiatives", label: S.initiatives, section: "Map", full: true },

  // Change: every change, one at a glance, then a tab per stage (the product owner, 2026-10-24).
  { id: "changes", label: S.changes, section: "Change" },
  // WP7.1: one change at a glance.
  { id: "cockpit", label: S.cockpit, section: "Change", group: "Define" },
  { id: "brief", label: S.brief, section: "Change", group: "Define", full: true },
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
  { id: "todo", label: S.todo, section: "Change", group: "Build", full: true },
  { id: "release", label: S.release, section: "Change", group: "Release", full: true },
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
  // What Atticus asked a model and what came back (ADR 0106), beside how AI runs here: the first
  // place a person looking for "what was the AI asked" opens (2026-10-25).
  { id: "runs", label: S.runs, section: "SetUp" },
  { id: "orgpack", label: S.orgpack, section: "SetUp" },
  // The first steps, from Home's next step.
  { id: "onboarding", label: N.onboarding, section: "SetUp", aside: true },
  { id: "scans", label: S.scans, section: "SetUp", full: true },
  { id: "intake", label: S.intake, section: "SetUp", full: true },
  { id: "settings", label: S.settings, section: "SetUp", full: true },

  // Atticus itself, under More pages: what people asked their assistant (ADR 0110), its quality
  // and what it learned.
  { id: "history", label: S.history, section: "Atticus", full: true },
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

/**
 * Addresses of pages merged into another: the old address opens the page it is part of now, so
 * every bookmark and editor link still works. The Overview is part of Home (2026-10-24).
 */
export const OLD_ADDRESSES: Readonly<Record<string, string>> = { dashboard: "home" };

/** The page a hash opens; an unknown one opens Home. */
export function screenOf(hash: string): ScreenDef {
  const asked = hash.replace(/^#\/?/, "").split(/[/?]/)[0] || "home";
  const id = OLD_ADDRESSES[asked] ?? asked;
  return SCREENS.find((s) => s.id === id) ?? SCREENS[0]!;
}

/**
 * The change a page is about, from its address (`?change=` or `#/changes/<id>`), so moving between
 * a change's tabs keeps the change.
 */
export function changeOf(hash: string): string | undefined {
  const path = hash.replace(/^#\/?/, "");
  const m = /^changes\/([^/?]+)/.exec(path);
  if (m) return decodeURIComponent(m[1]!);
  const q = path.split("?")[1];
  return q ? (new URLSearchParams(q).get("change") ?? undefined) : undefined;
}

/** A tab's address: a change's pages keep the change they are about. */
export function tabHref(s: ScreenDef, change: string | undefined): string {
  if (s.section !== "Change" || !change) return `#/${s.id}`;
  if (s.id === "changes") return `#/changes/${encodeURIComponent(change)}`;
  return `#/${s.id}?change=${encodeURIComponent(change)}`;
}
