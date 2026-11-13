import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { boxOf } from "../src/screens/architecture/Architecture.js";
import {
  initialPicks,
  linkedWords,
  Pairing,
  pairsOf,
} from "../src/screens/architecture/Connect.js";

/**
 * G1 (ADR 0174): connect two boxes call by call, as the canvas's panel shows it: the likeliest
 * API picked for each loose call, every state said, and only the ticked pairs sent.
 */

const C = COPY.connect;
const un = (h: string) =>
  h
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

const view: Api.LinkCandidatesViewT = {
  from: "forge-billing",
  to: { repo: "forge-partner-gateway" },
  toName: "forge-partner-gateway",
  calls: [
    {
      fact: "call.post.capture-charge",
      callType: "rest",
      method: "POST",
      path: "captureChargePath",
      at: "src/main/java/forge/billing/PartnerClient.java:31",
      status: "left",
      why: "no-host",
      suggestion: { api: "e-capture", score: 0.53, why: "names-alike" },
    },
    {
      fact: "call.get.ping",
      callType: "rest",
      method: "GET",
      path: "pingPath",
      at: "src/main/java/forge/billing/PartnerClient.java:40",
      status: "unresolved",
    },
    {
      fact: "call.post.charge",
      callType: "rest",
      method: "POST",
      path: "/partners/northwind/charges",
      at: "src/main/java/forge/billing/PartnerClient.java:20",
      status: "paired",
      paired: "e-charges",
    },
  ],
  apis: [
    {
      id: "e-capture",
      kind: "route",
      method: "POST",
      path: "/partners/northwind/charges/{chargeId}/capture",
    },
    { id: "e-charges", kind: "route", method: "POST", path: "/partners/northwind/charges" },
  ],
  rule: { question: "q-000000000001", calls: 2 },
};

describe("the pairs", () => {
  it("picks the suggestion, ticks only a confident one; a call with none waits for the person", () => {
    const i = initialPicks(view);
    expect(i.picked).toEqual({ "call.post.capture-charge": "e-capture" });
    // Names alike is a hint to look at, not a pair to write unseen.
    expect([...i.ticked]).toEqual([]);
    const sure = {
      ...view,
      calls: view.calls.map((c) =>
        c.fact === "call.post.capture-charge" ? { ...c, confident: true } : c,
      ),
    };
    expect([...initialPicks(sure).ticked]).toEqual(["call.post.capture-charge"]);
    const t = initialPicks(sure);
    expect(pairsOf({ ...t.picked, "call.get.ping": "e-charges" }, t.ticked)).toEqual([
      { call: "call.post.capture-charge", api: "e-capture" },
    ]);
    // Ticked with no API picked is no pair.
    expect(pairsOf({}, new Set(["call.get.ping"]))).toEqual([]);
  });
});

describe("the panel", () => {
  const box = { repo: "forge-partner-gateway" };
  it("says it is loading, and why it failed", () => {
    expect(
      un(
        renderToStaticMarkup(
          <Pairing from="forge-billing" box={box} cands={{ state: "loading" }} />,
        ),
      ),
    ).toContain(C.loading);
    expect(
      un(
        renderToStaticMarkup(
          <Pairing from="forge-billing" box={box} cands={{ state: "error", error: "boom" }} />,
        ),
      ),
    ).toContain(C.failed("boom"));
  });

  it("lists only the loose calls, each with a labelled checkbox and a labelled API list, and the rule", () => {
    const out = un(
      renderToStaticMarkup(
        <Pairing from="forge-billing" box={box} cands={{ state: "ready", data: view }} />,
      ),
    );
    expect(out).toContain(C.caption("forge-billing", "forge-partner-gateway"));
    expect(out).toContain("POST captureChargePath");
    expect(out).toContain("GET pingPath");
    expect(out).not.toContain(">POST /partners/northwind/charges</code>");
    expect(out).toContain(`aria-label="${C.col.pick}: POST captureChargePath"`);
    expect(out).toContain(`aria-label="${C.col.api}: GET pingPath"`);
    expect(out).toContain(C.rule(2));
    expect(out).toContain(C.preview);
  });

  it("counts the confident, suggested and unsuggested calls, offers to tick them, and lists the likely APIs first", () => {
    const many = {
      ...view,
      calls: view.calls.map((c) =>
        c.fact === "call.post.capture-charge"
          ? {
              ...c,
              confident: true,
              suggestions: [
                c.suggestion!,
                { api: "e-charges", score: 0.4, why: "names-alike" as const },
              ],
            }
          : c,
      ),
      apis: [
        ...view.apis,
        ...Array.from({ length: 30 }, (_, i) => ({
          id: `e-${i}`,
          kind: "route" as const,
          method: "GET",
          path: `/partners/northwind/things/${i}`,
        })),
      ],
    };
    const out = un(
      renderToStaticMarkup(
        <Pairing from="forge-billing" box={box} cands={{ state: "ready", data: many }} />,
      ),
    );
    expect(out).toContain(C.tally(1, 1, 1));
    expect(out).toContain(C.tickConfident(1));
    expect(out).toContain(C.tickSuggested(1));
    expect(out).toContain(`<optgroup label="${C.likely}">`);
    expect(out).toContain(C.why["same-path"]);
    // Many APIs: a box to find one by its path or name.
    expect(out).toContain(C.findApi);
  });

  it("says what to run when one side has nothing on record", () => {
    const none = {
      ...view,
      calls: [],
      noCalls: { command: "atticus map --all --gaps --repos forge-billing" },
    };
    const out = un(
      renderToStaticMarkup(
        <Pairing from="forge-billing" box={box} cands={{ state: "ready", data: none }} />,
      ),
    );
    expect(out).toContain(C.noCalls("forge-billing"));
    expect(out).toContain("atticus map --all --gaps --repos forge-billing");
    const noSpec = {
      ...view,
      apis: [],
      noApis: { why: "no-spec" as const, command: "atticus intake add <spec>" },
    };
    expect(
      un(
        renderToStaticMarkup(
          <Pairing
            from="forge-billing"
            box={{ system: "northwind-pay" }}
            cands={{ state: "ready", data: { ...noSpec, toName: "Northwind Pay" } }}
          />,
        ),
      ),
    ).toContain(C.noApis["no-spec"]!("Northwind Pay"));
  });
});

