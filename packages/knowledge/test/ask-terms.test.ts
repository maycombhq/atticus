import { describe, expect, it } from "vitest";
import { termsOf } from "../src/knowledge-ask.js";

describe("the words knowledge ask looks for", () => {
  it("meets process with processes, and access with accesses (the stem took process to proces)", () => {
    expect(termsOf("process")).toEqual(termsOf("processes"));
    expect(termsOf("access")).toEqual(termsOf("accesses"));
    expect(termsOf("address")).toEqual(["address"]);
    expect(termsOf("requests")).toEqual(termsOf("request"));
  });
});
