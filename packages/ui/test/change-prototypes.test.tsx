import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { ChangePrototypes, PrototypeComparison } from "../src/screens/ChangePrototypes.js";

/**
 * ADR 0133: a prototype compared with the estate, on the change page: the four groups, each call
 * cited on both sides, what differs, and the prototype marked as one. The comparison is the
 * fixture's hand-written one (fixtures/prototype-compare/expected/comparison.yaml).
 */
const T = COPY.changes;
const FX = join(__dirname, "..", "..", "..", "fixtures", "prototype-compare");
const comparison = parse(
  readFileSync(join(FX, "expected/comparison.yaml"), "utf8"),
) as Api.ChangePrototypeT["comparison"];
const html = (s: string) => s.replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

describe("the prototype on the change page", () => {
  it("shows loading until the comparison comes, under a labelled heading", () => {
    const out = renderToStaticMarkup(<ChangePrototypes change="loyalty-at-checkout" />);
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain(`<h2 id="p-the-prototype-compared" class="h">${T.prototypes}</h2>`);
  });

  it("says how to attach one when there is none", () => {
    expect(T.noPrototypes("loyalty-at-checkout")).toBe(
      "No prototype is attached. Compare one with the estate: atticus change attach loyalty-at-checkout --prototype <repo>",
    );
  });

  it("shows the four groups, each call cited in the prototype and the estate or vendor, and what differs", () => {
    const out = renderToStaticMarkup(
      <PrototypeComparison
        p={{
          repo: "forge-checkout-prototype",
          attached: "inputs/prototype-forge-checkout-prototype.md",
          about: { text: "A clickable prototype of checkout.", trust: "suggested" },
          comparison,
        }}
      />,
    );
    expect(out).toContain(`<span class="chip">${T.prototypeMarker}</span>`);
    expect(out).toContain(`A clickable prototype of checkout. (${T.prototypeUnconfirmed})`);
    expect(out).toContain(T.prototypeCounts({ exists: 2, changes: 1, new: 2, vendor: 1 }));
    for (const [g, n] of [
      ["exists", 2],
      ["changes", 1],
      ["new", 2],
      ["vendor", 1],
    ] as const) {
      expect(out).toContain(`aria-label="${T.prototypeGroup[g]}"`);
      expect(out).toContain(`${T.prototypeGroup[g]} · ${n}`);
    }
    for (const c of comparison!.calls) expect(out).toContain(html(c.sentence));
    expect(out).toContain(T.prototypeCites("ui/src/api.ts:3", "bff/src/server.ts:10"));
    expect(out).toContain(
      T.prototypeEstate("forge-shop-bff", "src/main/java/forge/shop/CheckoutController.java:16"),
    );
    expect(out).toContain(
      T.prototypeVendor("Northwind Pay", "inputs/partner-specs/northwind-pay-openapi-v2.yaml:46"),
    );
    expect(out).toContain(
      html(
        "the response field loyaltyPoints (bff/src/types.ts:9) isn't in forge-shop-bff's response",
      ),
    );
    // Headings in order: the panel's h2, the prototype's h3, each group's h4.
    expect(out).toMatch(/<h3 id="proto-forge-checkout-prototype"/);
    expect(out.match(/<h4 /g)).toHaveLength(4);
  });

  it("says why a prototype can't be compared, and shows no stale groups", () => {
    const out = renderToStaticMarkup(
      <PrototypeComparison
        p={{
          repo: "forge-checkout-prototype",
          attached: "inputs/prototype-forge-checkout-prototype.md",
          problem: "forge-checkout-prototype has no verified facts yet.",
        }}
      />,
    );
    expect(out).toContain('role="status"');
    expect(out).toContain("has no verified facts yet.");
    expect(out).toContain(T.prototypeNoAbout);
    expect(out).not.toContain("<h4 ");
  });
});
