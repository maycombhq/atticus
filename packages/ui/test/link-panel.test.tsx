import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import {
  bothRead,
  declarationsOf,
  declaringSystems,
  DeclaredLinkWrongView,
  focusAfter,
  LinkInspector,
  WhyLinked,
} from "../src/screens/architecture/WhyLinked.js";

/**
 * The arrow's panel, laid out (beta.25): a head with the link's name, its count and Close; each
 * call a card whose method and path are cut short in a narrow panel but kept whole in its title,
 * its name and Copy; a declared link's Undo found on the system that declared it; and the focus
 * kept when a correction form closes or its submit goes (WCAG 2.4.3). Everything invented.
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

const LONG = "/api/v2/partners/northwind/settlements/{settlementId}/adjustments/{adjustmentId}";
const CALL: Api.HierJoinT = {
  interface: "if-long",
  from: "portal-bff",
  to: "payments-api",
  how: "host",
  gateway: false,
  verified: true,
  method: "POST",
  path: LONG,
  caller: [{ source: "code", repo: "forge-portal-bff", at: "src/PaymentsClient.java:16" }],
  callee: [{ source: "code", repo: "forge-payments", at: "src/PaymentsController.java:16" }],
  hops: [],
  other: [],
};
const LINK: Api.HierEdgeT = {
  id: "calls:system:portal>system:payments",
  from: "system:portal",
  to: "system:payments",
  type: "calls",
  count: 3,
  state: "current",
  gaps: [],
  evidence: [],
  joins: [CALL],
};

describe("the arrow's panel", () => {
  it("keeps a long method and path whole for hover, the screen reader and Copy", () => {
    const page = html(<WhyLinked link={LINK} />);
    const full = `POST ${LONG}`;
    // The cut line's title and the call's name carry all of it, and Copy copies all of it.
    expect(page).toContain(`title="${esc(full)}"`);
    expect(page).toContain(`aria-label="${esc(W.call("portal-bff", "payments-api", full))}"`);
    expect(page).toContain(`aria-label="${esc(W.copyOf(full))}"`);
    // The two ends, under it.
    expect(page).toContain(esc(W.call("portal-bff", "payments-api", "")));
    // Each call is an item of one list.
    expect(page).toContain('<ul class="li-calls">');
  });

  it("puts the link's name, its count and Close in one head, before its calls", () => {
    const page = html(
      <LinkInspector link={LINK} labelOf={(id) => id.slice(7)} onClose={() => undefined} />,
    );
    const head = page.indexOf('class="li-head"');
    expect(head).toBeGreaterThan(-1);
    expect(
      page.indexOf(esc(COPY.canvasAi.linkTitle("portal", "payments", "calls"))),
    ).toBeGreaterThan(head);
    expect(page).toContain(W.count(3));
    expect(page.indexOf(COPY.canvasAi.close)).toBeLessThan(page.indexOf("li-calls"));
    // Once, never again at the foot.
    expect(page.split(COPY.canvasAi.close).length - 1).toBe(1);
    expect(W.count(1)).toBe("1 call");
    expect(W.dependency.count(2)).toBe("2 build dependencies");
  });
});

describe("a declared link's Undo", () => {
  const TOPIC: Api.HierJoinT = {
    interface: "if-topic",
    // The estate publishes: the code side is `from`, the profile's system `to` (core merge.ts).
    from: "ledger-events",
    to: "tidewater",
    how: "declared",
    gateway: false,
    verified: false,
    path: "ledger.posted",
    caller: [],
    callee: [],
    hops: [],
    other: [{ source: "manual", at: "profiles/forge/profile.yaml" }],
  };
  const item = (kind: "topic" | "call", system: string, value: string) => ({
    kind,
    says: value,
    by: "Priya Nair",
    at: "2026-11-01",
    file: "profiles/forge/profile.yaml",
    undo: { kind, system, value },
  });

  it("asks both ends of a declared topic, and only the caller of a declared route", () => {
    expect(declaringSystems(TOPIC).sort()).toEqual(["ledger-events", "tidewater"]);
    expect(declaringSystems({ ...TOPIC, from: "tidewater", to: "ledger-events" }).sort()).toEqual([
      "ledger-events",
      "tidewater",
    ]);
    expect(declaringSystems({ ...TOPIC, gateway: true })).toEqual(["ledger-events"]);
  });

  it("lists only this topic's declaration, never the system's others", () => {
    const items = [
      item("topic", "tidewater", "ledger.posted"),
      item("topic", "tidewater", "rates.changed"),
      item("call", "tidewater", "GET /rates"),
      {
        kind: "wrong" as const,
        says: "x",
        file: "facts/forge-ledger.corrections.jsonl",
        undo: { repo: "forge-ledger", line: "{}" },
      },
    ];
    expect(declarationsOf(TOPIC, items).map((x) => x.says)).toEqual(["ledger.posted"]);
    const page = html(
      <DeclaredLinkWrongView join={TOPIC} of={{ state: "ready", data: { items } }} />,
    );
    expect(page).toContain(esc(COPY.corrections.undo));
    expect(page).not.toContain("rates.changed");
    expect(page).not.toContain(esc(W.declaredLink.byHand("profiles/forge/profile.yaml")));
  });

  it("matches a declared route by its method and path, or keeps the system's routes when none says it", () => {
    const route = { ...TOPIC, gateway: true, method: "GET", path: "/accounts/{id}" };
    const items = [
      item("call", "ledger-events", "GET /accounts/{id}"),
      item("call", "ledger-events", "POST /x"),
    ];
    expect(declarationsOf(route, items).map((x) => x.says)).toEqual(["GET /accounts/{id}"]);
    const other = [item("call", "ledger-events", "GET /edge/accounts/{id}")];
    expect(declarationsOf(route, other)).toHaveLength(1);
  });

  it("reads both ends as one: loading or failed while either is", () => {
    const ready = (says: string): ReturnType<typeof bothRead> => ({
      state: "ready",
      data: { items: [item("topic", "a", says)] },
    });
    expect(bothRead([ready("a"), { state: "loading" }])).toEqual({ state: "loading" });
    expect(bothRead([ready("a"), { state: "error", error: "no" }])).toMatchObject({
      state: "error",
    });
    const both = bothRead([ready("a"), ready("b")]);
    expect(both.state === "ready" && both.data.items.map((x) => x.says)).toEqual(["a", "b"]);
  });
});

describe("the focus after a correction form (WCAG 2.4.3)", () => {
  it("goes back to the button that opened it when it closes", () => {
    expect(focusAfter({ open: true, done: false }, { open: false, done: false })).toBe("opener");
    expect(focusAfter({ open: true, done: true }, { open: false, done: true })).toBe("opener");
  });
  it("goes to what was written when the submit is taken away", () => {
    expect(focusAfter({ open: true, done: false }, { open: true, done: true })).toBe("result");
  });
  it("stays put otherwise, and never moves when the panel first shows", () => {
    expect(focusAfter({ open: false, done: false }, { open: false, done: false })).toBeUndefined();
    expect(focusAfter({ open: false, done: false }, { open: true, done: false })).toBeUndefined();
    expect(focusAfter({ open: true, done: true }, { open: true, done: true })).toBeUndefined();
  });
});
