import { describe, expect, it } from "vitest";
import { groundValues, valueTokens, workingDays } from "../src/grounding.js";

// ADR 0111, 0117: every value a knowledge item states is said by the words it cites; what a
// check can't settle is a claim for a judge.

const quote = (...q: string[]) => ({ quotes: q, pages: q.join("\n") });
const problems = (...a: Parameters<typeof groundValues>) => groundValues(...a).problems;

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
  it("settles a lead time and an owner the quote writes, in digits or words", () => {
    expect(
      groundValues(
        { lead_time: "5 working days", handled_by: "Messaging team" },
        quote("Handled by: Messaging team. Lead time: five working days."),
      ),
    ).toEqual({ problems: [], claims: [] });
  });

  it("refuses a lead time the quote doesn't write, and says where to put the line that does", () => {
    expect(
      problems(
        { lead_time: "10 working days" },
        quote("Standard firewall rules are implemented within 5 working days."),
      ),
    ).toEqual([
      'lead_time "10 working days" isn\'t in the quote: quote the line that states it (under also_on when it is another sentence, on this page or another)',
    ]);
  });

  it("needs the lead time as one run of words: 3 days is not in 3 approvers and 15 days", () => {
    // The old rule took each word from anywhere in the quote, so this passed.
    const q = quote("Requests need 3 approvers and take 15 days.");
    expect(problems({ lead_time: "3 days" }, q)).toHaveLength(1);
    expect(problems({ lead_time: "15 days" }, q)).toEqual([]);
    // With its own words cited, a value whose numbers are there is a claim for a judge.
    expect(
      groundValues(
        { lead_time: "3 days", lead_time_quote: "Requests need 3 approvers and take 15 days." },
        q,
      ).claims,
    ).toEqual([
      { field: "lead_time", value: "3 days", span: "Requests need 3 approvers and take 15 days." },
    ]);
  });

  it("refuses a unit that differs: 10 calendar days are not 10 working days", () => {
    expect(problems({ lead_time: "10 working days" }, quote("Allow 10 days."))).toHaveLength(1);
    expect(problems({ lead_time: "two weeks" }, quote("Raise it 2 weeks before."))).toEqual([]);
  });

  it("checks the cited words are on the page", () => {
    expect(
      problems(
        { lead_time: "10 working days", lead_time_quote: "Lead time: ten working days." },
        quote("Lead time: 10 working days."),
      ),
    ).toEqual([
      'lead_time_quote: "Lead time: ten working days." isn\'t on the page it quotes: copy the words exactly',
    ]);
  });

  it("makes a normalised lead time a claim, refusing numbers the words don't give", () => {
    // Whether 10 days are 10 working days is meaning: a claim, even with the number there.
    expect(
      groundValues(
        {
          lead_time: "10 working days",
          lead_time_days: { min: 10, max: 10, unit: "working-days" },
        },
        quote("Lead time: 10 working days."),
      ),
    ).toEqual({
      problems: [],
      claims: [
        { field: "lead_time_days", value: "10 working-days", span: "Lead time: 10 working days." },
      ],
    });
    expect(
      problems(
        {
          lead_time: "10 working days",
          lead_time_days: { min: 12, max: 12, unit: "working-days" },
        },
        quote("Lead time: 10 working days."),
      ),
    ).toEqual([
      'lead_time_days: 12 to 12 isn\'t a number "Lead time: 10 working days." gives: read it from those words',
    ]);
    expect(
      groundValues(
        {
          lead_time: "a fortnight",
          lead_time_quote: "Allow a fortnight.",
          lead_time_days: { min: 10, max: 10, unit: "working-days" },
        },
        quote("Allow a fortnight."),
      ).claims,
    ).toEqual([{ field: "lead_time_days", value: "10 working-days", span: "Allow a fortnight." }]);
  });

  it("takes the page's own owner for who handles it", () => {
    expect(
      problems(
        { handled_by: "Enterprise Architecture" },
        { ...quote("Every call goes through the gateway."), owner: "Enterprise Architecture" },
      ),
    ).toEqual([]);
    expect(
      problems({ handled_by: "Network team" }, quote("Every call goes through the gateway.")),
    ).toEqual([
      'handled_by "Network team" isn\'t in the quote: quote the line that states it (under also_on when it is another sentence, on this page or another)',
    ]);
    expect(
      problems(
        { owned_by: "Payments team" },
        quote("Its contract is managed by the Payments team."),
      ),
    ).toEqual([]);
  });

  it("finds a date written as ISO, or as one run of day, month and year", () => {
    expect(
      problems(
        { dates: { switched_off: "2027-03-31", from: "2026-07-01" } },
        quote("No new routes from 1 July 2026; it is switched off on March 31, 2027."),
      ),
    ).toEqual([]);
    expect(problems({ dates: { deadline: "2026-12-31" } }, quote("Move by 2026-12-31."))).toEqual(
      [],
    );
    expect(
      problems({ dates: { deadline: "2026-12-30" } }, quote("Move by 31 December 2026.")),
    ).toHaveLength(1);
    // Day, month and year scattered over a sentence aren't a date the quote states.
    expect(
      problems({ dates: { pilot: "2027-03-01" } }, quote("In March 2027 we run 1 pilot.")),
    ).toHaveLength(1);
  });

  it("makes a status a claim on the words that state it, never a word list", () => {
    // The old list read "no" as a ban and missed "move off ... by Q3" as a retirement.
    const q = quote("Teams should move off the Northwind Pay v1 API by Q3.");
    // Without its own words, the claim is on the item's quote.
    expect(groundValues({ status: "retiring" }, q)).toEqual({
      problems: [],
      claims: [
        {
          field: "status",
          value: "retiring",
          span: "Teams should move off the Northwind Pay v1 API by Q3.",
        },
      ],
    });
    expect(
      groundValues(
        { status: "retiring", status_quote: "move off the Northwind Pay v1 API by Q3" },
        q,
      ).claims,
    ).toEqual([
      { field: "status", value: "retiring", span: "move off the Northwind Pay v1 API by Q3" },
    ]);
  });

  it("needs each number a rule or applies_when states to be on the item's pages", () => {
    const pages = "Keep audit records for 7 years.\nRotate keys yearly.";
    expect(
      problems(
        { rules: ["Audit records kept for 7 years."], applies_when: "Any audit record." },
        { quotes: ["Keep audit records for 7 years."], pages },
      ),
    ).toEqual([]);
    expect(
      problems(
        { rules: ["Audit records kept for 10 years."] },
        { quotes: ["Keep audit records for 7 years."], pages },
      ),
    ).toEqual(["rules: 10 isn't on the page it quotes: write only the numbers the page states"]);
  });

  it("passes what has no value to check", () => {
    expect(groundValues({}, quote("Anything at all."))).toEqual({ problems: [], claims: [] });
  });
});

describe("working days from a normalised lead time", () => {
  it("is arithmetic on the model's reading: the upper bound, calendar days as five in seven", () => {
    expect(workingDays({ min: 10, max: 15, unit: "working-days" })).toBe(15);
    expect(workingDays({ min: 14, max: 14, unit: "calendar-days" })).toBe(10);
    expect(workingDays({ min: 4, max: 4, unit: "hours" })).toBe(1);
  });
});
