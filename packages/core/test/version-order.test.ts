import { describe, expect, it } from "vitest";
import { ATTICUS_VERSION_SHAPE, atticusVersionOf, newerThan } from "../src/version-order.js";

/** One rule for which Atticus is newer, for the stamp, `atticus status` and build.json. */
describe("the order of two Atticus versions", () => {
  it("counts pre-releases by number, and a release above its pre-releases", () => {
    expect(newerThan("2.0.0-beta.30", "2.0.0-beta.9")).toBe(true);
    expect(newerThan("2.0.0-beta.28.5", "2.0.0-beta.28.1")).toBe(true);
    expect(newerThan("2.0.0-beta.9", "2.0.0-beta.30")).toBe(false);
    expect(newerThan("2.0.0", "2.0.0-beta.30")).toBe(true);
    expect(newerThan("2.0.0-beta.30", "2.0.0")).toBe(false);
    expect(newerThan("2.0.0-beta.30", "2.0.0-beta.30")).toBe(false);
    expect(newerThan("2.1.0", "2.0.9")).toBe(true);
  });
  it("only a version's shape goes into a command", () => {
    for (const v of ["2.0.0", "2.0.0-beta.30", " 9.1.0 "])
      expect(atticusVersionOf(v)).toBe(v.trim());
    for (const v of ["latest", "2.0", "2.0.0; rm -rf ~", "$(forge)", "", undefined])
      expect(atticusVersionOf(v)).toBeUndefined();
    expect(ATTICUS_VERSION_SHAPE.test("2.0.0-beta.28.5")).toBe(true);
  });
});
