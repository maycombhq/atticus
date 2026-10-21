import { describe, expect, it } from "vitest";
import { SCREENS } from "../src/app/screens.js";
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

  it("says approving is the pull request, not a role (ADR 0073)", () => {
    const text = TOUR.map((s) => s.body).join(" ");
    expect(text).toContain("Merging it approves the gate");
    expect(text).not.toMatch(/\bview\b|\brole\b/i);
  });
});
