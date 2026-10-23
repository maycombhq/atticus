import { COPY } from "../copy.js";

/**
 * The app's screens (plan 4.5, B1; ADR 0105). The menu goes in the order of a working day:
 * the Dashboard, what waits on you, your changes, the phase screens, then Knowledge. Every
 * other page is under More, grouped by what it is about: the code, the wikis, the org pack,
 * the phases and running Atticus. Questions is a section of Waiting on you, out of the menu
 * but still at its address. No route is removed or renamed.
 */

export const MORE_GROUPS = [
  "Code",
  "Knowledge",
  "OrgPack",
  "Define",
  "Design",
  "Plan",
  "Build",
  "Release",
  "Run",
] as const;
export type MoreGroup = (typeof MORE_GROUPS)[number];

export interface ScreenDef {
  id: string;
  label: string;
  group: "Main" | MoreGroup;
  /** A page out of the menu: the menu entry it is a section of. */
  under?: string;
}

const N = COPY.nav;
const S = COPY.nav.screens;
const K = COPY.knowledge.nav;

export const MAIN: ScreenDef[] = [
  { id: "dashboard", label: N.dashboard, group: "Main" },
  { id: "home", label: S.home, group: "Main" },
  { id: "changes", label: S.changes, group: "Main" },
  { id: "onboarding", label: N.onboarding, group: "Main" },
  { id: "feature-design", label: N.feature, group: "Main" },
  { id: "architecture", label: N.architecture, group: "Main" },
  { id: "stories", label: N.stories, group: "Main" },
  { id: "task-list", label: N.tasks, group: "Main" },
  // ADR 0102: knowledge managed in the metarepo.
  { id: "knowledge", label: N.knowledge, group: "Main" },
];

export const MORE: ScreenDef[] = [
  { id: "explore", label: S.explore, group: "Code" },
  { id: "flows", label: COPY.flows.title, group: "Code" },
  { id: "map", label: S.map, group: "Code" },
  { id: "impact", label: S.impact, group: "Code" },
  { id: "features", label: S.features, group: "Code" },
  { id: "scans", label: S.scans, group: "Code" },
  { id: "wikis", label: K.sources, group: "Knowledge" },
  { id: "wiki-search", label: K.search, group: "Knowledge" },
  { id: "parties", label: K.parties, group: "Knowledge" },
  { id: "orgpack", label: S.orgpack, group: "OrgPack" },
  { id: "orgpack-draft", label: K.orgpack, group: "OrgPack" },
  { id: "intake", label: S.intake, group: "OrgPack" },
  { id: "settings", label: S.settings, group: "OrgPack" },
  { id: "brief", label: S.brief, group: "Define" },
  { id: "ux", label: S.ux, group: "Define" },
  { id: "arch-review", label: S.archReview, group: "Design" },
  { id: "diagrams", label: S.diagrams, group: "Design" },
  // ADR 0108: a change's picture, from its target flows.
  { id: "change-diagram", label: S.changeDiagram, group: "Design" },
  { id: "reconcile", label: S.reconcile, group: "Design" },
  { id: "contracts", label: S.contracts, group: "Design" },
  { id: "mappings", label: S.mappings, group: "Design" },
  { id: "breakdown", label: S.breakdown, group: "Plan" },
  { id: "initiatives", label: S.initiatives, group: "Plan" },
  { id: "tasks", label: S.tasks, group: "Build" },
  { id: "trace", label: S.trace, group: "Build" },
  { id: "todo", label: S.todo, group: "Build" },
  { id: "release", label: S.release, group: "Release" },
  { id: "service-desk", label: S.serviceDesk, group: "Release" },
  { id: "governance", label: S.governance, group: "Run" },
  { id: "evals", label: S.evals, group: "Run" },
  { id: "learning", label: S.learning, group: "Run" },
  // ADR 0106: what Atticus asked a model and what it answered.
  { id: "runs", label: S.runs, group: "Run" },
];

/** Pages out of the menu, each a section of a menu entry (ADR 0105). */
export const SECTIONS: ScreenDef[] = [
  { id: "questions", label: COPY.questions.title, group: "Main", under: "home" },
];

export const SCREENS: ScreenDef[] = [...MAIN, ...MORE, ...SECTIONS];

/** A menu group's name as the menu shows it. */
export const groupLabel = (g: ScreenDef["group"]): string => COPY.nav.groups[g];

export function screenOf(hash: string): ScreenDef {
  const id = hash.replace(/^#\/?/, "").split(/[/?]/)[0] || "dashboard";
  return SCREENS.find((s) => s.id === id) ?? MAIN[0]!;
}
