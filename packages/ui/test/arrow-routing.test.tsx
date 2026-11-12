import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { EvidenceContext, staticEvidence, type FactsView } from "../src/app/evidence.js";
import { isRoutingLink, proxyRepos, routingActions } from "../src/screens/architecture/links.js";
import {
  ArrowWrongForm,
  LinkWrong,
  RoutingActions,
} from "../src/screens/architecture/WhyLinked.js";

/**
 * Beta.27 (seen on beta.26): an arrow whose every call a gateway proxy's routing made (no line of
 * a caller's, joined by its path or the proxy's BasePath) has no call of a caller's to correct.
 * The panel never offers "All calls on this arrow are wrong" there, nor "Correct all 0 calls",
 * which could only fail: it says so in one sentence and offers what does correct the route, the
 * open question about where the proxy forwards (Answer where it goes, on Questions) and the
 * proxy's forwarding line with its Correct this; with neither, the commands in a terminal. A
 * call's own This link is wrong on such a link offers the same. A mixed arrow counts only the
 * calls it corrects.
 */

const W = COPY.why;
const R = W.routing;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const PROXY = "forge-wallets-proxy";
const ROUTE_LINE = "apiproxy/proxies/default.xml:4";
const FORWARD_LINE = "apiproxy/targets/accounts.xml:7";

/** A call of a caller's: its line is cited, so it is corrected. */
const JOIN: Api.HierJoinT = {
  interface: "if-0f06d434a34c81c9",
  from: "web-app",
  to: "accounts-api",
  how: "host",
  gateway: false,
  verified: true,
  method: "GET",
  path: "/accounts",
  caller: [{ source: "code", repo: "forge-web", at: "src/accounts.service.ts:21" }],
  callee: [{ source: "code", repo: "forge-accounts", at: "src/Accounts.java:9" }],
  hops: [],
  other: [],
};
/** Two links the proxy's routing made: no caller's line, the route and its forwarding call. */
const ROUTE: Api.HierJoinT = {
  ...JOIN,
  interface: "if-route-get",
  from: "wallets-proxy",
  path: "/accounts/{id}",
  gateway: true,
  verified: false,
  how: "path",
  caller: [],
  hops: [
    { source: "gateway", repo: PROXY, at: ROUTE_LINE },
    { source: "gateway", repo: PROXY, at: FORWARD_LINE },
  ],
  callee: [{ source: "code", repo: "forge-accounts", at: "src/Accounts.java:12" }],
};
const ROUTE_POST: Api.HierJoinT = {
  ...ROUTE,
  interface: "if-route-post",
  method: "POST",
  how: "base-path",
  path: "/accounts/{id}/holds",
};

const CALL: Api.FactCiteViewT = {
  id: "c-accounts",
  kind: "call",
  label: "GET /accounts",
  claim: { method: "GET", path: "/accounts", value: "/accounts" },
  cite: { file: "src/accounts.service.ts", line: 21, value: "/accounts" },
  verified: "line",
  by: "assistant",
};
const FACTS: FactsView = {
  repo: "forge-web",
  file: "facts/forge-web.jsonl",
  present: true,
  facts: [CALL],
  corrections: { file: "facts/forge-web.corrections.jsonl", count: 0, stale: [] },
  questions: [],
  verify: "atticus verify forge-web",
  problems: [],
};
const ENTRY: Api.FactCiteViewT = {
  id: "entry.get.accounts-id",
  kind: "entry",
  label: "GET /accounts/*",
  claim: { method: "GET", path: "/accounts/*", value: "/accounts/*" },
  cite: { file: "apiproxy/proxies/default.xml", line: 4, value: "/accounts/*" },
  verified: "line",
  by: "assistant",
};
const FORWARD: Api.FactCiteViewT = {
  id: "call.forward.accounts",
  kind: "call",
  label: "forwards to accounts-host",
  claim: { path: "/accounts", value: "accounts-host" },
  cite: { file: "apiproxy/targets/accounts.xml", line: 7, value: "accounts-host" },
  verified: "line",
  by: "assistant",
};
const QUESTION = {
  id: "q-targets-accounts",
  question:
    "Which repo serves the routes under /accounts/** that wallets-proxy forwards to accounts-host?",
  evidence: [FORWARD_LINE],
};
const PROXY_FACTS: FactsView = {
  ...FACTS,
  repo: PROXY,
  file: `facts/${PROXY}.jsonl`,
  facts: [ENTRY, FORWARD],
  questions: [QUESTION],
  verify: `atticus verify ${PROXY}`,
};
const views: Record<string, FactsView> = { "forge-web": FACTS, [PROXY]: PROXY_FACTS };
const viewOf = (r: string) => views[r];
const ready = (v: Record<string, FactsView>) =>
  Object.fromEntries(Object.entries(v).map(([k, d]) => [k, { state: "ready" as const, data: d }]));
