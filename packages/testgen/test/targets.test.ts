import { describe, expect, it } from "vitest";
import { languageOf } from "../src/targets.js";

describe("the language a repo's tests are in, from its type", () => {
  it("reads the type's words whole: javascript-spa is not Java", () => {
    expect(languageOf({ repo: "forge-web", kind: "none" }, "javascript-spa")).toBe("node");
    expect(languageOf({ repo: "forge-orders", kind: "none" }, "spring-service")).toBe("java");
    expect(languageOf({ repo: "forge-batch", kind: "none" }, "java-batch")).toBe("java");
    expect(languageOf({ repo: "x", kind: "none" }, "cobol-batch")).toBeUndefined();
  });
});
