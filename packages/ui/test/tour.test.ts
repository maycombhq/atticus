import { describe, expect, it } from "vitest";
import { ROLE_SCREENS } from "../src/app/roles.js";
import { TOURS } from "../src/app/tour.js";

describe("first-run tours", () => {
  it("gives every role a three-step tour that starts at home and points only at its own screens", () => {
    for (const role of Object.keys(ROLE_SCREENS)) {
      const steps = TOURS[role];
      expect(steps, role).toHaveLength(3);
      expect(steps![0]!.title, role).toBe("Your home");
      for (const s of steps!) {
        const m = /#\/([a-z-]+)"/.exec(s.target ?? "");
        if (m) expect(ROLE_SCREENS[role], `${role} → ${m[1]}`).toContain(m[1]);
      }
    }
  });
});
