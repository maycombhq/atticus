import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { EvidenceContext, staticEvidence, type FactsView } from "../src/app/evidence.js";
import {
  arrowCalls,
  callerLine,
  callerLines,
  isRoutingLink,
  linkBasis,
  proxyRepos,
  routingActions,
  uncitedRepos,
} from "../src/screens/architecture/links.js";
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

  it("offers only a forwarding call's line, never a line that cites another fact", () => {
    // Review of beta.27: the route's entry is not its forwarding, so with no call there is none.
    const noCall: FactsView = { ...PROXY_FACTS, facts: [ENTRY], questions: [QUESTION] };
    expect(routingActions([ROUTE], () => noCall)).toEqual({ questions: [], forwarding: [] });
    const nothing: FactsView = { ...PROXY_FACTS, facts: [], questions: [] };
    expect(routingActions([ROUTE], () => nothing)).toEqual({ questions: [], forwarding: [] });
    expect(routingActions([ROUTE], () => undefined)).toEqual({ questions: [], forwarding: [] });
  });
});

/** Review of beta.27: what is a proxy's routing, and what is a link that cites no caller's line. */
const READER: Api.HierJoinT = {
  ...JOIN,
  interface: "if-reader",
  how: "unknown",
  gateway: false,
  verified: false,
  caller: [],
  hops: [],
  other: [{ source: "reader", repo: "forge-web", at: "src/accounts.service.ts" }],
};
/** A caller's evidence that names its repo but no line: no line of a caller's either. */
const NO_LINE: Api.HierJoinT = {
  ...JOIN,
  interface: "if-no-line",
  caller: [{ source: "code", repo: "forge-web", at: "src/accounts.service.ts" }],
};

describe("a link that cites no line of a caller's but is no proxy's routing", () => {
  it("is a proxy's routing only through a gateway with a proxy's line", () => {
    expect(isRoutingLink(READER)).toBe(false);
    expect(isRoutingLink({ ...READER, gateway: true })).toBe(false);
    expect(isRoutingLink({ ...ROUTE, hops: [] })).toBe(false);
    expect(isRoutingLink({ ...ROUTE, gateway: false })).toBe(false);
    expect(isRoutingLink(ROUTE)).toBe(true);
    expect(proxyRepos([READER])).toEqual([]);
  });

  it("is its own kind, left alone and said apart from a proxy's routing", () => {
    expect(linkBasis(READER, viewOf)).toEqual({ kind: "uncited" });
    expect(linkBasis(ROUTE, viewOf)).toEqual({ kind: "routing" });
    const found = arrowCalls([READER, ROUTE], viewOf);
    expect(found.uncited).toEqual(["if-reader"]);
    expect(found.routing).toEqual(["if-route-get"]);
    expect(uncitedRepos([READER, NO_LINE, ROUTE])).toEqual(["forge-web"]);
    expect(uncitedRepos([{ ...READER, other: [] }])).toEqual([]);
  });

  it("tests a caller's line the same way everywhere: a line without its number is none", () => {
    expect(callerLines(NO_LINE)).toEqual([]);
    expect(callerLine(NO_LINE)).toBeUndefined();
    expect(linkBasis(NO_LINE, viewOf)).toEqual({ kind: "uncited" });
    expect(callerLine(JOIN)).toEqual({ repo: "forge-web", at: "src/accounts.service.ts:21" });
  });

  it("This link is wrong says no caller's line is cited, with the read again, no proxy's actions", () => {
    for (const join of [READER, NO_LINE]) {
      const page = html(
        <EvidenceContext.Provider value={staticEvidence(ready(views))}>
          <LinkWrong join={join} known={[]} startOpen />
        </EvidenceContext.Provider>,
      );
      expect(page).toContain(esc(W.uncitedLink));
      expect(page).not.toContain(esc(W.routingLink));
      expect(page).not.toContain(esc(R.answer));
      expect(page).not.toContain(esc(R.forwarding));
      expect(page).not.toContain('type="submit"');
      expect(page).toContain(esc(R.terminal));
      expect(page).toContain("atticus verify forge-web --write");
      expect(page).not.toContain("atticus questions");
    }
  });

  it("the arrow says so, and gives the read again when no repo is named", () => {
    const page = html(<ArrowWrongForm link={edge([READER])} viewOf={viewOf} known={[]} />);
    expect(page).not.toContain(esc(W.arrow.open));
    expect(page).not.toContain('type="submit"');
    expect(page).toContain(esc(W.arrow.uncited(1)));
    expect(page).not.toContain(esc(R.all(1)));
    expect(page).toContain("atticus verify forge-web --write");
    const nameless = html(
      <ArrowWrongForm link={edge([{ ...ROUTE, hops: [] }])} viewOf={viewOf} known={[]} startOpen />,
    );
    expect(nameless).toContain(esc(W.arrow.uncited(1)));
    expect(nameless).toContain("atticus verify --all --write");
    expect(nameless).not.toContain(esc(R.none));
  });

  it("a mixed arrow names them beside the calls it corrects", () => {
    const page = html(
      <ArrowWrongForm link={edge([JOIN, READER])} viewOf={viewOf} known={[]} startOpen />,
    );
    expect(page).toContain(esc(W.arrow.save(1)));
    expect(page).toContain(esc(W.arrow.uncited(1)));
  });
});