describe("a repo whose calls all have an arrow (beta.28.1, field report 4)", () => {
  const box = { repo: "forge-instruments" };
  const joined: Api.LinkCandidatesViewT = {
    from: "forge_instruments_1-0",
    to: { repo: "forge-instruments" },
    toName: "forge-instruments",
    calls: [
      {
        fact: "call.get.instruments-ping",
        callType: "rest",
        method: "GET",
        path: "/instruments/ping",
        at: "src/proxy/targets/default.xml:12",
        status: "joined",
        joins: "forge-ledger",
        suggestion: { api: "e-ping", score: 0.9, why: "same-path" },
      },
      {
        fact: "call.post.instruments",
        callType: "rest",
        method: "POST",
        path: "/instruments",
        at: "src/proxy/targets/default.xml:20",
        status: "joined",
        joins: "forge-ledger",
      },
    ],
    apis: [{ id: "e-ping", kind: "route", method: "GET", path: "/instruments/ping" }],
  };

  it("never picks a call that has an arrow: moving it is the person's choice", () => {
    expect(initialPicks(joined)).toEqual({ picked: {}, ticked: new Set() });
  });

  it("says where the calls go, and lists each to move here, never a dead end", () => {
    const out = un(
      renderToStaticMarkup(
        <Pairing from="forge_instruments_1-0" box={box} cands={{ state: "ready", data: joined }} />,
      ),
    );
    expect(out).toContain(C.noLoose("forge-ledger (2)"));
    expect(out).toContain(C.moveTitle(2));
    expect(out).toContain(C.joinsNow("forge-ledger"));
    expect(out).toContain(`aria-label="${C.col.api}: GET /instruments/ping"`);
    expect(out).toContain(C.preview);
    expect(out).not.toContain(C.caption("forge_instruments_1-0", "forge-instruments"));
  });

  it("lists a call with no arrow drawn as loose, and says why", () => {
    const undrawn = {
      ...joined,
      calls: [{ ...joined.calls[0]!, status: "undrawn" as const, joins: "forge-ledger" }],
    };
    const out = un(
      renderToStaticMarkup(
        <Pairing
          from="forge_instruments_1-0"
          box={box}
          cands={{ state: "ready", data: undrawn }}
        />,
      ),
    );
    expect(out).toContain(C.caption("forge_instruments_1-0", "forge-instruments"));
    expect(out).toContain(C.undrawnWhy("forge-ledger"));
    expect(out).not.toContain(C.moveTitle(1));
    expect(initialPicks(undrawn).picked).toEqual({ "call.get.instruments-ping": "e-ping" });
  });

  it("names each box the calls go to, with how many", () => {
    expect(
      linkedWords([
        { joins: "forge-risk" },
        { joins: "forge-ledger" },
        { joins: "forge-risk" },
        {},
      ]),
    ).toBe("forge-ledger (1), forge-risk (2)");
  });
});

describe("which boxes connect", () => {
  const node = (o: Partial<Api.HierNodeT>): Api.HierNodeT =>
    ({
      id: "repo:forge-billing",
      kind: "repo",
      label: "forge-billing",
      childCount: 0,
      state: "verified",
      gaps: [],
      evidence: [],
      properties: {},
      ...o,
    }) as Api.HierNodeT;
  it("a repo, a component by its repo, and a system by its id", () => {
    expect(boxOf(node({}))).toEqual({ repo: "forge-billing" });
    expect(
      boxOf(
        node({
          id: "component:billing-api",
          kind: "component",
          properties: { repo: "forge-billing" },
        }),
      ),
    ).toEqual({
      repo: "forge-billing",
    });
    expect(
      boxOf(node({ id: "system:northwind-pay", kind: "system", label: "Northwind Pay" })),
    ).toEqual({
      system: "northwind-pay",
    });
    expect(boxOf(node({ id: "table:ledger-db.entry", kind: "table" }))).toBeUndefined();
  });
});
