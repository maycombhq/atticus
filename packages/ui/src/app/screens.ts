/** The 27 screens of the design canvas, in its menu groups. `built` marks the ones done so far. */

export interface ScreenDef {
  id: string;
  label: string;
  group: "Know" | "Define" | "Design" | "Plan" | "Build" | "Release" | "Run";
}

export const SCREENS: ScreenDef[] = [
  { id: "home", label: "Command center", group: "Know" },
  { id: "explore", label: "Knowledge explorer", group: "Know" },
  { id: "map", label: "Ecosystem map", group: "Know" },
  { id: "impact", label: "Impact explorer", group: "Know" },
  { id: "features", label: "Features", group: "Know" },
  { id: "orgpack", label: "Org pack", group: "Know" },
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

export const GROUPS = ["Know", "Define", "Design", "Plan", "Build", "Release", "Run"] as const;

export function screenOf(hash: string): ScreenDef {
  const id = hash.replace(/^#\/?/, "").split(/[/?]/)[0] || "home";
  return SCREENS.find((s) => s.id === id) ?? SCREENS[0]!;
}
