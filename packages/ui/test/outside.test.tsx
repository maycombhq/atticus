import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { screenOf } from "../src/app/screens.js";
import { COPY } from "../src/copy.js";
import { SCREEN_COMPONENTS } from "../src/screens/registry.js";
import { OutsidePicker, OutsideSystemPanels, outsideHash } from "../src/screens/map/Outside.js";

/**
 * Map › Outside systems (plan item O4, ADR 0149): one page per system outside the estate, with
 * who calls it, its spec's operations, the calls matching nothing, its questions, and how to add
 * a spec when it has none. Northwind Pay is an invented vendor.
 */

const O = COPY.outside;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");

const NW = Api.OutsideSystemView.parse({
  id: "northwind-pay",
  name: "Northwind Pay",
  boundary: "vendor",
  owner: "team-payments",
  aliases: ["api.northwindpay.example"],
  callers: [
    {
      repo: "forge-billing",
      component: "billing-api",
      fact: "call.post.charges",
      at: "src/main/java/forge/billing/NorthwindClient.java:14",
      method: "POST",
      path: "/partners/northwind/charges",
      operation: "northwind-pay.post-charge",
      through: { repo: "forge-partner-gateway", at: "proxies/default.xml:5" },
      seen: ["spec"],
    },
  ],
  spec: {
    path: "inputs/partner-specs/northwind-pay-openapi-v2.yaml",
    title: "Northwind Pay API",
    version: "2.0.0",
    operations: [
      {
        id: "northwind-pay.post-charge",
        method: "POST",
        path: "/v1/charges",
        cite: "inputs/partner-specs/northwind-pay-openapi-v2.yaml:30",
        calls: 1,
      },
    ],
  },
  unmatched: [
    {
      repo: "forge-partner-gateway",
      at: "proxies/default.xml:8",
      method: "POST",
      path: "/v1/charges/{chargeId}/capture",
      seen: ["spec"],
      message: "no such operation",
    },
  ],
  ambiguous: [],
  questions: [{ id: "q-0123456789ab", repo: "forge-partner-gateway", question: "Still 7 days?" }],
});
const AUDIT = Api.OutsideSystemView.parse({
  id: "audit",
  name: "Audit",
  boundary: "internal",
  aliases: [],
  callers: [],
  unmatched: [],
  ambiguous: [],
  questions: [],
  addSpec: ["atticus intake add <the audit spec file>", "atticus intake list", "atticus triage"],
});

describe("the outside systems' pages (O4)", () => {
  it("is a page of Map reached from Systems and Ctrl+K, with its component", () => {
    expect(screenOf("outside")).toMatchObject({ section: "Map", aside: true });
    expect(SCREEN_COMPONENTS.outside).toBeDefined();
  });

  it("picks a system by name, marking the one shown", () => {
    const out = html(<OutsidePicker systems={[NW, AUDIT]} current="audit" />);
    expect(out).toContain(`aria-label="${esc(O.pick)}"`);
    expect(out).toContain(`href="${outsideHash("northwind-pay")}"`);
    expect(out).toMatch(/aria-current="page"[^>]*>Audit</);
  });

  it("shows who calls it, its operations with their calls, the calls matching nothing and its questions", () => {
    const out = html(<OutsideSystemPanels system={NW} />);
    expect(out).toContain(esc(O.boundary.vendor!));
    expect(out).toContain(esc(O.owner("team-payments")));
    expect(out).toContain("forge-billing (billing-api)");
    expect(out).toContain(esc(O.through("forge-partner-gateway", "proxies/default.xml:5")));
    expect(out).toContain('<th scope="col">');
    expect(out).toContain("<caption");
    expect(out).toContain(
      esc(
        O.specFrom(
          "inputs/partner-specs/northwind-pay-openapi-v2.yaml",
          "Northwind Pay API",
          "2.0.0",
        ),
      ),
    );
    expect(out).toContain("POST /v1/charges");
    expect(out).toContain("POST /v1/charges/{chargeId}/capture");
    expect(out).toContain("no such operation");
    expect(out).toContain("Still 7 days?");
    expect(out).toContain('href="#/questions/q-0123456789ab"');
    // Each panel is labelled by its heading.
    for (const h of [O.callers, O.operations, O.unmatched, O.questions])
      expect(out).toMatch(new RegExp(`<h2 id="[^"]+" class="h">${esc(h)}</h2>`));
  });

  it("says how to add a spec to a system with none, and when nothing calls it", () => {
    const out = html(<OutsideSystemPanels system={AUDIT} />);
    expect(out).toContain(esc(O.noSpec));
    expect(out).toContain(esc("atticus intake add <the audit spec file>"));
    expect(out).toContain(`aria-label="${esc(O.copy("atticus triage"))}"`);
    expect(out).toContain(esc(O.noCallers));
    expect(out).toContain(esc(O.noQuestions));
  });
});
