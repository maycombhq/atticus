import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import { AskReceivers } from "../src/screens/Explore.js";

// Beta.30: the app's Ask answers who receives a topic with consumers in two repos on its own
// panel: both receivers with why, and a way to what breaks at each of the topic's Endpoints. The
// data are the invented field-shaped Forge estate's (fixtures/forge-field).

describe("Ask: a topic received at two Endpoints", () => {
  it("names both receivers, nothing from past them, and links to each Endpoint's impact", () => {
    const html = renderToStaticMarkup(
      <AskReceivers
        r={{
          root: "forge-svc-00.on-forge-items-settled",
          roots: ["forge-svc-00.on-forge-items-settled", "forge-svc-03.on-forge-items-settled"],
          receivers: [
            {
              kind: "Component",
              id: "forge-svc-00",
              reason: "receives forge.items.settled from forge-svc-02",
            },
            {
              kind: "Component",
              id: "forge-svc-03",
              reason: "receives forge.items.settled from forge-svc-02",
            },
          ],
          further: [{ kind: "Interface", id: "if-0673a0bdf333cde7", reason: "calls forge-svc-00" }],
        }}
      />,
    );
    for (const c of ["forge-svc-00", "forge-svc-03"])
      expect(html).toContain(
        `<span class="mono">${c}</span> <span class="muted">receives forge.items.settled from forge-svc-02</span>`,
      );
    expect(html).not.toContain("if-0673a0bdf333cde7");
    expect(html.match(/href="#\/impact\?q=forge-svc-0[03]\.on-forge-items-settled"/g)).toHaveLength(
      2,
    );
  });

  it("names its list by the Read as line, and says so in words when nothing receives it", () => {
    const r = { root: "a.on-t", roots: ["a.on-t", "b.on-t"], receivers: [], further: [] };
    const empty = renderToStaticMarkup(<AskReceivers r={r} labelledBy="ask-read-as" />);
    expect(empty).toContain(COPY.explore.noReceivers);
    expect(empty).not.toContain("<ul");
    const one = renderToStaticMarkup(
      <AskReceivers
        r={{ ...r, receivers: [{ kind: "Component", id: "a", reason: "receives t from p" }] }}
        labelledBy="ask-read-as"
      />,
    );
    expect(one).toContain(
      '<ul class="stack" style="gap:4px;margin:0;padding-left:18px" aria-labelledby="ask-read-as">',
    );
  });
});
