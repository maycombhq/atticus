import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { conformSummary } from "../src/change-conform.js";

/**
 * The last line of `atticus change conform` (the persona check of beta.30 and its review): it says
 * the code has everything only when every claim is present and every item found; otherwise it
 * counts what isn't, and what a person settled is said as settled. Pure; invented Forge names.
 */

type Claim = NonNullable<Api.ConformRepoResultT["claims"]>[number];
type Item = Api.ConformRepoResultT["items"][number];

const claim = (outcome: Claim["outcome"], state?: string): Claim =>
  ({ outcome, ...(state ? { finding: { state } } : {}) }) as unknown as Claim;
const item = (status: Item["status"], state?: string): Item =>
  ({ status, ...(state ? { finding: { state } } : {}) }) as unknown as Item;
const result = (claims: Claim[], items: Item[] = []): Api.ConformRepoResultT =>
  ({ repo: "forge-ledger", claims, items }) as unknown as Api.ConformRepoResultT;

describe("the summary of a check of the code", () => {
  it("says the code has everything only when every claim is present", () => {
    expect(conformSummary([result([claim("present")])], { flows: 0 })).toBe(
      "The code has everything the change states it will have, and nothing its design doesn't name.",
    );
    expect(conformSummary([result([claim("present"), claim("unconfirmed")])], { flows: 0 })).toBe(
      "Not everything the change states is confirmed in the code: 1 couldn't be confirmed. Each claim above says what to do next; check again once it is done.",
    );
  });

  it("says what a person settled as settled, not as something still to do", () => {
    expect(
      conformSummary([result([claim("present"), claim("not-checkable", "waived")])], { flows: 0 }),
    ).toBe(
      "The code has everything else the change states it will have; 1 claim was waived or dismissed by a person.",
    );
    expect(
      conformSummary([result([claim("unconfirmed"), claim("not-checkable", "waived")])], {
        flows: 0,
      }),
    ).toBe(
      "Not everything the change states is confirmed in the code: 1 couldn't be confirmed, 1 waived or dismissed. Each claim above says what to do next; check again once it is done.",
    );
  });

  it("never counts a dismissed item that isn't in the design as something the change states", () => {
    expect(
      conformSummary(
        [result([claim("present")], [item("found"), item("unexpected", "dismissed")])],
        {
          flows: 1,
          claims: 1,
        },
      ),
    ).toBe(
      "The code has everything its target flows add and everything the change states it will have; 1 thing in the code that the design doesn't name was dismissed by a person.",
    );
    expect(
      conformSummary(
        [
          result(
            [],
            [item("found"), item("unexpected", "dismissed"), item("unexpected", "dismissed")],
          ),
        ],
        { flows: 1 },
      ),
    ).toBe(
      "The code has everything its target flows add; 2 things in the code that the design doesn't name were dismissed by a person.",
    );
    expect(
      conformSummary([result([claim("present")], [item("missing", "waived")])], {
        flows: 1,
        claims: 1,
      }),
    ).toBe(
      "The code has everything else the change states it will have; 1 item was waived or dismissed by a person.",
    );
  });
});
