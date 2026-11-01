import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import type { FactsView } from "../src/app/evidence.js";
import {
  callFactsOf,
  callerLine,
  knownTargets,
  linkCorrection,
  predict,
  reJoinCommand,
  whatMoved,
} from "../src/screens/architecture/links.js";
import { LinkWrongForm, WhatMoved, willSay } from "../src/screens/architecture/WhyLinked.js";
import type { Views } from "../src/screens/architecture/model.js";

/** This link is wrong (ADR 0135, C2): the correction of the call, what it will change, what moved. */

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
  facts: [
    CALL,
    { ...CALL, id: "k-base", kind: "config", label: "apiBase", cite: { ...CALL.cite, line: 4 } },
  ],
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
const node = (id: string, kind: Api.HierNodeT["kind"]): Api.HierNodeT => ({
  id,
  kind,
  label: id,
  childCount: 0,
  state: "current",
  gaps: [],
  evidence: [],
  properties: {},
});
const viewsOf = (joins: Api.HierJoinT[]): Views =>
  new Map([
    [
      "estate",
      {
        lens: "architecture",
        node: node("estate", "estate"),
        path: [],
        children: [node("repo:forge-ledger", "repo"), node("component:ledger-api", "component")],
        outside: [],
        edges: [edge(joins)],
        reduced: true,
        hiddenEdges: 0,
      },
    ],
  ]);

describe("the call a link rests on", () => {
  it("is the caller's code line, and the call facts on it", () => {
    expect(callerLine(JOIN)).toEqual({ repo: "forge-web", at: "src/customer.service.ts:21" });
    expect(callFactsOf(JOIN, FACTS).map((f) => f.id)).toEqual(["c-create-customer"]);
    expect(callFactsOf(JOIN, undefined)).toEqual([]);
  });

  it("knows the repos and components of the views as targets", () => {
    expect(knownTargets(viewsOf([]), ["forge-cards"])).toEqual([
      "forge-cards",
      "forge-ledger",
      "ledger-api",
    ]);
  });
});

describe("the correction a person makes", () => {
  it("sets the call's target, or marks the call wrong with why", () => {
    expect(linkCorrection(CALL, { kind: "estate", target: " forge-ledger ", reason: "" })).toEqual({
      body: { fact: "c-create-customer", action: "edit", set: { to: "forge-ledger" } },
    });
    expect(
      linkCorrection(CALL, { kind: "outside", target: "Northwind Pay", reason: "the vendor" }),
    ).toEqual({
      body: {
        fact: "c-create-customer",
        action: "edit",
        set: { to: "Northwind Pay" },
        reason: "the vendor",
      },
    });
    expect(linkCorrection(CALL, { kind: "not-a-call", reason: "a log line" })).toEqual({
      body: { fact: "c-create-customer", action: "wrong", reason: "a log line" },
    });
  });

  it("says what is missing", () => {
    expect(linkCorrection(CALL, { kind: "estate", target: " ", reason: "" })).toEqual({
      error: "needTarget",
    });
    expect(linkCorrection(CALL, { kind: "not-a-call", reason: "" })).toEqual({
      error: "needReason",
    });
    const named = { ...CALL, claim: { ...CALL.claim, to: "forge-ledger" } };
    expect(linkCorrection(named, { kind: "estate", target: "forge-ledger", reason: "" })).toEqual({
      error: "sameTarget",
    });
  });

  it("says what atticus verify --write will change", () => {
    const known = ["forge-ledger"];
    expect(
      willSay(predict(JOIN, { kind: "estate", target: "forge-ledger", reason: "" }, known)),
    ).toEqual([W.will.moves("web-app", "customers-api", "forge-ledger")]);
    expect(
      willSay(predict(JOIN, { kind: "estate", target: "forge-cards", reason: "" }, known)),
    ).toEqual([
      W.will.unknown("forge-cards"),
      W.will.outside("web-app", "customers-api", "forge-cards"),
    ]);
    expect(
      willSay(predict(JOIN, { kind: "outside", target: "Northwind Pay", reason: "" }, known)),
    ).toEqual([W.will.outside("web-app", "customers-api", "Northwind Pay")]);
    expect(willSay(predict(JOIN, { kind: "not-a-call", reason: "x" }, known))).toEqual([
      W.will.dropped("web-app", "customers-api"),
    ]);
    expect(reJoinCommand("forge-web")).toBe("atticus verify forge-web --write");
  });
});

