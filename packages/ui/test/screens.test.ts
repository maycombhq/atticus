import { describe, expect, it } from "vitest";
import { MAIN, MORE_GROUPS, MORE, SCREENS, screenOf } from "../src/app/screens.js";
import { SCREEN_COMPONENTS } from "../src/screens/registry.js";

/** Every screen the app had before the six (plan 4.5): none is removed, each stays reachable. */
const BEFORE = [
  "home",
  "questions",
  "explore",
  "map",
  "impact",
  "features",
  "orgpack",
  "intake",
  "scans",
  "brief",
  "ux",
  "arch-review",
  "diagrams",
  "architecture",
  "reconcile",
  "contracts",
  "mappings",
  "breakdown",
  "initiatives",
  "changes",
  "tasks",
  "trace",
  "todo",
  "release",
  "service-desk",
  "governance",
  "evals",
  "learning",
  "settings",
];

describe("the app's menu (plan 4.5, B1)", () => {
  it("shows six screens, in the order the work goes", () => {
    expect(MAIN.map((s) => s.label)).toEqual([
      "Dashboard",
      "Onboarding",
      "Feature design",
      "Architecture",
      "Stories",
      "Tasks",
    ]);
    expect(MAIN.map((s) => s.id)).toEqual([
      "dashboard",
      "onboarding",
      "feature-design",
      "architecture",
      "stories",
      "task-list",
    ]);
  });

  it("keeps every other screen under More, in its old group, and removes none", () => {
    const ids = new Set(SCREENS.map((s) => s.id));
    expect(ids.size).toBe(SCREENS.length);
    expect(BEFORE.filter((id) => !ids.has(id))).toEqual([]);
    expect(MORE.map((s) => s.id).sort()).toEqual(
      BEFORE.filter((id) => id !== "architecture").sort(),
    );
    expect(MORE.every((s) => (MORE_GROUPS as readonly string[]).includes(s.group))).toBe(true);
    expect(SCREENS).toHaveLength(MAIN.length + MORE.length);
  });

  it("routes a hash to its screen, and anything unknown to the dashboard", () => {
    expect(screenOf("#/changes/add-transfer-limit").id).toBe("changes");
    expect(screenOf("#/explore?q=daily").id).toBe("explore");
    expect(screenOf("#/home").id).toBe("home");
    expect(screenOf("#/stories?change=add-transfer-limit").id).toBe("stories");
    expect(screenOf("").id).toBe("dashboard");
    expect(screenOf("#/nope").id).toBe("dashboard");
  });

  it("builds every screen", () => {
    expect(SCREENS.filter((s) => !SCREEN_COMPONENTS[s.id]).map((s) => s.id)).toEqual([]);
  });
});