/**
 * Review of beta.27: a question is this arrow's only when it cites the forwarding call's own line
 * of this arrow's route: not the route's entry line (every route's), nor the config that ties it.
 */
const TIE_LINE = "edge/env/prod/targetservers.json:4";
const SHARED_LINE = "apiproxy/targets/core.xml:5";
const at = (s: string) => ({ file: s.split(":")[0]!, line: Number(s.split(":")[1]) });
const entryOf = (id: string, path: string, line: string): Api.FactCiteViewT => ({
  ...ENTRY,
  id,
  label: `GET ${path}`,
  claim: { method: "GET", path, value: path },
  cite: { ...at(line), value: path },
});
const forwardOf = (id: string, path: string, from: string): Api.FactCiteViewT => ({
  ...FORWARD,
  id,
  label: `GET ${path}`,
  claim: { method: "GET", path, base: "core-backend", from, value: "core-backend" },
  cite: { ...at(SHARED_LINE), value: "core-backend" },
});
const Q_ACCOUNTS = {
  id: "q-targets-accounts-core",
  question:
    "Which repo serves the routes under /accounts/** that wallets-proxy forwards to core-backend?",
  evidence: [SHARED_LINE],
};
const Q_CARDS = {
  id: "q-targets-cards-core",
  question:
    "Which repo serves the routes under /cards/** that wallets-proxy forwards to core-backend?",
  evidence: [SHARED_LINE],
};
const sharedView = (accountsLine: string, cardsLine: string): FactsView => ({
  ...PROXY_FACTS,
  facts: [
    entryOf("entry.get.accounts", "/accounts/*", accountsLine),
    entryOf("entry.get.cards", "/cards/*", cardsLine),
    forwardOf("call.forward.accounts", "/accounts/{id}", "entry.get.accounts"),
    forwardOf("call.forward.cards", "/cards/{id}", "entry.get.cards"),
  ],
  questions: [Q_ACCOUNTS, Q_CARDS],
});
const routeThrough = (iface: string, path: string, entryLine: string): Api.HierJoinT => ({
  ...ROUTE,
  interface: iface,
  path,
  hops: [
    { source: "gateway", repo: PROXY, at: entryLine },
    { source: "gateway", repo: PROXY, at: SHARED_LINE },
  ],
});

