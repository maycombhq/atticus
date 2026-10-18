import { describe, expect, it } from "vitest";
import { GROUPS, SCREENS, screenOf } from "../src/app/screens.js";
import { SCREEN_COMPONENTS } from "../src/screens/registry.js";

describe("the app's screens", () => {
  it("has the 27 screens of the design, each in one of the seven menu groups", () => {
    expect(SCREENS).toHaveLength(27);
    expect(new Set(SCREENS.map((s) => s.id)).size).toBe(27);
    expect(SCREENS.every((s) => (GROUPS as readonly string[]).includes(s.group))).toBe(true);
  });

  it("routes a hash to its screen, and anything unknown to the command center", () => {
    expect(screenOf("#/changes/add-transfer-limit").id).toBe("changes");
    expect(screenOf("#/explore?q=daily").id).toBe("explore");
    expect(screenOf("").id).toBe("home");
    expect(screenOf("#/nope").id).toBe("home");
  });

  it("builds every screen of the Know, Define, Design, Plan and Build groups", () => {
    const groups = new Set(["Know", "Define", "Design", "Plan", "Build"]);
    // The to-do screen ships with the Release and Run screens.
    const missing = SCREENS.filter(
      (s) => groups.has(s.group) && s.id !== "todo" && !SCREEN_COMPONENTS[s.id],
    ).map((s) => s.id);
    expect(missing).toEqual([]);
  });
});
