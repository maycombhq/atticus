import { describe, expect, it } from "vitest";
import { helperOn, STACK_HELPERS, stackHelpersOff } from "../src/index.js";

/** G4: each stack helper can be switched off for a run, by name or all at once. */
describe("stackHelpersOff", () => {
  it("reads ATTICUS_HELPERS_OFF: names, all, nothing, and unknown names ignored", () => {
    expect([...stackHelpersOff({})]).toEqual([]);
    expect([...stackHelpersOff({ ATTICUS_HELPERS_OFF: "all" })]).toEqual([...STACK_HELPERS]);
    expect([
      ...stackHelpersOff({ ATTICUS_HELPERS_OFF: " Gateway-Walk, readers ,nonsense" }),
    ]).toEqual(["gateway-walk", "readers"]);
    expect(helperOn("derived-names", { ATTICUS_HELPERS_OFF: "readers" })).toBe(true);
    expect(helperOn("readers", { ATTICUS_HELPERS_OFF: "readers" })).toBe(false);
  });
});