const edge = (joins: Api.HierJoinT[], count = joins.length): Api.HierEdgeT => ({
  id: "calls:system:wallets>system:accounts",
  from: "system:wallets",
  to: "system:accounts",
  type: "calls",
  count,
  state: "current",
  gaps: [],
  evidence: [],
  joins,
});

describe("a gateway proxy's routing link, apart from React", () => {
  it("is a link with no line of a caller's, whose proxy is the repo of its hops", () => {
    expect(isRoutingLink(ROUTE)).toBe(true);
    expect(isRoutingLink(JOIN)).toBe(false);
    expect(isRoutingLink({ ...ROUTE, how: "declared" })).toBe(false);
    expect(proxyRepos([JOIN, ROUTE, ROUTE_POST])).toEqual([PROXY]);
  });

  it("finds the open question about where it goes and the proxy's forwarding line, once each", () => {
    expect(routingActions([ROUTE, ROUTE_POST], viewOf)).toEqual({
      questions: [{ id: QUESTION.id, question: QUESTION.question, repo: PROXY }],
      // The line with the forwarding call, not the route's entry.
      forwarding: [{ repo: PROXY, at: FORWARD_LINE }],
    });
  });

  it("falls back to the route's line when no call is cited on its lines, and to none", () => {
    const noCall: FactsView = { ...PROXY_FACTS, facts: [ENTRY], questions: [] };
    expect(routingActions([ROUTE], () => noCall)).toEqual({
      questions: [],
      forwarding: [{ repo: PROXY, at: ROUTE_LINE }],
    });
    const nothing: FactsView = { ...PROXY_FACTS, facts: [], questions: [] };
    expect(routingActions([ROUTE], () => nothing)).toEqual({ questions: [], forwarding: [] });
    expect(routingActions([{ ...ROUTE, hops: [] }], viewOf)).toEqual({
      questions: [],
      forwarding: [],
    });
  });
});

