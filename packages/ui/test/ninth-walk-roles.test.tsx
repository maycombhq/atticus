import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import { taskWaitsWords } from "../src/screens/know/Phase.js";
import { pickerFor, RolePicker } from "../src/screens/RoleQuestions.js";
import { roleWords } from "../src/screens/Questions.js";
import { ChangeOwners, ownersBody, ownersFields } from "../src/screens/change-owners.js";
import { OwnerQuestionCard } from "../src/screens/OwnerQuestions.js";

/**
 * Ninth UX walk (gates, owner questions, roles, tasks): the Task board says what a task waits for,
 * Home's role picker shows only where it is used, a question says its role, a change's owners are
 * named on its page, and a critic gap's owner question says where it came from.
 */

const esc = (s: string) => s.replace(/'/g, "&#x27;");

describe("the Task board", () => {
  it("says a task waits for the earlier task of its own repo", () => {
    expect(taskWaitsWords({ done: false, waits: { tasks: ["1.1"], sameRepo: ["1.1"] } })).toBe(
      "Waits for 1.1 (same repo)",
    );
    expect(
      taskWaitsWords({ done: false, waits: { tasks: ["1.1", "2.1"], sameRepo: ["2.1"] } }),
    ).toBe("Waits for 1.1, 2.1 (same repo)");
    expect(taskWaitsWords({ done: true, waits: { tasks: ["1.1"], sameRepo: [] } })).toBeUndefined();
    expect(taskWaitsWords({ done: false })).toBeUndefined();
  });
});

describe("Home's role picker", () => {
  it("is hidden when every change in flight names the person, and says it covers the rest", () => {
    expect(pickerFor([true, true])).toEqual({ show: false, hint: "some-named" });
    expect(pickerFor([true, false])).toEqual({ show: true, hint: "some-named" });
    expect(pickerFor([false, false])).toEqual({ show: true, hint: "none-named" });
    // Until each change has said, it is shown as for none.
    expect(pickerFor([true, undefined])).toEqual({ show: true, hint: "some-named" });
    expect(pickerFor([undefined])).toEqual({ show: true, hint: "none-named" });
    const some = renderToStaticMarkup(
      <RolePicker value={undefined} onChange={() => {}} hint="some-named" />,
    );
    expect(some).toContain(esc(COPY.roles.pickYoursHintSome));
    expect(some).not.toContain(esc(COPY.roles.pickYoursHint));
  });

  it("says the architect owns the feature stage's questions", () => {
    expect(COPY.roles.homeIntro).toContain("the architect the feature stage's");
  });
});

describe("a question's role", () => {
  it("is said in words, or not at all", () => {
    expect(roleWords("architecture")).toBe("For the architect");
    expect(roleWords("delivery")).toBe("For the tech lead");
    expect(roleWords(undefined)).toBeUndefined();
  });
});

describe("the change's owners", () => {
  it("reads change.yaml's owners into the form, and sends each role's handles", () => {
    expect(ownersFields({ architect: ["priya.nair", "ari"], qa: ["quinn"] })).toEqual({
      "product-owner": "",
      architect: "priya.nair, ari",
      "business-analyst": "",
      "team-lead": "",
    });
    expect(
      ownersBody({
        "product-owner": "",
        architect: "priya.nair, @ari  ari",
        "business-analyst": "bea",
        "team-lead": " ",
      }),
    ).toEqual({
      owners: {
        "product-owner": [],
        architect: ["priya.nair", "@ari", "ari"],
        "business-analyst": ["bea"],
        "team-lead": [],
      },
    });
  });

  it("labels a field for each role", () => {
    const html = renderToStaticMarkup(
      <ChangeOwners change="add-holds" owners={{ "team-lead": ["sam"] }} startEditing />,
    );
    for (const r of ["Product owner", "Architect", "Business analyst", "Tech lead"])
      expect(html).toContain(`>${r}</label>`);
    expect(html).toContain('value="sam"');
    expect(html).toContain(COPY.roleWork.saveOwners);
  });

  it("shows who is on it, with one button to change it and no Save until then (ADR 0191)", () => {
    const html = renderToStaticMarkup(
      <ChangeOwners change="add-holds" owners={{ "team-lead": ["sam"] }} />,
    );
    expect(html).toContain(">sam</dd>");
    expect(html).toContain(COPY.roleWork.nobody);
    expect(html).toContain(COPY.roleWork.editOwners);
    expect(html).not.toContain(COPY.roleWork.saveOwners);
    expect(html).not.toContain("<input");
  });
});

describe("a critic gap's owner question", () => {
  it("says the change and gate it came from, and that the gate waits for it", () => {
    const html = renderToStaticMarkup(
      <OwnerQuestionCard
        q={{
          id: "q-0123456789ab",
          system: "add-holds",
          owner: "team-ledger",
          question: "What availability does forge-ledger promise?",
          neededFact: "The SLO of forge-ledger is not known.",
          channel: "Atticus",
          state: "sent",
          records: [],
          file: "questions/q-0123456789ab.yaml",
          finding: { change: "add-holds", gate: "design", id: "gap-slo-known-ledger" },
        }}
        onAnswered={() => {}}
      />,
    );
    expect(html).toContain(
      esc(COPY.questions.ownerQuestions.fromFinding("add-holds", "design", "gap-slo-known-ledger")),
    );
  });
});
