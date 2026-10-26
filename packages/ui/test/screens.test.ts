import { describe, expect, it } from "vitest";
import {
  changeOf,
  FULL_SECTIONS,
  groupLabel,
  landingOf,
  morePages,
  OLD_ADDRESSES,
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

/** Every screen the app had before (plan 4.5, ADR 0119): none is removed, each stays reachable. */
const BEFORE = [
  "home",
  "dashboard",
  "questions",
  "explore",
  "map",
  "systems",
  "flows",
  "impact",
  "features",
  "orgpack",
  "intake",
  "scans",
  "brief",
  "ux",
  "feature-design",
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
  "cockpit",
  "stories",
  "task-list",
  "tasks",
  "trace",
  "todo",
  "release",
  "service-desk",
  "governance",
  "knowledge",
  "wikis",
  "documents",
  "wiki-search",
  "parties",
  "orgpack-draft",
  "onboarding",
  "repos",
  "ai",
  "settings",
  "runs",
  "history",
  "evals",
  "learning",
  "words",
];

/**
 * What the six entries' tabs don't show: under More pages, at the bottom of the menu (2026-10-25),
 * and a tab with --full. Model runs isn't: it is a tab of Set up.
 */
const UNDER_MORE = [
  "map",
  "features",
  "mappings",
  "diagrams",
  "reconcile",
  "governance",
  "initiatives",
  "brief",
  "ux",
  "arch-review",
  "breakdown",
  "estimate",
  "conformance",
  "trace",
  "todo",
  "release",
  "service-desk",
  "tasks",
  "parties",
  "orgpack-draft",
  "scans",
  "intake",
  "settings",
  "history",
  "evals",
  "learning",
];

const of = (s: Section, full = false) => tabsOf(s, full).map((x) => x.id);

describe("the app's map: six entries (the Surfaces design)", () => {
  it("has exactly the six entries in order, each opening on its first tab", () => {
    expect(SECTIONS.map(sectionLabel)).toEqual([
      "Home",
      "Map",
      "Change",
      "Questions",
      "Knowledge",
      "Set up",
    ]);
    expect(SECTIONS.map((s) => landingOf(s).id)).toEqual([
      "home",
      "canvas",
      "changes",
      "questions",
      "knowledge",
      "repos",
    ]);
  });

  it("gives each entry exactly its tabs", () => {
    expect(of("Home")).toEqual(["home"]);
    expect(of("Map")).toEqual(["canvas", "flows", "contracts", "impact", "trust"]);
    // The product owner, 2026-10-24: the list and At a glance are tabs, before the stages.
    expect(of("Change")).toEqual([
      "changes",
      "cockpit",
      "feature-design",
      "architecture",
      "stories",
      "task-list",
    ]);
    expect(of("Questions")).toEqual(["questions"]);
    expect(of("Knowledge")).toEqual(["knowledge", "wikis", "documents", "wiki-search"]);
    // Model runs beside AI: what the AI was asked, where a person looks for it (2026-10-25).
    expect(of("SetUp")).toEqual(["repos", "ai", "runs", "orgpack"]);
    expect(of("Atticus")).toEqual([]);
  });

  it("puts every page the six's tabs don't show under More pages, once, by section", () => {
    const full = SCREENS.filter((s) => s.full).map((s) => s.id);
    expect([...full].sort()).toEqual([...UNDER_MORE].sort());
    const tabs = new Set(SECTIONS.flatMap((s) => of(s)));
    for (const id of UNDER_MORE) expect(tabs.has(id), id).toBe(false);
    const more = morePages();
    expect(more.map((g) => g.section)).toEqual(["Map", "Change", "Knowledge", "SetUp", "Atticus"]);
    const listed = more.flatMap((g) => g.pages.map((p) => p.id));
    expect([...listed].sort()).toEqual([...UNDER_MORE].sort());
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).not.toContain("runs");
    const byId = (s: string) => more.find((g) => g.section === s)!.pages.map((p) => p.id);
    expect(byId("Knowledge")).toEqual(["parties", "orgpack-draft"]);
    expect(byId("SetUp")).toEqual(["scans", "intake", "settings"]);
    expect(byId("Atticus")).toEqual(["history", "evals", "learning"]);
    // Change's by phase, in the order of a change.
    const change = more.find((g) => g.section === "Change")!;
    expect(change.phases!.map((p) => [p.phase, p.pages.map((x) => x.id)])).toEqual([
      ["Define", ["brief", "ux"]],
      ["Design", ["arch-review"]],
      ["Plan", ["breakdown", "estimate"]],
      ["Build", ["tasks", "conformance", "trace", "todo"]],
      ["Release", ["release", "service-desk"]],
    ]);
    expect(change.pages.map((p) => p.id)).toEqual(
      change.phases!.flatMap((p) => p.pages.map((x) => x.id)),
    );
    for (const g of more) if (g.section !== "Change") expect(g.phases).toBeUndefined();
  });

  it("reaches a change's picture, Ask, a system, the first steps and the words by link", () => {
    const aside = SCREENS.filter((s) => s.aside).map((s) => s.id);
    expect(aside.sort()).toEqual(
      ["change-diagram", "explore", "onboarding", "systems", "words"].sort(),
    );
  });

  it("with --full: every page is a tab of its section, a change's by phase", () => {
    expect(sectionLabel("Atticus")).toBe("Atticus");
    expect(of("Atticus", true)).toEqual(["history", "evals", "learning"]);
    const all = new Set(FULL_SECTIONS.flatMap((s) => of(s, true)));
    expect(SCREENS.filter((s) => !s.under && !all.has(s.id)).map((s) => s.id)).toEqual([]);
    expect(of("Map", true).slice(0, 5)).toEqual([
      "canvas",
      "flows",
      "contracts",
      "impact",
      "trust",
    ]);
    expect(landingOf("Change", true).id).toBe("changes");
    const phase = (g: string) =>
      tabsOf("Change", true)
        .filter((x) => x.group === g)
        .map((x) => x.id);
    expect(PHASES.map(groupLabel)).toEqual(["Define", "Design", "Plan", "Build", "Release"]);
    expect(phase("Define")).toEqual(["cockpit", "brief", "ux", "feature-design"]);
    expect(phase("Design")).toEqual(["architecture", "arch-review", "change-diagram"]);
    expect(phase("Plan")).toEqual(["stories", "breakdown", "estimate"]);
    expect(phase("Build")).toEqual(["task-list", "tasks", "conformance", "trace", "todo"]);
    expect(phase("Release")).toEqual(["release", "service-desk"]);
  });

  it("keeps every page and every address", () => {
    const ids = new Set(SCREENS.map((s) => s.id));
    expect(ids.size).toBe(SCREENS.length);
    expect(BEFORE.filter((id) => !ids.has(id) && !(id in OLD_ADDRESSES))).toEqual([]);
    for (const id of BEFORE) expect(screenOf(`#/${id}`).id, id).toBe(OLD_ADDRESSES[id] ?? id);
    expect(screenOf("#/questions/q-1").id).toBe("questions");
  });

  it("merges the Overview into Home: its address opens Home, and it is in no list, even --full", () => {
    expect(OLD_ADDRESSES).toEqual({ dashboard: "home" });
    expect(SCREENS.some((s) => s.id === "dashboard")).toBe(false);
    expect(screenOf("#/dashboard").id).toBe("home");
    expect(screenOf("#/dashboard?x=1").id).toBe("home");
    expect(of("Home")).toEqual(["home"]);
    expect(of("Home", true)).toEqual(["home", "words"]);
    expect(sectionLabel(screenOf("#/home").section)).toBe(screenOf("#/home").label);
  });

  it("routes a hash to its page, and anything unknown to Home", () => {
    expect(screenOf("#/changes/add-transfer-limit").id).toBe("changes");
    expect(screenOf("#/explore?q=daily").id).toBe("explore");
    expect(screenOf("#/canvas?lens=data").id).toBe("canvas");
    expect(screenOf("#/trust").id).toBe("trust");
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
    const byId = (id: string) => SCREENS.find((s) => s.id === id)!;
    expect(tabHref(byId("stories"), "add-fraud-check")).toBe("#/stories?change=add-fraud-check");
    expect(tabHref(byId("changes"), "add-fraud-check")).toBe("#/changes/add-fraud-check");
    expect(tabHref(byId("stories"), undefined)).toBe("#/stories");
    expect(tabHref(byId("canvas"), "add-fraud-check")).toBe("#/canvas");
  });

  it("builds every screen", () => {
    expect(SCREENS.filter((s) => !SCREEN_COMPONENTS[s.id]).map((s) => s.id)).toEqual([]);
  });
});
