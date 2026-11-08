import { describe, expect, it } from "vitest";
import { singular, termId, termKey } from "../src/words.js";

describe("a term's singular (round 42)", () => {
  it("makes statuses, buses and aliases one term with their singular", () => {
    expect(termKey("Payment statuses")).toBe(termKey("Payment status"));
    expect(termId("Transfer statuses")).toBe(termId("Transfer status"));
    expect(singular("buses")).toBe("bus");
    expect(singular("aliases")).toBe("alias");
    expect(singular("accounts")).toBe("account");
    expect(singular("entries")).toBe("entry");
    expect(singular("addresses")).toBe("address");
    expect(singular("causes")).toBe("cause");
  });
});