describe("an arrow whose every call is a proxy's routing", () => {
  const link = edge([ROUTE, ROUTE_POST]);

  it("never offers All calls on this arrow are wrong, nor Correct all 0 calls", () => {
    for (const startOpen of [false, true]) {
      const page = html(
        <ArrowWrongForm link={link} viewOf={viewOf} known={[]} startOpen={startOpen} />,
      );
      expect(page).not.toContain(esc(W.arrow.open));
      expect(page).not.toContain(esc(W.arrow.save(0)));
      expect(page).not.toContain('type="submit"');
      expect(page).toContain(esc(R.all(2)));
    }
  });

  it("offers Answer where it goes, on Questions, and the proxy's forwarding with Correct this", () => {
    const page = html(<ArrowWrongForm link={link} viewOf={viewOf} known={[]} />);
    expect(page).toContain(`href="#/questions/${QUESTION.id}"`);
    expect(page).toContain(esc(R.answer));
    expect(page).toContain(`aria-label="${esc(R.answerOf(QUESTION.question))}"`);
    expect(page).toContain(esc(R.forwarding));
    expect(page).toContain(`aria-label="${esc(R.forwardingOf(PROXY, FORWARD_LINE))}"`);
  });

  it("opens the forwarding line's facts, each with Correct this", () => {
    const page = html(
      <EvidenceContext.Provider value={staticEvidence(ready(views))}>
        <RoutingActions
          joins={[ROUTE]}
          of={(r) => ({ state: "ready", data: views[r]! })}
          openAt={FORWARD_LINE}
        />
      </EvidenceContext.Provider>,
    );
    expect(page).toContain('aria-expanded="true"');
    expect(page).toContain(esc(COPY.evidence.correct));
    expect(page).toContain(esc(FORWARD.label));
  });

  it("says so when an arrow too long to list turns out to be routing only, once read", () => {
    const capped = edge([ROUTE], 30);
    const page = html(
      <ArrowWrongForm
        link={capped}
        joins={[ROUTE, ROUTE_POST]}
        viewOf={viewOf}
        known={[]}
        startOpen
      />,
    );
    expect(page).not.toContain(esc(W.arrow.save(0)));
    expect(page).not.toContain('type="submit"');
    expect(page).toContain(esc(R.all(2)));
    expect(page).toContain(esc(R.answer));
  });

  it("reads the proxy's facts first, and says when it can't", () => {
    const reading = html(
      <ArrowWrongForm
        link={link}
        viewOf={viewOf}
        proxyOf={() => ({ state: "loading" })}
        known={[]}
      />,
    );
    expect(reading).toContain(esc(R.loading));
    expect(reading).toContain('aria-busy="true"');
    const failed = html(
      <ArrowWrongForm
        link={link}
        viewOf={viewOf}
        proxyOf={() => ({ state: "error", error: "gone" })}
        known={[]}
      />,
    );
    expect(failed).toContain(esc(R.failed("gone")));
    expect(failed).toContain(esc(`atticus verify ${PROXY} --write`));
  });

  it("with neither a question nor a forwarding line, says so and gives the commands", () => {
    const bare: FactsView = { ...PROXY_FACTS, facts: [], questions: [] };
    const page = html(
      <ArrowWrongForm link={link} viewOf={(r) => (r === PROXY ? bare : undefined)} known={[]} />,
    );
    expect(page).toContain(esc(R.none));
    expect(page).toContain(esc(R.terminal));
    expect(page).toContain("atticus questions");
    expect(page).toContain(esc(`atticus verify ${PROXY} --write`));
    expect(page).not.toContain(esc(R.answer));
    // No proxy line at all: the questions' command alone.
    const lineless = html(
      <ArrowWrongForm link={edge([{ ...ROUTE, hops: [] }])} viewOf={viewOf} known={[]} />,
    );
    expect(lineless).toContain(esc(R.none));
    expect(lineless).toContain("atticus questions");
    expect(lineless).not.toContain("atticus verify");
  });
});

describe("an arrow of some calls to correct and some routing", () => {
  it("counts only the calls it corrects, and says where the routing ones are corrected", () => {
    const page = html(
      <ArrowWrongForm
        link={edge([JOIN, ROUTE, ROUTE_POST])}
        viewOf={viewOf}
        known={[]}
        startOpen
      />,
    );
    expect(page).toContain(esc(W.arrow.open));
    expect(page).toContain(esc(W.arrow.title(1)));
    expect(page).toContain(esc(W.arrow.save(1)));
    expect(page).not.toContain(esc(W.arrow.save(3)));
    expect(page).toContain(esc(W.arrow.routing(2)));
  });

  it("never renders a submit for 0 calls when the callers' lines hold none", () => {
    const lost: Api.HierJoinT = {
      ...JOIN,
      caller: [{ source: "code", repo: "forge-web", at: "src/Gone.ts:1" }],
    };
    const page = html(
      <ArrowWrongForm link={edge([lost, ROUTE])} viewOf={viewOf} known={[]} startOpen />,
    );
    expect(page).not.toContain(esc(W.arrow.save(0)));
    expect(page).not.toContain('type="submit"');
    expect(page).toContain(esc(W.arrow.noCalls));
    expect(page).toContain(esc(W.arrow.routing(1)));
  });
});

describe("This link is wrong, on a call a proxy's routing made", () => {
  it("offers the same actions in place of the dead end", () => {
    const page = html(
      <EvidenceContext.Provider value={staticEvidence(ready(views))}>
        <LinkWrong join={ROUTE} known={[]} startOpen />
      </EvidenceContext.Provider>,
    );
    expect(page).toContain(esc(W.routingLink));
    expect(page).toContain(`href="#/questions/${QUESTION.id}"`);
    expect(page).toContain(esc(R.forwarding));
    expect(page).not.toContain(esc(W.noCall(PROXY)));
    expect(page).not.toContain('type="submit"');
  });

  it("still offers the correction form on a call of a caller's", () => {
    const page = html(
      <EvidenceContext.Provider value={staticEvidence(ready(views))}>
        <LinkWrong join={JOIN} known={[]} startOpen />
      </EvidenceContext.Provider>,
    );
    expect(page).toContain(esc(W.save));
    expect(page).not.toContain(esc(R.answer));
  });
});
