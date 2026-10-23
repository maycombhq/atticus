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

export const MAIN: ScreenDef[] = [
  { id: "dashboard", label: N.dashboard, group: "Main" },
  { id: "onboarding", label: N.onboarding, group: "Main" },
  { id: "feature-design", label: N.feature, group: "Main" },
  { id: "architecture", label: N.architecture, group: "Main" },
  { id: "stories", label: N.stories, group: "Main" },
  { id: "task-list", label: N.tasks, group: "Main" },
];

export const MORE: ScreenDef[] = [
  { id: "home", label: "Command center", group: "Know" },
  { id: "questions", label: COPY.questions.title, group: "Know" },
  { id: "explore", label: "Knowledge explorer", group: "Know" },
  { id: "flows", label: COPY.flows.title, group: "Know" },
  { id: "map", label: "Ecosystem map", group: "Know" },
  { id: "impact", label: "Impact explorer", group: "Know" },
  { id: "features", label: "Features", group: "Know" },
  { id: "orgpack", label: "Org pack", group: "Know" },
  // ADR 0102: knowledge managed in the metarepo.
  { id: "wikis", label: COPY.knowledge.nav.sources, group: "Know" },
  { id: "knowledge", label: COPY.knowledge.nav.items, group: "Know" },
  { id: "wiki-search", label: COPY.knowledge.nav.search, group: "Know" },
  { id: "parties", label: COPY.knowledge.nav.parties, group: "Know" },
  { id: "orgpack-draft", label: COPY.knowledge.nav.orgpack, group: "Know" },
  { id: "intake", label: "Intake", group: "Know" },
  { id: "scans", label: "Scans", group: "Know" },
  { id: "brief", label: "Feature brief", group: "Define" },
  { id: "ux", label: "Prototypes and UX", group: "Define" },
  { id: "arch-review", label: "Architecture review", group: "Design" },
  { id: "diagrams", label: "Diagrams", group: "Design" },
  { id: "reconcile", label: "Reconcile", group: "Design" },
  { id: "contracts", label: "Contracts", group: "Design" },
  { id: "mappings", label: "API mappings", group: "Design" },
  { id: "breakdown", label: "Breakdown", group: "Plan" },
  { id: "initiatives", label: "Initiatives", group: "Plan" },
  { id: "changes", label: "Changes", group: "Build" },
  { id: "tasks", label: "Task board", group: "Build" },
  { id: "trace", label: "Test trace", group: "Build" },
  { id: "todo", label: "To-do and manual steps", group: "Build" },
  { id: "release", label: "Release plan", group: "Release" },
  { id: "service-desk", label: "Service desk queue", group: "Release" },
  { id: "governance", label: "Governance", group: "Run" },
  { id: "evals", label: "AI quality", group: "Run" },
  { id: "learning", label: "Learning", group: "Run" },
  { id: "settings", label: "Settings", group: "Run" },
];

export const SCREENS: ScreenDef[] = [...MAIN, ...MORE];

export function screenOf(hash: string): ScreenDef {
  const id = hash.replace(/^#\/?/, "").split(/[/?]/)[0] || "dashboard";
  return SCREENS.find((s) => s.id === id) ?? MAIN[0]!;
}
