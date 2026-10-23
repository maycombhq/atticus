import { describe, expect, it } from "vitest";
import { groupLabel, MAIN, MORE_GROUPS, MORE, SCREENS, screenOf } from "../src/app/screens.js";
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
  "change-diagram",
  "estimate",
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

describe("the app's menu (plan 4.5, B1; ADR 0105)", () => {
  it("shows the day's work first: Dashboard, Waiting on you, Changes, the phases, Knowledge", () => {
    expect(MAIN.map((s) => s.label)).toEqual([
      "Dashboard",
      "Waiting on you",
      "Changes",
      "Onboarding",
      "Feature design",
      "Architecture",
      "Stories",
      "Tasks",
      "Knowledge",
    ]);
    expect(MAIN.map((s) => s.id)).toEqual([
      "dashboard",
      "home",
      "changes",
      "onboarding",
      "feature-design",
      "architecture",
      "stories",
      "task-list",
      "knowledge",
    ]);
  });

  it("groups More by what each page is about (ADR 0105)", () => {
    expect(MORE_GROUPS.map(groupLabel)).toEqual([
      "Code",
      "Knowledge",
      "Org pack",
      "Define",
      "Design",
      "Plan",
      "Build",
      "Release",
      "Run",
    ]);
    const of = (g: string) => MORE.filter((s) => groupLabel(s.group) === g).map((s) => s.id);
    expect(of("Code")).toEqual(["explore", "flows", "map", "impact", "features", "scans"]);
    expect(of("Knowledge")).toEqual(["wikis", "wiki-search", "parties"]);
    expect(of("Org pack")).toEqual(["orgpack", "orgpack-draft", "intake", "settings"]);
    expect(of("Define")).toEqual(["brief", "ux"]);
    expect(of("Design")).toEqual([
      "arch-review",
      "diagrams",
      "change-diagram",
      "reconcile",
      "contracts",
      "mappings",
    ]);
    expect(of("Plan")).toEqual(["breakdown", "estimate", "initiatives"]);
    expect(of("Build")).toEqual(["tasks", "trace", "todo"]);
    expect(of("Release")).toEqual(["release", "service-desk"]);
    expect(of("Run")).toEqual(["governance", "evals", "learning", "runs"]);
  });

  it("keeps every screen reachable and removes none; Questions is a section of Waiting on you", () => {
    const ids = new Set(SCREENS.map((s) => s.id));
    expect(ids.size).toBe(SCREENS.length);
    expect(BEFORE.filter((id) => !ids.has(id))).toEqual([]);
    // Screens added since, each with its ADR.
    const ADDED = [
      "flows", // ADR 0092
      ...["wikis", "knowledge", "wiki-search", "parties", "orgpack-draft"], // ADR 0102
      "runs", // ADR 0106
    ];
    const menu = [...MAIN, ...MORE].map((s) => s.id);
    expect(menu).not.toContain("questions");
    expect([...menu, "questions"].sort()).toEqual(
      [...new Set([...BEFORE, ...ADDED, ...MAIN.map((s) => s.id)])].sort(),
    );
    expect(MORE.every((s) => (MORE_GROUPS as readonly string[]).includes(s.group))).toBe(true);
    expect(screenOf("#/questions/q-1")).toMatchObject({ id: "questions", under: "home" });
  });

  it("routes a hash to its screen, and anything unknown to the dashboard", () => {
    expect(screenOf("#/changes/add-transfer-limit").id).toBe("changes");
    expect(screenOf("#/explore?q=daily").id).toBe("explore");
    expect(screenOf("#/home").id).toBe("home");
    expect(screenOf("#/runs?run=run-20261023034001-0001").id).toBe("runs");
    expect(screenOf("#/flows?repo=forge-web&flow=forge-web.save-customer").id).toBe("flows");
    expect(screenOf("#/stories?change=add-transfer-limit").id).toBe("stories");
    expect(screenOf("").id).toBe("dashboard");
    expect(screenOf("#/nope").id).toBe("dashboard");
  });

  it("builds every screen", () => {
    expect(SCREENS.filter((s) => !SCREEN_COMPONENTS[s.id]).map((s) => s.id)).toEqual([]);
  });
});
