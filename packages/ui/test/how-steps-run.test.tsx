import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import { HowStepsRunLine } from "../src/screens/CommandCenter.js";

/** ADR 0121 item 6: Home says what runs a step here, in one line, with a link to the AI tab. */

const T = COPY.commandCenter;

describe("how AI steps run, on Home (ADR 0121)", () => {
  it("shows the line and a link to Set up › AI", () => {
    const html = renderToStaticMarkup(
      <HowStepsRunLine runs="Hand-off to GitHub Copilot · model mode allowed: anthropic" />,
    );
    expect(html).toContain(T.howStepsRun);
    expect(html).toContain("Hand-off to GitHub Copilot · model mode allowed: anthropic");
    expect(html).toContain('href="#/ai"');
  });

  it("shows nothing while it loads, and says so when it can't be read", () => {
    expect(renderToStaticMarkup(<HowStepsRunLine />)).toBe("");
    expect(renderToStaticMarkup(<HowStepsRunLine failed />)).toContain(
      T.howStepsRunCantRead.replace(/'/g, "&#x27;"),
    );
  });
});
