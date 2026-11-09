import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Api as CoreApi,
  JOIN_GUESS_FLAGS,
  JOINED_BY_PATH_OVERLAP,
  type Api,
} from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { Inspector } from "../src/screens/architecture/Architecture.js";
import { WhyLinked } from "../src/screens/architecture/WhyLinked.js";
import { WORDS } from "../src/screens/architecture/words.js";

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

  it("has words for every way a call is joined, and says a J0 or J1 guess is one (ADR 0124 addendum)", () => {
    for (const how of CoreApi.LINK_HOWS) expect(W.how[how], how).toBeTruthy();
    for (const how of ["platform-setting", "folder-name", "conflict"] as const) {
      const page = html(
        <WhyLinked link={{ ...LINK, joins: [{ ...GUESS, how, gateway: false }] }} />,
      );
      expect(page).toContain(esc(W.how[how]!));
      expect(page).toContain(W.inferred);
    }
  });

  it("names every guess as a gap with what closes it, and in a change's impact", () => {
    for (const g of JOIN_GUESS_FLAGS) {
      expect(WORDS.gap[g], g).toBeTruthy();
      expect(WORDS.gapFix[g], g).toBeTruthy();
      expect(COPY.changeImpact.guessWords[g], g).toBeTruthy();
    }
  });

  it("names an Apigee proxy's link matched under a guessed base path as a gap, with what closes it", () => {
    // The path suffix: the Interface's flag, not one of the local API's guesses.
    expect(JOIN_GUESS_FLAGS).not.toContain(JOINED_BY_PATH_OVERLAP);
    expect(WORDS.gap[JOINED_BY_PATH_OVERLAP]).toBeTruthy();
    expect(WORDS.gapFix[JOINED_BY_PATH_OVERLAP]).toContain("basePath");
  });

  it("says a call joined to another team's shared map is theirs, with their line and commit, never a citation of ours (O3)", () => {
    const shared: Api.HierJoinT = {
      ...GUESS,
      interface: "if-2",
      to: "forge-risk",
      how: "shared",
      gateway: false,
      callee: [
        {
          source: "code",
          repo: "forge-risk-scoring",
          at: "src/main/java/forge/risk/ScoresController.java:12",
        },
      ],
      hops: [],
      shared: {
        team: "forge-risk-team",
        repo: "forge-risk-scoring",
        at: "src/main/java/forge/risk/ScoresController.java:12",
        commit: "5555eee",
      },
    };
    const page = html(<WhyLinked link={{ ...LINK, joins: [shared] }} />);
    expect(page).toContain(esc(W.how.shared!));
    expect(page).toContain(esc(W.sharedMap("forge-risk-team", "5555eee")));
    expect(page).toContain(esc(W.sharedTheirs("forge-risk-team")));
    expect(page).toContain("forge-risk-scoring: ");
    expect(page).toContain("ScoresController.java:12");
    expect(WORDS.gap["not-in-shared-map"]).toBeTruthy();
    expect(WORDS.gapFix["not-in-shared-map"]).toBeTruthy();
  });

  it("says a declared topic is the person's word, with the profile's line, never inferred (ADR 0162 §6)", () => {
    const declared: Api.HierJoinT = {
      interface: "if-3",
      from: "tidewater",
      to: "ledger-api",
      how: "declared",
      gateway: false,
      verified: false,
      path: "tidewater.rates",
      caller: [],
      callee: [],
      hops: [],
      other: [
        { source: "code", repo: "forge-ledger", at: "src/main/java/forge/ledger/Bus.java:7" },
        { source: "manual", at: "org-pack/profiles/ledger.yaml" },
      ],
    };
    const page = html(
      <WhyLinked
        link={{
          ...LINK,
          type: "subscribes",
          count: 1,
          gaps: ["declared-topic"],
          joins: [declared],
        }}
      />,
    );
    expect(page).toContain(esc(W.declaredTopic));
    expect(page).toContain(esc(W.declared));
    expect(page).not.toContain(W.inferred);
    expect(page).not.toContain(esc(W.how.declared!));
    expect(page).toContain(esc(W.declaredIn));
    expect(page).toContain("org-pack/profiles/ledger.yaml");
    expect(page).toContain("Bus.java:7");
    // A gateway route's declared caller keeps its own words.
    const route = html(
      <WhyLinked link={{ ...LINK, joins: [{ ...GUESS, how: "declared", gateway: true }] }} />,
    );
    expect(route).toContain(esc(W.how.declared!));
    expect(route).not.toContain(esc(W.declaredTopic));
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

describe("the details panel: each gap with what closes it (ADR 0135, C3)", () => {
  it("says beside each gap what closes it, and opens a repo's counts on Map › Trust", () => {
    const page = html(
      <Inspector
        node={{
          id: "repo:forge-web",
          kind: "repo",
          label: "forge-web",
          childCount: 0,
          state: "current",
          gaps: ["unverified"],
          evidence: [],
          properties: {},
        }}
        lens="repo"
        onOpen={() => undefined}
        onFocus={() => undefined}
      />,
    );
    expect(page).toContain(esc(WORDS.gapFix.unverified!));
    expect(page).toContain('href="#/trust"');
  });
});
