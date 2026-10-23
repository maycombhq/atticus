import { describe, expect, it } from "vitest";
import { groundValues, valueTokens } from "../src/grounding.js";

// ADR 0111: every lead time, date, owner and status a knowledge item states is in its quote.

const quote = (...q: string[]) => ({ quotes: q, pages: q.join("\n") });

describe("value tokens", () => {
  it("folds case, plurals of time units, ordinals and number words to digits", () => {
    expect(valueTokens("Ten Working Days")).toEqual(["10", "working", "day"]);
    expect(valueTokens("five working days")).toEqual(valueTokens("5 working days"));
    expect(valueTokens("1st July 2026")).toEqual(["1", "july", "2026"]);
    expect(valueTokens("twenty-one days")).toEqual(["21", "day"]);
    // Words other than time units keep their plural: "teams" is not "team".
    expect(valueTokens("teams")).toEqual(["teams"]);
  });
});

describe("groundValues", () => {
  it("passes a lead time and an owner the quote states, in digits or words", () => {
    expect(
      groundValues(
        { lead_time: "5 working days", handled_by: "Messaging team" },
        quote("Handled by: Messaging team. Lead time: five working days."),
      ),
    ).toEqual([]);
  });

  it("refuses a lead time the quote doesn't state, and says where to put the line that does", () => {
    const p = groundValues(
      { lead_time: "10 working days" },
      quote("Standard firewall rules are implemented within 5 working days."),
    );
    expect(p).toEqual([
      'lead_time "10 working days" isn\'t in the quote: quote the line that states it (under also_on when it is another sentence, on this page or another)',
    ]);
  });

  it("refuses a unit that differs: 10 calendar days are not 10 working days", () => {
    expect(groundValues({ lead_time: "10 working days" }, quote("Allow 10 days."))).toHaveLength(1);
    expect(groundValues({ lead_time: "two weeks" }, quote("Raise it 2 weeks before."))).toEqual([]);
  });

  it("takes the page's own owner for who handles it", () => {
    expect(
      groundValues(
        { handled_by: "Enterprise Architecture" },
        { ...quote("Every call goes through the gateway."), owner: "Enterprise Architecture" },
      ),
    ).toEqual([]);
    expect(
      groundValues({ handled_by: "Network team" }, quote("Every call goes through the gateway.")),
    ).toEqual([
      'handled_by "Network team" isn\'t in the quote: quote the line that states it (under also_on when it is another sentence, on this page or another)',
    ]);
    expect(
      groundValues(
        { owned_by: "Payments team" },
        quote("Its contract is managed by the Payments team."),
      ),
    ).toEqual([]);
  });

  it("finds a date written as ISO, as day month year or as month day, year", () => {
    expect(
      groundValues(
        { dates: { switched_off: "2027-03-31", from: "2026-07-01" } },
        quote("No new routes from 1 July 2026; it is switched off on March 31, 2027."),
      ),
    ).toEqual([]);
    expect(
      groundValues({ dates: { deadline: "2026-12-31" } }, quote("Move by 2026-12-31.")),
    ).toEqual([]);
    expect(
      groundValues({ dates: { deadline: "2026-12-30" } }, quote("Move by 31 December 2026.")),
    ).toEqual([
      'dates.deadline "2026-12-30" isn\'t in the quote: quote the line that states it (under also_on when it is another sentence, on this page or another)',
    ]);
  });

  it("needs the quote to state the status: a ban, a mandate or a retirement", () => {
    expect(
      groundValues({ status: "banned" }, quote("A service never reads another's database.")),
    ).toEqual([]);
    expect(groundValues({ status: "mandated" }, quote("Every service must use TLS 1.2."))).toEqual(
      [],
    );
    expect(
      groundValues(
        { status: "retiring" },
        quote("The old gateway is deprecated and goes in March."),
      ),
    ).toEqual([]);
    expect(groundValues({ status: "banned" }, quote("Every service must use TLS 1.2."))).toEqual([
      'status "banned" isn\'t in the quote: it needs words such as banned, never, must not, not allowed or prohibited',
    ]);
  });

  it("needs each number a rule or applies_when states to be on the item's pages", () => {
    const pages = "Keep audit records for 7 years.\nRotate keys yearly.";
    expect(
      groundValues(
        { rules: ["Audit records kept for 7 years."], applies_when: "Any audit record." },
        { quotes: ["Keep audit records for 7 years."], pages },
      ),
    ).toEqual([]);
    expect(
      groundValues(
        { rules: ["Audit records kept for 10 years."] },
        { quotes: ["Keep audit records for 7 years."], pages },
      ),
    ).toEqual(["rules: 10 isn't on the page it quotes: write only the numbers the page states"]);
  });

  it("passes what has no value to check", () => {
    expect(groundValues({}, quote("Anything at all."))).toEqual([]);
  });
});
