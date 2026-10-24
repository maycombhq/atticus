import { describe, expect, it } from "vitest";
import {
  changeOf,
  groupLabel,
  landingOf,
  PHASES,
  SCREENS,
  screenOf,
  sectionLabel,
  SECTIONS,
  tabHref,
  tabsOf,
  type Section,
} from "../src/app/screens.js";
import { SCREEN_COMPONENTS } from "../src/screens/registry.js";

/** Every screen the app had before (plan 4.5): none is removed, each stays reachable. */
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
  "conformance",
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

describe("the app's map: six sections, every page a tab (ADR 0119)", () => {
  it("has the six sections in the order a person uses them, each opening on its first tab", () => {
    expect(SECTIONS.map(sectionLabel)).toEqual([
      "Home",
      "Changes",
      "Knowledge",
      "Estate",
      "Set up",
      "Atticus",
    ]);
    expect(SECTIONS.map((s) => landingOf(s).id)).toEqual([
      "home",
      "changes",
      "knowledge",
      "explore",
      "onboarding",
      "runs",
    ]);
  });

  it("puts each page in its section, and a change's pages under their phase", () => {
    const of = (s: Section) => tabsOf(s).map((x) => x.id);
    expect(of("Home")).toEqual(["home", "dashboard"]);
    expect(of("Knowledge")).toEqual(["knowledge", "wikis", "documents", "wiki-search", "parties"]);
    expect(of("SetUp")).toEqual([
      "onboarding",
      "scans",
      "intake",
      "orgpack",
      "orgpack-draft",
      "ai",
      "settings",
    ]);
    expect(of("Atticus")).toEqual(["runs", "history", "evals", "learning"]);
    const phase = (g: string) =>
      tabsOf("Changes")
        .filter((x) => x.group === g)
        .map((x) => x.id);
    expect(PHASES.map(groupLabel)).toEqual(["Define", "Design", "Plan", "Build", "Release"]);
    expect(phase("Define")).toEqual(["brief", "ux", "feature-design"]);
    expect(phase("Design")).toEqual(["architecture", "arch-review", "change-diagram"]);
    expect(phase("Plan")).toEqual(["stories", "breakdown", "estimate"]);
    expect(phase("Build")).toEqual(["task-list", "tasks", "conformance", "trace", "todo"]);
    expect(phase("Release")).toEqual(["release", "service-desk"]);
  });

  it("keeps every page and every address; Questions is part of Waiting on you", () => {
    const ids = new Set(SCREENS.map((s) => s.id));
    expect(ids.size).toBe(SCREENS.length);
    expect(BEFORE.filter((id) => !ids.has(id))).toEqual([]);
    for (const id of [
      "flows",
      "wikis",
      "knowledge",
      "wiki-search",
      "parties",
      "orgpack-draft",
      "runs",
      "history",
      "dashboard",
      "onboarding",
      "feature-design",
      "stories",
      "task-list",
    ])
      expect(ids.has(id), id).toBe(true);
    expect(SECTIONS.flatMap((s) => tabsOf(s)).map((s) => s.id)).not.toContain("questions");
    expect(screenOf("#/questions/q-1")).toMatchObject({ id: "questions", under: "home" });
  });

  it("routes a hash to its page, and anything unknown to Home", () => {
    expect(screenOf("#/changes/add-transfer-limit").id).toBe("changes");
    expect(screenOf("#/explore?q=daily").id).toBe("explore");
    expect(screenOf("#/home").id).toBe("home");
    expect(screenOf("#/dashboard").id).toBe("dashboard");
    expect(screenOf("#/runs?run=run-20261023034001-0001").id).toBe("runs");
    expect(screenOf("#/history?change=add-transfer-limit").id).toBe("history");
    expect(screenOf("#/flows?repo=forge-web&flow=forge-web.save-customer").id).toBe("flows");
    expect(screenOf("#/stories?change=add-transfer-limit").id).toBe("stories");
    expect(screenOf("").id).toBe("home");
    expect(screenOf("#/nope").id).toBe("home");
  });

  it("keeps the change when moving between a change's tabs", () => {
    expect(changeOf("#/changes/add-transfer-limit")).toBe("add-transfer-limit");
    expect(changeOf("#/estimate?change=add-fraud-check")).toBe("add-fraud-check");
    expect(changeOf("#/explore?q=x")).toBeUndefined();
    const estimate = SCREENS.find((s) => s.id === "estimate")!;
    const list = SCREENS.find((s) => s.id === "changes")!;
    const map = SCREENS.find((s) => s.id === "map")!;
    expect(tabHref(estimate, "add-fraud-check")).toBe("#/estimate?change=add-fraud-check");
    expect(tabHref(list, "add-fraud-check")).toBe("#/changes/add-fraud-check");
    expect(tabHref(estimate, undefined)).toBe("#/estimate");
    expect(tabHref(map, "add-fraud-check")).toBe("#/map");
  });

  it("builds every screen", () => {
    expect(SCREENS.filter((s) => !SCREEN_COMPONENTS[s.id]).map((s) => s.id)).toEqual([]);
  });
});