describe("what moved when the estate was joined again", () => {
  const CALL_LINE = "forge-web:src/customer.service.ts:21";
  it("says each corrected call's link before and after, or that it is on none", () => {
    const before = viewsOf([JOIN]);
    const after = viewsOf([{ ...JOIN, interface: "if-2", to: "ledger-api" }]);
    expect(whatMoved(before, after, [CALL_LINE])).toEqual([
      {
        call: CALL_LINE,
        what: "POST /api/customers",
        was: "web-app → customers-api",
        now: "web-app → ledger-api",
      },
    ]);
    expect(whatMoved(before, viewsOf([]), [CALL_LINE])).toEqual([
      { call: CALL_LINE, what: "POST /api/customers", was: "web-app → customers-api" },
    ]);
    // Not moved yet (verify hasn't run): nothing to say.
    expect(whatMoved(before, before, [CALL_LINE])).toEqual([]);
  });

  it("shows what moved, or that nothing has yet", () => {
    expect(html(<WhatMoved moved={[]} />)).toContain(esc(W.notYet));
    const page = html(
      <WhatMoved
        moved={[{ call: "forge-web:a.ts:1", what: "GET /x", was: "a → b", now: "a → c" }]}
      />,
    );
    expect(page).toContain(esc(W.movedTo("GET /x", "a → b", "a → c")));
  });
});

describe("the form", () => {
  const form = (o: Partial<Parameters<typeof LinkWrongForm>[0]> = {}) =>
    html(
      <LinkWrongForm
        join={JOIN}
        facts={{ state: "ready", data: FACTS }}
        known={["forge-ledger"]}
        onClose={() => undefined}
        {...o}
      />,
    );

  it("offers the three choices for the call on the line", () => {
    const page = form();
    expect(page).toContain(
      esc(W.wrongTitle(W.call("web-app", "customers-api", "POST /api/customers"))),
    );
    for (const c of ["estate", "outside", "not-a-call"]) expect(page).toContain(esc(W.choice[c]!));
    expect(page).toContain('<option value="forge-ledger">');
    expect(page).toContain(esc(W.wrongIntro));
  });

  it("has loading, error and nothing-to-correct states", () => {
    expect(form({ facts: { state: "loading" } })).toContain(esc(W.loadingFacts));
    expect(form({ facts: { state: "error", error: "gone" } })).toContain(
      esc(W.factsFailed("gone")),
    );
    expect(form({ facts: { state: "ready", data: { ...FACTS, facts: [] } } })).toContain(
      esc(W.noCall("forge-web")),
    );
  });

  it("once written, says what will change, the verify command and the pull request", () => {
    const page = form({
      saving: {
        state: "done",
        will: { kind: "moves", from: "web-app", was: "customers-api", to: "forge-ledger" },
        result: {
          correction: {
            schemaVersion: 1,
            fact: "c-create-customer",
            target: {
              kind: "call",
              file: "src/customer.service.ts",
              line: 21,
              value: "/api/customers",
            },
            action: "edit",
            set: { to: "forge-ledger" },
            by: "a.person",
            at: "2026-10-31T12:00:00.000Z",
          },
          file: "facts/forge-web.corrections.jsonl",
          commit: 'git add facts/forge-web.corrections.jsonl && git commit -m "x"',
          verify: "atticus verify forge-web",
        },
      },
    });
    expect(page).toContain(esc(W.will.moves("web-app", "customers-api", "forge-ledger")));
    // C4 (ADR 0149): the panel of what happens next, its preview still loading.
    expect(page).toContain(esc(COPY.correctionNext.onlyWrote("facts/forge-web.corrections.jsonl")));
    expect(page).toContain(esc(COPY.correctionNext.loading));
  });

  it("says an error writing it", () => {
    expect(form({ saving: { state: "error", text: "no such fact" } })).toContain("no such fact");
  });
});
