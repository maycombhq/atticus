import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { Inspector } from "../src/screens/architecture/Architecture.js";
import { WhyLinked } from "../src/screens/architecture/WhyLinked.js";

/** Why is this linked (ADR 0135, C1): each call on a link, how it was joined and both ends. */

const W = COPY.why;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

export const HOST: Api.HierJoinT = {
  interface: "if-0f06d434a34c81c9",
  from: "web-app",
  to: "customers-api",
  how: "host",
  gateway: false,
  verified: true,
  method: "POST",
  path: "/api/customers",
  caller: [
    { source: "code", repo: "forge-web", at: "src/customer.service.ts:21" },
    { source: "config", repo: "forge-web", at: "src/environment.ts:4" },
  ],
  callee: [{ source: "code", repo: "forge-customers", at: "src/CustomerController.java:24" }],
  hops: [],
  other: [],
};
export const GUESS: Api.HierJoinT = {
  interface: "if-1",
  from: "web-app",
  to: "customers-api",
  how: "path",
  gateway: true,
  verified: false,
  method: "GET",
  path: "/api/tags",
  caller: [{ source: "code", repo: "forge-web", at: "src/tags.ts:7" }],
  callee: [],
  hops: [{ source: "gateway", repo: "forge-edge", at: "proxies/tags.xml:3" }],
  other: [],
};
export const LINK: Api.HierEdgeT = {
  id: "calls:system:web>system:customers",
  from: "system:web",
  to: "system:customers",
  type: "calls",
  count: 3,
  state: "current",
  gaps: ["inferred", "joined-by-path"],
  evidence: [],
  joins: [HOST, GUESS],
};

describe("why is this linked", () => {
  it("says how each call was joined, verified or inferred, with its lines at both ends", () => {
    const page = html(<WhyLinked link={LINK} />);
    expect(page).toContain(esc(W.call("web-app", "customers-api", "POST /api/customers")));
    expect(page).toContain(esc(W.how.host!));
    expect(page).toContain(W.verified);
    expect(page).toContain(esc(W.how.path!));
    expect(page).toContain(esc(W.gateway));
    expect(page).toContain(W.inferred);
    // Both ends, each a citation: the call and its config, the entry, the gateway's hop.
    for (const f of [
      "customer.service.ts",
      "environment.ts",
      "CustomerController.java",
      "tags.xml",
    ])
      expect(page).toContain(f);
    expect(page).toContain(esc(W.noLine));
    expect(page).toContain(esc(W.more(1)));
  });

  it("says a link that isn't a call has no join to explain", () => {
    expect(html(<WhyLinked link={{ ...LINK, joins: [] }} />)).toContain(esc(W.none));
  });

  it("opens from each link the details panel lists", () => {
    const page = html(
      <Inspector
        node={{
          id: "system:web",
          kind: "system",
          label: "Web",
          childCount: 1,
          state: "current",
          gaps: [],
          evidence: [],
          properties: {},
        }}
        lens="architecture"
        onOpen={() => undefined}
        onFocus={() => undefined}
        links={[LINK]}
        labelOf={(id) => (id === "system:web" ? "Web" : "Customers")}
      />,
    );
    expect(page).toContain("<details>");
    expect(page).toContain(esc(W.openOf(COPY.evidence.linkOf("Web", "Customers", "calls"))));
  });
});
