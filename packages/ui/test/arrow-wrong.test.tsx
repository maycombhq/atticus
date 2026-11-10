import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import type { FactsView } from "../src/app/evidence.js";
import {
  arrowCorrections,
  callFactsOn,
  callerLine,
  correctionLines,
} from "../src/screens/architecture/links.js";
import { ArrowWrongForm, LinkWrongForm, WhyLinked } from "../src/screens/architecture/WhyLinked.js";

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
const HOP_AT = { repo: "forge-wallets-proxy", at: "apiproxy/proxies/default.xml:4" };
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

describe("a link a gateway's routing made", () => {
  it("rests the correction on the forwarding call at the hop when the caller cites no line", () => {
    expect(callerLine(HOP_JOIN)).toBeUndefined();
    expect(correctionLines(HOP_JOIN)).toEqual([HOP_AT]);
    // The caller's own line, when there is one, is the only line, as before.
    expect(correctionLines(JOIN)).toEqual([callerLine(JOIN)]);
    expect(callFactsOn(HOP_AT, PROXY_FACTS).map((f) => f.id)).toEqual(["call.get.accounts-id"]);
  });

  it("offers the correction on that line: it goes outside, elsewhere, or isn't a call", () => {
    const page = html(
      <LinkWrongForm
        join={HOP_JOIN}
        at={HOP_AT}
        facts={{ state: "ready", data: PROXY_FACTS }}
        known={["forge-accounts"]}
        onClose={() => undefined}
      />,
    );
    expect(page).not.toContain(esc(W.noLine));
    for (const c of ["estate", "outside", "not-a-call"]) expect(page).toContain(esc(W.choice[c]!));
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
      arrowCorrections([JOIN, TELLER, HOP_JOIN], viewOf, {
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
          {
            repo: "forge-wallets-proxy",
            fact: "call.get.accounts-id",
            action: "edit",
            set: { to: "Northwind" },
          },
        ],
      },
      missing: [],
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
      missing: [],
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

  it("is shown above the calls in Why is this linked when the page gives it", () => {
    const page = html(<WhyLinked link={edge([JOIN, TELLER])} above={() => <p>ABOVE</p>} />);
    const call = esc(W.call("web-app", "customers-api", "POST /api/customers"));
    expect(page.indexOf("ABOVE")).toBeGreaterThan(-1);
    expect(page.indexOf("ABOVE")).toBeLessThan(page.indexOf(call));
  });
});