describe("the questions a routing arrow offers", () => {
  it("never offers a question that cites only the route's entry line or its tie", () => {
    const tied: Api.HierJoinT = {
      ...ROUTE,
      hops: [...ROUTE.hops, { source: "config", repo: "forge-env-config", at: TIE_LINE }],
    };
    const v: FactsView = {
      ...PROXY_FACTS,
      questions: [
        QUESTION,
        {
          id: "q-proxy-owner",
          question: "Which team owns wallets-proxy's default ProxyEndpoint?",
          evidence: [ROUTE_LINE],
        },
        { id: "q-tie", question: "Which host is core-backend in prod?", evidence: [TIE_LINE] },
      ],
    };
    expect(routingActions([tied], () => v).questions.map((q) => q.id)).toEqual([QUESTION.id]);
    // The tie's repo is not the proxy's: its facts aren't read for the route's actions.
    expect(proxyRepos([tied])).toEqual([PROXY]);
  });

  it("two routes through one TargetEndpoint line: only this arrow's question", () => {
    const own = sharedView("apiproxy/proxies/default.xml:4", "apiproxy/proxies/default.xml:9");
    const accounts = routeThrough(
      "if-accounts",
      "/accounts/{id}",
      "apiproxy/proxies/default.xml:4",
    );
    expect(routingActions([accounts], () => own)).toEqual({
      questions: [{ id: Q_ACCOUNTS.id, question: Q_ACCOUNTS.question, repo: PROXY }],
      forwarding: [{ repo: PROXY, at: SHARED_LINE }],
    });
    // Both routes' entries on one line (the ProxyEndpoint's): told apart by the route's path.
    const one = sharedView("apiproxy/proxies/default.xml:2", "apiproxy/proxies/default.xml:2");
    const both = routeThrough("if-accounts", "/accounts/{id}", "apiproxy/proxies/default.xml:2");
    expect(routingActions([both], () => one).questions.map((q) => q.id)).toEqual([Q_ACCOUNTS.id]);
  });

  // Re-review of beta.27: when several questions cite the forwarding line and none is about this
  // route's path, none is offered (it was all of them, so another route's became the primary action).
  it("offers no question when several cite the forwarding line and none is this route's", () => {
    const own = sharedView("apiproxy/proxies/default.xml:4", "apiproxy/proxies/default.xml:9");
    const other = {
      ...own,
      questions: [
        {
          ...Q_ACCOUNTS,
          id: "q-payments",
          question: Q_ACCOUNTS.question.replace("/accounts/**", "/payments/**"),
        },
        {
          ...Q_CARDS,
          id: "q-refunds",
          question: Q_CARDS.question.replace("/cards/**", "/refunds/**"),
        },
      ],
    };
    const accounts = routeThrough(
      "if-accounts",
      "/accounts/{id}",
      "apiproxy/proxies/default.xml:4",
    );
    expect(routingActions([accounts], () => other).questions).toEqual([]);
    // The forwarding line is still offered.
    expect(routingActions([accounts], () => other).forwarding).toEqual([
      { repo: PROXY, at: SHARED_LINE },
    ]);
  });

  it("labels each of several questions with what tells it apart, in its visible words", () => {
    const own = sharedView("apiproxy/proxies/default.xml:4", "apiproxy/proxies/default.xml:9");
    const joins = [
      routeThrough("if-accounts", "/accounts/{id}", "apiproxy/proxies/default.xml:4"),
      routeThrough("if-cards", "/cards/{id}", "apiproxy/proxies/default.xml:9"),
    ];
    expect(routingActions(joins, () => own).questions).toEqual([
      { id: Q_ACCOUNTS.id, question: Q_ACCOUNTS.question, repo: PROXY, what: "/accounts/**" },
      { id: Q_CARDS.id, question: Q_CARDS.question, repo: PROXY, what: "/cards/**" },
    ]);
    const page = html(<RoutingActions joins={joins} of={() => ({ state: "ready", data: own })} />);
    expect(page).toContain(`>${esc(R.answerFor("/accounts/**"))}<`);
    expect(page).toContain(`>${esc(R.answerFor("/cards/**"))}<`);
    expect(page).toContain(`aria-label="${esc(R.answerOf(Q_ACCOUNTS.question, "/accounts/**"))}"`);
    // The label in the name: the accessible name starts with the words shown.
    expect(R.answerOf(Q_CARDS.question, "/cards/**").startsWith(R.answerFor("/cards/**"))).toBe(
      true,
    );
    // One forwarding line for both: one button.
    expect(page.split(`>${esc(R.forwarding)}<`).length - 1).toBe(1);
  });
});

/** Review of beta.27: a chain of gateways: only the last hop's forwarding reaches the target. */
const EDGE_PROXY = "forge-edge-proxy";
const EDGE_ENTRY_LINE = "apiproxy/proxies/default.xml:3";
const EDGE_FORWARD_LINE = "apiproxy/targets/wallets.xml:6";
const CHAIN: Api.HierJoinT = {
  ...ROUTE,
  interface: "if-chain",
  hops: [
    { source: "gateway", repo: EDGE_PROXY, at: EDGE_ENTRY_LINE },
    { source: "gateway", repo: EDGE_PROXY, at: EDGE_FORWARD_LINE },
    { source: "gateway", repo: PROXY, at: ROUTE_LINE },
    { source: "gateway", repo: PROXY, at: FORWARD_LINE },
  ],
};
const EDGE_FACTS: FactsView = {
  ...PROXY_FACTS,
  repo: EDGE_PROXY,
  facts: [
    { ...ENTRY, id: "entry.edge", cite: { ...at(EDGE_ENTRY_LINE), value: "/accounts/*" } },
    {
      ...FORWARD,
      id: "call.edge.forward",
      claim: { path: "/accounts", to: "wallets-proxy", from: "entry.edge", value: "wallets" },
      cite: { ...at(EDGE_FORWARD_LINE), value: "wallets" },
    },
  ],
  questions: [
    {
      id: "q-edge-targets",
      question:
        "Which repo serves the routes under /accounts/** that edge-proxy forwards to wallets?",
      evidence: [EDGE_FORWARD_LINE],
    },
  ],
};

