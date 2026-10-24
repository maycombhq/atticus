import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { screenOf } from "../src/app/screens.js";
import { COPY } from "../src/copy.js";
import { Words } from "../src/screens/run/Words.js";

/** What the words mean (WP5.1): Atticus's own words, in the Atticus section. */
describe("what the words mean", () => {
  it("is a page of the Atticus section listing every term with its sentence", () => {
    expect(screenOf("words")?.section).toBe("Atticus");
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
