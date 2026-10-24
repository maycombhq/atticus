import { COPY } from "../copy.js";

/**
 * The app's map (ADR 0119; before it, plan 4.5, B1 and ADR 0105). Six sections, the same on every
 * surface and in the order a person uses them: Home (what waits on you), Changes, Knowledge, the
 * Estate, Set up, and Atticus itself. Every page is a tab of one section; the pages of a change
 * are grouped by phase. There is no More: the menu has the six, the section shows its tabs. No
 * route is removed or renamed, so every old address still opens its page.
 */

export const SECTIONS = ["Home", "Changes", "Knowledge", "Estate", "SetUp", "Atticus"] as const;
export type Section = (typeof SECTIONS)[number];

/** The phases a change's pages are grouped by, within Changes. */
export const PHASES = ["Define", "Design", "Plan", "Build", "Release"] as const;
export type Phase = (typeof PHASES)[number];

export interface ScreenDef {
  id: string;
  label: string;
  section: Section;
  /** Within Changes: the phase the page belongs to. */
  group?: Phase;
  /** A page out of the tabs: the tab it is a part of. */
  under?: string;
}

const N = COPY.nav;
const S = COPY.nav.screens;
const K = COPY.knowledge.nav;

export const SCREENS: ScreenDef[] = [
  // Home: what waits on you first, then the estate at a glance.
  { id: "home", label: S.home, section: "Home" },
  { id: "dashboard", label: N.dashboard, section: "Home" },
  { id: "questions", label: COPY.questions.title, section: "Home", under: "home" },
  // Changes: the list, then each phase's pages.
  { id: "changes", label: S.changes, section: "Changes" },
  { id: "brief", label: S.brief, section: "Changes", group: "Define" },
  { id: "ux", label: S.ux, section: "Changes", group: "Define" },
  { id: "feature-design", label: N.feature, section: "Changes", group: "Define" },
  { id: "architecture", label: N.architecture, section: "Changes", group: "Design" },
  { id: "arch-review", label: S.archReview, section: "Changes", group: "Design" },
  // ADR 0108: a change's picture, from its target flows.
  { id: "change-diagram", label: S.changeDiagram, section: "Changes", group: "Design" },
  { id: "stories", label: N.stories, section: "Changes", group: "Plan" },
  { id: "breakdown", label: S.breakdown, section: "Changes", group: "Plan" },
  // ADR 0109: a change's estimate, from its target flows.
  { id: "estimate", label: S.estimate, section: "Changes", group: "Plan" },
  { id: "task-list", label: N.tasks, section: "Changes", group: "Build" },
  { id: "tasks", label: S.tasks, section: "Changes", group: "Build" },
  // ADR 0114: does the code do what the design says?
  { id: "conformance", label: S.conformance, section: "Changes", group: "Build" },
  { id: "trace", label: S.trace, section: "Changes", group: "Build" },
  { id: "todo", label: S.todo, section: "Changes", group: "Build" },
  { id: "release", label: S.release, section: "Changes", group: "Release" },
  { id: "service-desk", label: S.serviceDesk, section: "Changes", group: "Release" },
  // Knowledge (ADR 0102): the items, the wikis they come from, searching them, the parties.
  { id: "knowledge", label: K.items, section: "Knowledge" },
  { id: "wikis", label: K.sources, section: "Knowledge" },
  { id: "wiki-search", label: K.search, section: "Knowledge" },
  { id: "parties", label: K.parties, section: "Knowledge" },
  // The estate: what the code says, searched, drawn and followed.
  { id: "explore", label: S.explore, section: "Estate" },
  { id: "map", label: S.map, section: "Estate" },
  { id: "flows", label: COPY.flows.title, section: "Estate" },
  { id: "impact", label: S.impact, section: "Estate" },
  { id: "features", label: S.features, section: "Estate" },
  { id: "contracts", label: S.contracts, section: "Estate" },
  { id: "mappings", label: S.mappings, section: "Estate" },
  { id: "diagrams", label: S.diagrams, section: "Estate" },
  { id: "reconcile", label: S.reconcile, section: "Estate" },
  { id: "governance", label: S.governance, section: "Estate" },
  { id: "initiatives", label: S.initiatives, section: "Estate" },
  // Set up: the repos, their scans, what was dropped in, the org pack, this machine.
  { id: "onboarding", label: N.onboarding, section: "SetUp" },
  { id: "scans", label: S.scans, section: "SetUp" },
  { id: "intake", label: S.intake, section: "SetUp" },
  { id: "orgpack", label: S.orgpack, section: "SetUp" },
  { id: "orgpack-draft", label: K.orgpack, section: "SetUp" },
  { id: "settings", label: S.settings, section: "SetUp" },
  // Atticus itself: what it asked a model (ADR 0106), what people asked theirs (ADR 0110).
  { id: "runs", label: S.runs, section: "Atticus" },
  { id: "history", label: S.history, section: "Atticus" },
  { id: "evals", label: S.evals, section: "Atticus" },
  { id: "learning", label: S.learning, section: "Atticus" },
];

/** A section's name as the menu shows it. */
export const sectionLabel = (s: Section): string => N.sections[s];

/** A phase's name, as a group of a change's pages. */
export const groupLabel = (g: Phase): string => N.groups[g];

/** The tabs of a section, in order: every page of it but those that are part of another. */
export const tabsOf = (s: Section): ScreenDef[] =>
  SCREENS.filter((x) => x.section === s && !x.under);

/** Where a section opens: its first tab. */
export const landingOf = (s: Section): ScreenDef => tabsOf(s)[0]!;

/** The page a hash opens; an unknown one opens Home, what waits on you. */
export function screenOf(hash: string): ScreenDef {
  const id = hash.replace(/^#\/?/, "").split(/[/?]/)[0] || "home";
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
  if (s.section !== "Changes" || !change) return `#/${s.id}`;
  if (s.id === "changes") return `#/changes/${encodeURIComponent(change)}`;
  return `#/${s.id}?change=${encodeURIComponent(change)}`;
}
