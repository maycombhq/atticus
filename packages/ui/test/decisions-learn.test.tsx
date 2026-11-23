import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import { LearnPanel, LearnResultView } from "../src/screens/map/Decisions.js";

/**
 * ADR 0208, Learn from my corrections on Map › Decided by AI: one button, its running, failed
 * and empty states, and what a run did (rules active with what they reproduced, drafts with why),
 * every word from the copy file.
 */

const L = COPY.decisions.learn;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

describe("Learn from my corrections (ADR 0208)", () => {
  it("offers the one button, with what it does", () => {
    const h = renderToStaticMarkup(<LearnPanel />);
    expect(h).toContain(esc(L.title));
    expect(h).toContain(esc(L.intro));
    expect(h).toMatch(/<button type="button" class="btn"[^>]*>Learn from my corrections</);
  });

  it("says it is running (the button held), or why it failed", () => {
    const running = renderToStaticMarkup(<LearnPanel initial={{ state: "running" }} />);
    expect(running).toContain(esc(L.running));
    expect(running).toContain('disabled=""');
    expect(running).toContain('aria-busy="true"');
    const failed = renderToStaticMarkup(
      <LearnPanel initial={{ state: "failed", why: "runtime.yaml turns AI off here" }} />,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(esc(L.failed("runtime.yaml turns AI off here")));
  });

  it("says when there was nothing to learn from", () => {
    const h = renderToStaticMarkup(
      <LearnResultView r={{ corrections: 0, active: [], draft: [], untaught: [] }} />,
    );
    expect(h).toContain(esc(L.none));
  });

  it("lists the rules made active, those left drafts with why, and what wasn't learned", () => {
    const h = renderToStaticMarkup(
      <LearnResultView
        r={{
          corrections: 4,
          active: [
            {
              key: "path-from-constant",
              file: "org-pack/reading-rules/types/spring-boot.yaml",
              reproduced: ["a", "b", "c"],
            },
          ],
          draft: [
            {
              key: "soap-action",
              file: "org-pack/reading-rules/types/spring-boot.yaml",
              why: "it didn't reproduce forge-billing src/A.java:9",
            },
          ],
          untaught: [{ correction: "forge-billing src/B.java:3", why: "its repo has no type" }],
        }}
      />,
    );
    expect(h).toContain(esc(L.since(4)));
    expect(h).toContain(
      esc(L.active("path-from-constant", "org-pack/reading-rules/types/spring-boot.yaml", 3)),
    );
    expect(h).toContain(
      esc(L.draft("soap-action", "org-pack/reading-rules/types/spring-boot.yaml")),
    );
    expect(h).toContain(esc("it didn't reproduce forge-billing src/A.java:9"));
    expect(h).toContain(esc(L.untaught("forge-billing src/B.java:3", "its repo has no type")));
  });
});
