import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import type { FactsView } from "../src/app/evidence.js";
import {
  arrowCorrections,
  callerLine,
  callerLines,
  linkBasis,
  whatMoved,
} from "../src/screens/architecture/links.js";
import type { Views } from "../src/screens/architecture/model.js";
import {
  ArrowWrongForm,
  DeclaredLinkWrongView,
  WhyLinked,
} from "../src/screens/architecture/WhyLinked.js";

/**
 * Beta.24: a link a gateway's routing made can be corrected at its forwarding call, and "This
 * whole arrow is wrong" corrects every call on an arrow in one step (one form, one write of each
 * caller repo's corrections file), beside the per-call "This link is wrong", which is unchanged.
 */

const W = COPY.why;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const JOIN: Api.HierJoinT = {
  interface: "if-0f06d434a34c81c9",
  from: "web-app",
  to: "customers-api",
  how: "host",
  gateway: false,
  verified: true,
  method: "POST",
  path: "/api/customers",
  caller: [
    { source: "config", repo: "forge-web", at: "src/environment.ts:4" },
    { source: "code", repo: "forge-web", at: "src/customer.service.ts:21" },
  ],
  callee: [{ source: "code", repo: "forge-customers", at: "src/CustomerController.java:24" }],
  hops: [],
  other: [],
};
const CALL: Api.FactCiteViewT = {
  id: "c-create-customer",
  kind: "call",
  label: "POST /api/customers",
  claim: { method: "POST", path: "/api/customers", value: "/api/customers" },
  cite: { file: "src/customer.service.ts", line: 21, value: "/api/customers" },
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
const edge = (joins: Api.HierJoinT[]): Api.HierEdgeT => ({
  id: "calls:system:web>system:customers",
  from: "system:web",
  to: "system:customers",
  type: "calls",
  count: joins.length || 1,
  state: "current",
  gaps: [],
  evidence: [],
  joins,
});

/** A link a gateway's routing made: the caller side cites no line of a call. */
const HOP_JOIN: Api.HierJoinT = {
  ...JOIN,
  interface: "if-hop",
  from: "wallets-proxy",
  to: "accounts-api",
  method: "GET",
  path: "/accounts/{id}",
  gateway: true,
  verified: false,
  how: "path",
  caller: [],
  hops: [{ source: "gateway", repo: "forge-wallets-proxy", at: "apiproxy/proxies/default.xml:4" }],
  callee: [{ source: "code", repo: "forge-accounts", at: "src/Accounts.java:12" }],
};
const FORWARD: Api.FactCiteViewT = {
  id: "call.get.accounts-id",
  kind: "call",
  label: "GET /accounts/{id}",
  claim: { method: "GET", path: "/accounts/{id}", value: "/accounts/*" },
  cite: { file: "apiproxy/proxies/default.xml", line: 4, value: "/accounts/*" },
  verified: "line",
  by: "assistant",
};
const PROXY_FACTS: FactsView = {
  ...FACTS,
  repo: "forge-wallets-proxy",
  file: "facts/forge-wallets-proxy.jsonl",
  facts: [{ ...FORWARD, id: "entry.get.accounts-id", kind: "entry" }, FORWARD],
};

/**
 * Review of beta.24: a link with no line of a caller's has no call of its own. A declared caller's
 * link is undone by withdrawing the declaration; any other (a gateway proxy's routing) says where
 * the proxy's forwarding is corrected, as that changes the route for every caller. Neither
 * corrects the route's shared forwarding call from here.
 */
const DECLARED: Api.HierJoinT = {
  ...HOP_JOIN,
  interface: "if-declared",
  from: "harbor-desk",
  how: "declared",
  other: [{ source: "manual", at: "profiles/forge/profile.yaml" }],
};

describe("a link with no line of a caller's", () => {
  const viewOf = (r: string) => (r === "forge-wallets-proxy" ? PROXY_FACTS : undefined);

  it("never rests a correction on the route's forwarding call", () => {
    expect(callerLine(HOP_JOIN)).toBeUndefined();
    expect(linkBasis(HOP_JOIN, viewOf)).toEqual({ kind: "routing" });
    expect(linkBasis(DECLARED, viewOf)).toEqual({ kind: "declared" });
    expect(
      arrowCorrections([DECLARED, HOP_JOIN], viewOf, { kind: "not-a-call", reason: "x" }),
    ).toEqual({ error: "noCalls" });
  });

  it("offers to withdraw a declared link's declaration, by the declared-links undo", () => {
    const page = html(
      <DeclaredLinkWrongView
        join={DECLARED}
        of={{
          state: "ready",
          data: {
            items: [
              {
                kind: "call",
                says: "calls GET /accounts/{id}",
                by: "Priya Nair",
                at: "2026-11-01",
                file: "profiles/forge/profile.yaml",
                undo: { kind: "call", system: "harbor-desk", value: "GET /accounts/{id}" },
              },
            ],
          },
        }}
      />,
    );
    expect(page).toContain(esc(W.declaredLink.say("profiles/forge/profile.yaml")));
    expect(page).toContain(esc("calls GET /accounts/{id}"));
    expect(page).toContain(esc(COPY.corrections.undo));
    // Written by hand in the profile: no Undo here, where to change it instead.
    const hand = html(
      <DeclaredLinkWrongView join={DECLARED} of={{ state: "ready", data: { items: [] } }} />,
    );
    expect(hand).toContain(esc(W.declaredLink.byHand("profiles/forge/profile.yaml")));
  });
});

describe("this whole arrow is wrong", () => {
  const TELLER: Api.HierJoinT = {
    ...JOIN,
    interface: "if-teller",
    method: "GET",
    path: "/api/customers/{id}",
    caller: [{ source: "code", repo: "forge-teller", at: "src/Teller.java:9" }],
  };
  const TELLER_CALL: Api.FactCiteViewT = {
    ...CALL,
    id: "c-teller-customer",
    claim: { method: "GET", path: "/api/customers/{id}", value: "/api/customers/" },
    cite: { file: "src/Teller.java", line: 9, value: "/api/customers/" },
  };
  const TELLER_FACTS: FactsView = {
    ...FACTS,
    repo: "forge-teller",
    file: "facts/forge-teller.jsonl",
    facts: [TELLER_CALL],
  };
  const views: Record<string, FactsView> = {
    "forge-web": FACTS,
    "forge-teller": TELLER_FACTS,
    "forge-wallets-proxy": PROXY_FACTS,
  };
  const viewOf = (repo: string) => views[repo];

  it("gives every call on the arrow the same correction, each in its caller's repo", () => {
    expect(
      arrowCorrections([JOIN, TELLER, HOP_JOIN, DECLARED], viewOf, {
        kind: "outside",
        target: "Northwind",
        reason: "",
      }),
    ).toEqual({
      body: {
        items: [
          {
            repo: "forge-web",
            fact: "c-create-customer",
            action: "edit",
            set: { to: "Northwind" },
          },
          {
            repo: "forge-teller",
            fact: "c-teller-customer",
            action: "edit",
            set: { to: "Northwind" },
          },
        ],
      },
      lines: ["forge-web:src/customer.service.ts:21", "forge-teller:src/Teller.java:9"],
      missing: [],
      // The proxy's forwarding is shared by every caller of the route: never corrected here.
      declared: ["if-declared"],
      routing: ["if-hop"],
    });
    expect(
      arrowCorrections([JOIN, TELLER], viewOf, { kind: "not-a-call", reason: "health probes" }),
    ).toEqual({
      body: {
        items: [
          { repo: "forge-web", fact: "c-create-customer", action: "wrong" },
          { repo: "forge-teller", fact: "c-teller-customer", action: "wrong" },
        ],
        reason: "health probes",
      },
      lines: ["forge-web:src/customer.service.ts:21", "forge-teller:src/Teller.java:9"],
      missing: [],
      declared: [],
      routing: [],
    });
  });

  it("says what is missing, and which calls have no fact to correct", () => {
    expect(arrowCorrections([JOIN], viewOf, { kind: "estate", target: " ", reason: "" })).toEqual({
      error: "needTarget",
    });
    expect(arrowCorrections([JOIN], viewOf, { kind: "not-a-call", reason: "" })).toEqual({
      error: "needReason",
    });
    const lost: Api.HierJoinT = {
      ...TELLER,
      interface: "if-lost",
      caller: [{ source: "code", repo: "forge-teller", at: "src/Gone.java:1" }],
    };
    expect(
      arrowCorrections([JOIN, lost], viewOf, { kind: "estate", target: "ledger-api", reason: "" }),
    ).toMatchObject({ missing: ["if-lost"] });
    expect(
      arrowCorrections([lost], viewOf, { kind: "estate", target: "ledger-api", reason: "" }),
    ).toEqual({ error: "noCalls" });
    // Every call already names the target: nothing to change.
    const named: Record<string, FactsView> = {
      ...views,
      "forge-web": { ...FACTS, facts: [{ ...CALL, claim: { ...CALL.claim, to: "ledger-api" } }] },
    };
    expect(
      arrowCorrections([JOIN], (r) => named[r], {
        kind: "estate",
        target: "ledger-api",
        reason: "",
      }),
    ).toEqual({ error: "sameTarget" });
  });

  it("is one button above the arrow's calls, and one form with the three choices", () => {
    const link = edge([JOIN, TELLER]);
    const closed = html(<ArrowWrongForm link={link} viewOf={viewOf} known={["ledger-api"]} />);
    expect(closed).toContain(esc(W.arrow.open));
    expect(closed).not.toContain(esc(W.arrow.title(2)));
    const open = html(
      <ArrowWrongForm link={link} viewOf={viewOf} known={["ledger-api"]} startOpen />,
    );
    expect(open).toContain(esc(W.arrow.title(2)));
    for (const c of ["estate", "outside", "not-a-call"])
      expect(open).toContain(esc(W.arrow.choice[c]!));
    expect(open).toContain(esc(W.arrow.save(2)));
  });

  it("has a loading state while the callers' facts are read", () => {
    const page = html(
      <ArrowWrongForm link={edge([JOIN])} viewOf={() => undefined} known={[]} startOpen />,
    );
    expect(page).toContain(esc(W.loadingFacts));
  });

  it("once written, names every file and says the next step is Apply", () => {
    const files = ["facts/forge-teller.corrections.jsonl", "facts/forge-web.corrections.jsonl"];
    const page = html(
      <ArrowWrongForm
        link={edge([JOIN, TELLER])}
        viewOf={viewOf}
        known={["ledger-api"]}
        startOpen
        saving={{
          state: "done",
          result: {
            files: files.map((file, i) => ({
              repo: i ? "forge-web" : "forge-teller",
              file,
              lines: ["{}"],
              corrections: [],
            })),
            commit: "commit both",
            verify: ["atticus verify forge-teller", "atticus verify forge-web"],
          },
        }}
      />,
    );
    expect(page).toContain(esc(W.arrow.saved(2, files.join(", "))));
    expect(page).toContain(esc(W.arrow.apply));
  });

  it("says an error writing them", () => {
    const page = html(
      <ArrowWrongForm
        link={edge([JOIN])}
        viewOf={viewOf}
        known={[]}
        startOpen
        saving={{ state: "error", text: "no such fact" }}
      />,
    );
    expect(page).toContain("no such fact");
  });

  it("corrects every call an Interface merged, each on its own line", () => {
    const second: Api.FactCiteViewT = {
      ...CALL,
      id: "c-create-customer-2",
      cite: { file: "src/signup.service.ts", line: 7, value: "/api/customers" },
    };
    const merged: Api.HierJoinT = {
      ...JOIN,
      caller: [
        ...JOIN.caller,
        { source: "code", repo: "forge-web", at: "src/signup.service.ts:7" },
      ],
    };
    const both = (r: string) =>
      r === "forge-web" ? { ...FACTS, facts: [CALL, second] } : undefined;
    expect(callerLines(merged).map((l) => l.at)).toEqual([
      "src/customer.service.ts:21",
      "src/signup.service.ts:7",
      "src/environment.ts:4",
    ]);
    const r = arrowCorrections([merged], both, { kind: "not-a-call", reason: "probes" });
    expect(r).toMatchObject({
      body: {
        items: [
          { repo: "forge-web", fact: "c-create-customer", action: "wrong" },
          { repo: "forge-web", fact: "c-create-customer-2", action: "wrong" },
        ],
      },
      lines: ["forge-web:src/customer.service.ts:21", "forge-web:src/signup.service.ts:7"],
    });
    expect(
      html(<ArrowWrongForm link={edge([merged])} viewOf={both} known={[]} startOpen />),
    ).toContain(esc(W.arrow.save(2)));
    // What moved is told by the line corrected, the second call's too.
    const view = (joins: Api.HierJoinT[]): Views =>
      new Map([["estate", { edges: [edge(joins)] } as unknown as Api.GraphNodeViewT]]);
    expect(
      whatMoved(view([merged]), view([]), ["forge-web:src/signup.service.ts:7"]).map((m) => m.call),
    ).toEqual(["forge-web:src/signup.service.ts:7"]);
  });

  it("means every call when the view lists only 20 of an arrow's 25", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      join: {
        ...JOIN,
        interface: `if-${String(i).padStart(2, "0")}`,
        path: `/api/many/${i}`,
        caller: [{ source: "code", repo: "forge-web", at: `src/many.ts:${i + 1}` }],
      } satisfies Api.HierJoinT,
      fact: {
        ...CALL,
        id: `c-many-${i}`,
        cite: { file: "src/many.ts", line: i + 1, value: "/api/customers" },
      } satisfies Api.FactCiteViewT,
    }));
    const facts = { ...FACTS, facts: many.map((m) => m.fact) };
    const link = { ...edge(many.slice(0, 20).map((m) => m.join)), count: 25 };
    // While every call is read, it says so and offers no count it can't keep.
    const reading = html(<ArrowWrongForm link={link} viewOf={() => facts} known={[]} startOpen />);
    expect(reading).toContain(esc(W.arrow.loadingCalls));
    expect(reading).not.toContain(esc(W.arrow.save(20)));
    const all = html(
      <ArrowWrongForm
        link={link}
        joins={many.map((m) => m.join)}
        viewOf={() => facts}
        known={[]}
        startOpen
      />,
    );
    expect(all).toContain(esc(W.arrow.save(25)));
    expect(all).not.toContain(esc(W.arrow.save(20)));
    expect(
      html(
        <ArrowWrongForm link={link} callsFailed="gone" viewOf={() => facts} known={[]} startOpen />,
      ),
    ).toContain(esc(W.arrow.callsFailed("gone")));
  });

  it("once written, offers no second submit until it is opened again", () => {
    const done = html(
      <ArrowWrongForm
        link={edge([JOIN])}
        viewOf={viewOf}
        known={[]}
        startOpen
        saving={{
          state: "done",
          result: {
            files: [
              {
                repo: "forge-web",
                file: "facts/forge-web.corrections.jsonl",
                lines: ["{}"],
                corrections: [],
              },
            ],
            commit: "commit it",
            verify: ["atticus verify forge-web"],
          },
        }}
      />,
    );
    expect(done).not.toContain('type="submit"');
    expect(done).not.toContain(esc(W.arrow.save(1)));
    // Asked again, every one was on file already: said, nothing new written.
    const again = html(
      <ArrowWrongForm
        link={edge([JOIN])}
        viewOf={viewOf}
        known={[]}
        startOpen
        saving={{
          state: "done",
          result: {
            files: [],
            commit: "",
            verify: [],
            skipped: [{ repo: "forge-web", fact: "c-create-customer" }],
          },
        }}
      />,
    );
    expect(again).toContain(esc(W.arrow.already));
    expect(again).not.toContain('type="submit"');
  });

  it("says what it leaves alone: a declared link, a proxy's routing", () => {
    const page = html(
      <ArrowWrongForm
        link={edge([JOIN, DECLARED, HOP_JOIN])}
        viewOf={viewOf}
        known={[]}
        startOpen
      />,
    );
    expect(page).toContain(esc(W.arrow.declared(1)));
    expect(page).toContain(esc(W.arrow.routing(1)));
    expect(page).toContain(esc(W.arrow.save(1)));
  });

  it("names the arrow by its boxes' names, not their ids", () => {
    const page = html(
      <ArrowWrongForm
        link={edge([JOIN])}
        viewOf={viewOf}
        known={[]}
        labelOf={(id) => (id === "system:web" ? "Web" : "Customers")}
      />,
    );
    expect(page).toContain(`aria-label="${esc(W.arrow.openOf(W.call("Web", "Customers", "")))}"`);
    expect(page).not.toContain("system:web");
  });

  it("is shown above the calls in Why is this linked when the page gives it", () => {
    const page = html(<WhyLinked link={edge([JOIN, TELLER])} above={() => <p>ABOVE</p>} />);
    const call = esc(W.call("web-app", "customers-api", "POST /api/customers"));
    expect(page.indexOf("ABOVE")).toBeGreaterThan(-1);
    expect(page.indexOf("ABOVE")).toBeLessThan(page.indexOf(call));
  });
});