describe("a chain of gateways", () => {
  it("offers only the last hop's forwarding and its question", () => {
    const chainOf = (r: string) => (r === EDGE_PROXY ? EDGE_FACTS : PROXY_FACTS);
    expect(proxyRepos([CHAIN])).toEqual([EDGE_PROXY, PROXY]);
    expect(routingActions([CHAIN], chainOf)).toEqual({
      questions: [{ id: QUESTION.id, question: QUESTION.question, repo: PROXY }],
      forwarding: [{ repo: PROXY, at: FORWARD_LINE }],
    });
  });

  it("offers nothing of an earlier hop when the last hop's forwarding isn't found", () => {
    const noCall: FactsView = { ...PROXY_FACTS, facts: [ENTRY], questions: [] };
    expect(routingActions([CHAIN], (r) => (r === EDGE_PROXY ? EDGE_FACTS : noCall))).toEqual({
      questions: [],
      forwarding: [],
    });
    // The last proxy's facts not read: nothing of the first proxy's either.
    expect(routingActions([CHAIN], (r) => (r === EDGE_PROXY ? EDGE_FACTS : undefined))).toEqual({
      questions: [],
      forwarding: [],
    });
  });

  it("with no forwarding call, says so and gives the commands", () => {
    const noCall: FactsView = { ...PROXY_FACTS, facts: [ENTRY], questions: [] };
    const page = html(
      <RoutingActions joins={[ROUTE]} of={() => ({ state: "ready", data: noCall })} />,
    );
    expect(page).toContain(esc(R.none));
    expect(page).toContain(esc(`atticus verify ${PROXY} --write`));
    expect(page).not.toContain(esc(R.forwarding));
  });
});

/** Review of beta.27: one proxy's facts failing, or never read, never blanks or hangs the rest. */
const CARDS_PROXY = "forge-cards-proxy";
const CARDS_ROUTE: Api.HierJoinT = {
  ...ROUTE,
  interface: "if-cards-route",
  hops: [
    { source: "gateway", repo: CARDS_PROXY, at: ROUTE_LINE },
    { source: "gateway", repo: CARDS_PROXY, at: FORWARD_LINE },
  ],
};

describe("reading the proxies' facts", () => {
  it("one proxy failing keeps the others' actions, and says which failed", () => {
    const page = html(
      <RoutingActions
        joins={[ROUTE, CARDS_ROUTE]}
        of={(r) =>
          r === PROXY ? { state: "ready", data: PROXY_FACTS } : { state: "error", error: "gone" }
        }
      />,
    );
    expect(page).toContain(`href="#/questions/${QUESTION.id}"`);
    expect(page).toContain(esc(R.forwarding));
    expect(page).toContain(esc(R.failed(CARDS_PROXY, "gone")));
    expect(page).toContain(esc(`atticus verify ${CARDS_PROXY} --write`));
  });

  it("several forwarding lines each say which in their visible words", () => {
    const page = html(
      <RoutingActions
        joins={[ROUTE, CARDS_ROUTE]}
        of={(r) => ({ state: "ready", data: { ...PROXY_FACTS, repo: r, questions: [] } })}
      />,
    );
    expect(page).toContain(`>${esc(R.forwardingOf(PROXY, FORWARD_LINE))}<`);
    expect(page).toContain(`>${esc(R.forwardingOf(CARDS_PROXY, FORWARD_LINE))}<`);
  });

  it("one still loading keeps the others' actions, and says it is reading", () => {
    const page = html(
      <RoutingActions
        joins={[ROUTE, CARDS_ROUTE]}
        of={(r) => (r === PROXY ? { state: "ready", data: PROXY_FACTS } : { state: "loading" })}
      />,
    );
    expect(page).toContain(`href="#/questions/${QUESTION.id}"`);
    expect(page).toContain(esc(R.loading));
    expect(page).not.toContain(esc(R.none));
  });

  it("never stays reading without an evidence provider", () => {
    const page = html(<LinkWrong join={ROUTE} known={[]} startOpen />);
    expect(page).not.toContain(esc(R.loading));
    expect(page).toContain(esc(R.none));
    expect(page).toContain(esc(`atticus verify ${PROXY} --write`));
  });

  it("an arrow's form never stays reading when its facts hold no proxy", () => {
    const page = html(<ArrowWrongForm link={edge([ROUTE])} viewOf={() => undefined} known={[]} />);
    expect(page).not.toContain(esc(R.loading));
    expect(page).toContain(esc(R.none));
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
    expect(failed).toContain(esc(R.failed(PROXY, "gone")));
    expect(failed).toContain(esc(`atticus verify ${PROXY} --write`));
    // Re-review: a read that failed is not "no forwarding call found".
    expect(failed).not.toContain(esc(R.none));
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
