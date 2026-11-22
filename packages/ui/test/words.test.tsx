import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { screenOf } from "../src/app/screens.js";
import { COPY } from "../src/copy.js";
import { Words } from "../src/screens/run/Words.js";

/** What the words mean (WP5.1): Atticus's own words, a page of Home from the Words link. */
describe("what the words mean", () => {
  it("is a page of Home, from the Words link, listing every term with its sentence", () => {
    expect(screenOf("words")?.section).toBe("Home");
    const out = renderToStaticMarkup(<Words />);
    for (const t of COPY.glossary.terms) {
      expect(out).toContain(`<strong>${t.term}</strong>`);
      expect(out).toContain(
        t.says
          .replace(/&/g, "&amp;")
          .replace(/'/g, "&#x27;")
          .replace(/"/g, "&quot;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;"),
      );
    }
  });
});

/** v30 slice 8: one name per thing; each word that was renamed says the names it replaces. */
describe("one name per thing", () => {
  const term = (t: string) => COPY.glossary.terms.find((x) => x.term === t);
  it("lists the renamed words with the names they replace, and the guide's page", () => {
    expect(term("Map")).toMatchObject({ was: expect.stringContaining("Estate canvas") });
    expect(term("Read status")).toMatchObject({ was: "Trust" });
    expect(term("Cross-check")).toMatchObject({ was: "Readers found / facts say" });
    expect(term("call with no arrow")).toMatchObject({ was: "loose call" });
    // Everything a person told Atticus that the build keeps is one of "your changes"; a decision
    // is only the AI's, or the knowledge kind.
    expect(term("your changes")).toMatchObject({
      was: expect.stringContaining("curated decision"),
    });
    // Connect's list of what people told Atticus on a box is "Your changes" too.
    expect(term("your changes")).toMatchObject({
      was: expect.stringContaining("Corrections and declarations"),
    });
    expect(term("declared arrow")!.says).toMatch(/never counted with arrows read from code/);
    expect(term("your kept edit")!.says).toMatch(/one of your changes/);
    expect(term("decision")!.says).toMatch(/Only the AI's decisions/);
    expect(term("your decision")).toBeUndefined();
    expect(term("loose end")!.says).toMatch(/for a call, the map draws no arrow/);
    for (const t of ["Apply", "Write", "Propose", "your changes", "outside system", "Activity"])
      expect(term(t), t).toBeDefined();
    expect(term("Apply")!.says).toMatch(/The button Apply means only this/);
    expect(COPY.glossary.intro).toContain("docs/guide/words.md");
    const out = renderToStaticMarkup(<Words />);
    expect(out).toContain(COPY.glossary.was("loose call"));
  });

  // The whole-release review of beta.30: two words for one command, each with its meaning.
  it("says what Accept and Waive are, and that one command does both", () => {
    expect(term("Accept")!.says).toMatch(/a stage's blocking finding/);
    expect(term("Accept")!.says).toContain("atticus finding <change> <id> waive");
    expect(term("Accept")!.says).toMatch(/no undo/i);
    expect(term("Waive")!.says).toMatch(/a critic's finding/);
    expect(term("Waive")!.says).toContain("atticus finding <change> <id> waive");
    expect(term("Waive")!.says).toMatch(/constitution rule/);
  });

  it("names the Map's pages and Activity once each in the menu's words", () => {
    expect(COPY.nav.screens.canvas).toBe("Map");
    expect(COPY.nav.screens.trust).toBe("Read status");
    expect(COPY.nav.screens.crosscheck).toBe("Cross-check");
    expect(COPY.nav.screens.activity).toBe("Activity");
    // The old names stay only as what Ctrl+K finds a page by.
    expect(Object.values(COPY.nav.formerly)).toEqual([
      "Estate canvas",
      "Ecosystem map",
      "Impact explorer",
      "Trust",
      "Readers found / facts say",
    ]);
  });
});
