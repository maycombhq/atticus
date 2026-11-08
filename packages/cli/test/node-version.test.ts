import { describe, expect, it } from "vitest";
import { MIN_NODE } from "../src/doctor.js";
import { nodeTooOld, nodeTooOldMessage, NODE_NEEDED } from "../src/node-version.js";

/** Review round 25B: an older Node is said plainly, as the troubleshooting guide says it is. */
describe("the Node atticus needs", () => {
  it("refuses Node before 22.13, takes 22.13 and later", () => {
    for (const v of ["18.19.0", "20.17.0", "22.12.0"]) expect(nodeTooOld(v), v).toBe(true);
    for (const v of ["22.13.0", "22.20.1", "24.0.0"]) expect(nodeTooOld(v), v).toBe(false);
    expect(MIN_NODE.startsWith(NODE_NEEDED)).toBe(true);
    expect(nodeTooOldMessage("20.17.0")).toMatch(/^Atticus needs Node\.js 22\.13 or later/);
  });
});
