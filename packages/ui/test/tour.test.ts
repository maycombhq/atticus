import { describe, expect, it } from "vitest";
import { landingOf, SCREENS, SECTIONS } from "../src/app/screens.js";
import { TOUR } from "../src/app/tour.js";

describe("first-run tour", () => {
  it("is one tour for everyone that starts at home and points only at screens that exist", () => {
    expect(TOUR.length).toBeGreaterThanOrEqual(3);
    expect(TOUR[0]!.title).toBe("Your home");
    const ids = new Set(SCREENS.map((s) => s.id));
    for (const s of TOUR) {
      const m = /#\/([a-z-]+)"/.exec(s.target ?? "");
      if (m) expect(ids.has(m[1]!), m[1]).toBe(true);
    }
  });

  it("points only at the menu's six entries, never at a page behind --full", () => {
    const menu = new Set(SECTIONS.map((s) => landingOf(s).id));
    for (const s of TOUR) {
      const m = /\.nav a\[href="#\/([a-z-]+)"\]/.exec(s.target ?? "");
      if (m) expect(menu.has(m[1]!), m[1]).toBe(true);
    }
    const text = TOUR.map((s) => s.body).join(" ");
    for (const entry of ["Map", "Change", "Questions", "Knowledge", "Set up"])
      expect(text).toContain(entry);
  });

  it("says approving is the pull request, not a role (ADR 0073)", () => {
    const text = TOUR.map((s) => s.body).join(" ");
    expect(text).toContain("Merging it approves the gate");
    expect(text).not.toMatch(/\bview\b|\brole\b/i);
  });
});

describe("the tour's path (WP5.3)", () => {
  it("walks home, asking, a change's tabs, a step in your assistant and the pull request", () => {
    expect(TOUR.map((s) => s.title)).toEqual([
      "Your home",
      "Ask in plain words",
      "One change, a tab per stage",
      "Run a step in your assistant",
      "Approving is the pull request",
    ]);
    expect(TOUR[3]!.body).toContain("/atticus-next");
  });
});
