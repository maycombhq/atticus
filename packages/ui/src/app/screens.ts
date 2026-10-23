import { COPY } from "../copy.js";

/**
 * The app's screens (plan 4.5, B1). Six follow the work and make the menu; every other page,
 * from the design canvas, the Questions page (ADR 0078) and the rest, stays reachable under
 * More in its old group, unchanged until it is reviewed. Nothing is removed.
 */

export const MORE_GROUPS = ["Know", "Define", "Design", "Plan", "Build", "Release", "Run"] as const;
export type MoreGroup = (typeof MORE_GROUPS)[number];

export interface ScreenDef {
  id: string;
  label: string;
  group: "Main" | MoreGroup;
}

const N = COPY.nav;
const S = COPY.nav.screens;

export const MAIN: ScreenDef[] = [
  { id: "dashboard", label: N.dashboard, group: "Main" },
  { id: "onboarding", label: N.onboarding, group: "Main" },
  { id: "feature-design", label: N.feature, group: "Main" },
  { id: "architecture", label: N.architecture, group: "Main" },
  { id: "stories", label: N.stories, group: "Main" },
  { id: "task-list", label: N.tasks, group: "Main" },
];

export const MORE: ScreenDef[] = [
  { id: "home", label: S.home, group: "Know" },
  { id: "questions", label: COPY.questions.title, group: "Know" },
  { id: "explore", label: S.explore, group: "Know" },
  { id: "flows", label: COPY.flows.title, group: "Know" },
  { id: "map", label: S.map, group: "Know" },
  { id: "impact", label: S.impact, group: "Know" },
  { id: "features", label: S.features, group: "Know" },
  { id: "orgpack", label: S.orgpack, group: "Know" },
  // ADR 0102: knowledge managed in the metarepo.
  { id: "wikis", label: COPY.knowledge.nav.sources, group: "Know" },
  { id: "knowledge", label: COPY.knowledge.nav.items, group: "Know" },
  { id: "wiki-search", label: COPY.knowledge.nav.search, group: "Know" },
  { id: "parties", label: COPY.knowledge.nav.parties, group: "Know" },
  { id: "orgpack-draft", label: COPY.knowledge.nav.orgpack, group: "Know" },
  { id: "intake", label: S.intake, group: "Know" },
  { id: "scans", label: S.scans, group: "Know" },
  { id: "brief", label: S.brief, group: "Define" },
  { id: "ux", label: S.ux, group: "Define" },
  { id: "arch-review", label: S.archReview, group: "Design" },
  { id: "diagrams", label: S.diagrams, group: "Design" },
  { id: "reconcile", label: S.reconcile, group: "Design" },
  { id: "contracts", label: S.contracts, group: "Design" },
  { id: "mappings", label: S.mappings, group: "Design" },
  { id: "breakdown", label: S.breakdown, group: "Plan" },
  { id: "initiatives", label: S.initiatives, group: "Plan" },
  { id: "changes", label: S.changes, group: "Build" },
  { id: "tasks", label: S.tasks, group: "Build" },
  { id: "trace", label: S.trace, group: "Build" },
  { id: "todo", label: S.todo, group: "Build" },
  { id: "release", label: S.release, group: "Release" },
  { id: "service-desk", label: S.serviceDesk, group: "Release" },
  { id: "governance", label: S.governance, group: "Run" },
  { id: "evals", label: S.evals, group: "Run" },
  { id: "learning", label: S.learning, group: "Run" },
  { id: "settings", label: S.settings, group: "Run" },
];

export const SCREENS: ScreenDef[] = [...MAIN, ...MORE];

/** A menu group's name as the menu shows it. */
export const groupLabel = (g: ScreenDef["group"]): string => COPY.nav.groups[g];

export function screenOf(hash: string): ScreenDef {
  const id = hash.replace(/^#\/?/, "").split(/[/?]/)[0] || "dashboard";
  return SCREENS.find((s) => s.id === id) ?? MAIN[0]!;
}
