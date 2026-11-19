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

  it("never ticks a call that has an arrow: moving it is the person's choice", () => {
    // Beta.30: its likeliest API is picked, so one tick moves it; it is never ticked for them.
    expect(initialPicks(joined)).toEqual({
      picked: { "call.get.instruments-ping": "e-ping" },
      ticked: new Set(),
    });
  });

  it("says where the calls go, and lists each to move here, never a dead end", () => {
    const out = un(
      renderToStaticMarkup(
        <Pairing from="forge_instruments_1-0" box={box} cands={{ state: "ready", data: joined }} />,
      ),
    );
    expect(out).toContain(
      C.moveFirst(2, "forge_instruments_1-0", "forge-ledger (2)", "forge-instruments"),
    );
    expect(out).toContain(C.moveTo("forge-instruments"));
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
    expect(out).not.toContain(C.moveTo("forge-instruments"));
    expect(initialPicks(undrawn).picked).toEqual({ "call.get.instruments-ping": "e-ping" });
  });

  it("says a call going here already, with its API, and never offers to pair it (S2)", () => {
    const here = {
      ...joined,
      calls: [
        { ...joined.calls[0]!, status: "here" as const, joins: "forge-instruments", now: "e-ping" },
      ],
    };
    expect(initialPicks(here)).toEqual({ picked: {}, ticked: new Set() });
    const out = un(
      renderToStaticMarkup(
        <Pairing from="forge_instruments_1-0" box={box} cands={{ state: "ready", data: here }} />,
      ),
    );
    expect(out).toContain(C.allHere("forge-instruments"));
    expect(out).toContain(C.hereTitle("forge-instruments", 1));
    expect(out).toContain(C.hereWhy("GET /instruments/ping"));
    expect(out).not.toContain(`aria-label="${C.col.api}: GET /instruments/ping"`);
    expect(out).not.toContain(C.preview);
  });

  it("says who paired a call with another box, and warns before replacing their word (N3)", () => {
    const by = {
      ...joined,
      calls: [{ ...joined.calls[0]!, pairedBy: "sam" }],
    };
    const out = un(
      renderToStaticMarkup(
        <Pairing from="forge_instruments_1-0" box={box} cands={{ state: "ready", data: by }} />,
      ),
    );
    expect(out).toContain(C.pairedWith("sam", "forge-ledger"));
    // The warning comes with a pick: the panel starts with none for a call with an arrow.
    expect(out).not.toContain(C.replacesPairing("sam", "forge-ledger", "forge-instruments"));
    expect(C.replacesPairing("sam", "forge-ledger", "forge-instruments")).toContain("replaces");
  });

  it("says so when the repo has calls on record and none Connect pairs (N1)", () => {
    const none = { ...joined, calls: [] };
    const out = un(
      renderToStaticMarkup(
        <Pairing from="forge_instruments_1-0" box={box} cands={{ state: "ready", data: none }} />,
      ),
    );
    expect(out).toContain(C.noJoinable("forge_instruments_1-0"));
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

// Field report (beta.28.3): "it says it's already paired, but I don't see the line". The panel
// said every call was paired with the box by a person, and the map had no arrow: the pairings
// were in the corrections file, and the repo hadn't been applied since. Each standing a paired
// call can have is said as it is, with what resolves it (ADR 0199).
describe("calls that are paired, by where each stands", () => {
  const box = { repo: "forge-ledger" };
  const paired = (n: number, o: Partial<Api.CandidateCallViewT> = {}): Api.CandidateCallViewT => ({
    fact: `call.post.entries-${n}`,
    callType: "rest",
    method: "POST",
    path: `/entries/${n}`,
    at: `src/main/java/forge/billing/LedgerClient.java:${10 * n}`,
    status: "paired",
    paired: "e-entries",
    pairedBy: "pat",
    drawn: true,
    ...o,
  });
  /** A call paired with another box: no API or arrow of this box. */
  const other = (n: number, o: Partial<Api.CandidateCallViewT>): Api.CandidateCallViewT => {
    const { paired: _p, drawn: _d, ...c } = paired(n, { pairedBy: "sam", ...o });
    return c;
  };
  const view = (
    calls: Api.CandidateCallViewT[],
    o: Partial<Api.LinkCandidatesViewT> = {},
  ): Api.LinkCandidatesViewT => ({
    from: "forge-billing",
    to: box,
    toName: "forge-ledger",
    calls,
    apis: [{ id: "e-entries", kind: "entry", method: "POST", path: "/entries/{id}" }],
    ...o,
  });
  const html = (d: Api.LinkCandidatesViewT) =>
    renderToStaticMarkup(
      <Pairing from="forge-billing" box={box} cands={{ state: "ready", data: d }} />,
    );
  const show = (d: Api.LinkCandidatesViewT) => un(html(d));
  const B = "forge-billing";
  const L = "forge-ledger";

  it("paired with this box and on the map: says so, who, and where to see it", () => {
    const out = show(view([paired(1), paired(2)]));
    expect(out).toContain(C.pairedOnMap("pat", 2, B, L));
    expect(C.pairedOnMap("pat", 2, B, L)).toBe(
      "pat paired 2 calls of forge-billing with forge-ledger, and the map draws them: the arrow from forge-billing to forge-ledger on the Estate map (pick the arrow to see its calls). To pair one again, first undo it: pick forge-billing's box, Show the corrections (under Corrections and declarations), and Undo its line.",
    );
    // Nothing to apply: no Apply is offered.
    expect(out).not.toContain(COPY.propose.apply(B));
  });

  it("paired with this box, the corrections newer than the last Apply: waiting, with the Apply right there", () => {
    const out = show(
      view([paired(1, { drawn: false }), paired(2, { drawn: false })], { applyPending: true }),
    );
    expect(out).toContain(C.pairedWaiting("pat", 2, B, L, true));
    expect(C.pairedWaiting("pat", 2, B, L, true)).toBe(
      "pat paired 2 calls of forge-billing with forge-ledger, but the map doesn't draw them yet: the pairings are in forge-billing's corrections, written since forge-billing was last applied. Apply to forge-billing's map, below, draws the arrow.",
    );
    expect(out).toContain(COPY.propose.apply(B));
    expect(out).not.toContain(C.pairedOnMap("pat", 2, B, L));
  });

  it("paired with this box, applied since, and still not on the map: says what may have happened, and offers Apply", () => {
    const out = show(view([paired(1, { drawn: false })]));
    expect(out).toContain(C.pairedWaiting("pat", 1, B, L, false));
    expect(C.pairedWaiting("pat", 1, B, L, false)).toBe(
      "pat paired 1 call of forge-billing with forge-ledger, but the map draws no arrow for it, though forge-billing's files say it was applied since: that Apply may have been stopped or refused before it wrote the map, or the link was deleted on the map. Apply to forge-billing's map, below, runs it again and says what it leaves out.",
    );
    expect(out).toContain(COPY.propose.apply(B));
  });

  it("a mix: how many the map draws and how many wait, with the Apply", () => {
    const out = show(
      view([paired(1), paired(2), paired(3, { drawn: false })], { applyPending: true }),
    );
    expect(out).toContain(C.pairedMix("pat", 2, 1, B, L, true));
    expect(C.pairedMix("pat", 2, 1, B, L, true)).toBe(
      "pat paired 3 calls of forge-billing with forge-ledger: the map draws 2 (the arrow from forge-billing to forge-ledger on the Estate map), and 1 isn't drawn yet: it is in forge-billing's corrections, written since forge-billing was last applied. Apply to forge-billing's map, below, draws it.",
    );
    expect(out).toContain(COPY.propose.apply(B));
  });

  it("paired with another box: names who, the box, how many, and how to undo one", () => {
    const out = show(
      view([
        // Drawn there: listed to move here.
        other(1, { status: "joined", joins: "forge-cards" }),
        // Not drawn there yet: loose, and said to be a person's.
        other(2, { status: "undrawn", joins: "forge-risk" }),
      ]),
    );
    expect(out).toContain(C.pairedElsewhere("sam", 2, "forge-cards (1), forge-risk (1)", B));
    expect(C.pairedElsewhere("sam", 2, "forge-cards (1), forge-risk (1)", B)).toBe(
      "sam paired 2 calls of forge-billing with another box: forge-cards (1), forge-risk (1). Each is listed below with who paired it; pairing one here replaces that pairing. To free one without pairing it here, undo it: pick forge-billing's box, Show the corrections (under Corrections and declarations), and Undo its line.",
    );
    // The row of the one not drawn yet says whose it is, not only that the read ties it there.
    expect(out).toContain(C.pairedUndrawn("sam", "forge-risk"));
    expect(out).not.toContain(C.undrawnWhy("forge-risk"));
    // Nothing is paired with this box: nothing is said of it.
    expect(out).not.toContain("with forge-ledger, and the map draws");
  });

  it("every standing at once: each said with its count", () => {
    const out = show(
      view(
        [
          paired(1),
          paired(2, { drawn: false }),
          paired(3, { drawn: false }),
          other(4, { status: "joined", joins: "forge-cards" }),
        ],
        { applyPending: true },
      ),
    );
    expect(out).toContain(C.pairedMix("pat", 1, 2, B, L, true));
    expect(out).toContain(C.pairedElsewhere("sam", 1, "forge-cards (1)", B));
  });

  it("a pairing whose API the box no longer has: nothing an Apply can draw, said so", () => {
    const { paired: _p, ...gone } = paired(1, { drawn: false });
    const out = show(view([gone]));
    expect(out).toContain(C.pairedGone("pat", 1, B, L));
    expect(out).not.toContain(COPY.propose.apply(B));
  });

  it("the standing is a status a screen reader hears, in plain words", () => {
    const out = html(view([paired(1, { drawn: false })], { applyPending: true }));
    expect(out).toMatch(/<p role="status" class="ev-say">pat paired 1 call/);
  });

  // The review (S6): a pairing the AI made (ADR 0181) is never said to be a person's.
  it("never says a person paired what the AI paired", () => {
    const ai = { pairedBy: "copilot", pairedAi: true };
    const out = show(
      view(
        [
          paired(1, { ...ai, drawn: false }),
          paired(2, { drawn: false }),
          other(3, { ...ai, status: "joined", joins: "forge-cards" }),
          other(4, { ...ai, status: "undrawn", joins: "forge-risk" }),
        ],
        { applyPending: true },
      ),
    );
    expect(C.pairedWho([], true)).toBe("AI (not confirmed by a person)");
    expect(C.pairedWho(["pat", "sam"], false)).toBe("pat and sam");
    expect(C.pairedWho(["pat"], true)).toBe("pat and AI (not confirmed by a person)");
    expect(C.pairedWho([], false)).toBe("Someone");
    expect(out).toContain(C.pairedWaiting("pat and AI (not confirmed by a person)", 2, B, L, true));
    expect(out).toContain(
      C.pairedElsewhere("AI (not confirmed by a person)", 2, "forge-cards (1), forge-risk (1)", B),
    );
    // The rows too.
    expect(out).toContain(C.pairedWith("copilot", "forge-cards", true));
    expect(C.pairedWith("copilot", "forge-cards", true)).toBe(
      "paired by AI (copilot) with forge-cards, not confirmed by a person",
    );
    expect(out).toContain(C.pairedUndrawn("copilot", "forge-risk", true));
    expect(out).not.toContain("a person (copilot)");
    expect(out).not.toContain("A person paired");
    expect(C.replacesPairing("copilot", "forge-cards", L, true)).not.toContain("their word");
  });

  // The second review (M1): a call paired with a gateway's route. The join carries it on to
  // the service behind the gateway: its one arrow is caller → service, never caller → gateway.
  describe("paired with a gateway that forwards the call on", () => {
    const G = "forge-gw";
    const gwView = (calls: Api.CandidateCallViewT[], o: Partial<Api.LinkCandidatesViewT> = {}) =>
      view(calls, { to: { repo: G }, toName: G, ...o });
    const fwd = (n: number, o: Partial<Api.CandidateCallViewT> = {}) =>
      paired(n, { joins: "forge-ledger", onward: "forwarded", ...o });

    it("on the map: says the gateway forwards them and which arrow to look at, with no Apply", () => {
      const out = show(gwView([fwd(1), fwd(2)]));
      expect(out).toContain(C.pairedForwarded("pat", 2, B, G, "forge-ledger", true));
      expect(C.pairedForwarded("pat", 2, B, G, "forge-ledger", true)).toBe(
        "pat paired 2 calls of forge-billing with forge-gw. forge-gw forwards them to forge-ledger, so the arrow on the map is from forge-billing to forge-ledger, not to forge-gw (pick that arrow: Why linked says it goes through a gateway). To change that, undo the pairing: pick forge-billing's box, Show the corrections (under Corrections and declarations), and Undo its line.",
      );
      expect(out).not.toContain(COPY.propose.apply(B));
      // Never the words of a pairing that waits, or of an Apply that may have been stopped.
      expect(out).not.toContain("may have been stopped");
      expect(out).not.toContain("doesn't draw");
      expect(out).not.toContain(C.pairedOnMap("pat", 2, B, G));
    });

    it("not on the map yet: says where the arrow will go, and offers the Apply that draws it", () => {
      const out = show(gwView([fwd(1, { drawn: false })], { applyPending: true }));
      expect(out).toContain(C.pairedForwarded("pat", 1, B, G, "forge-ledger", false));
      expect(C.pairedForwarded("pat", 1, B, G, "forge-ledger", false)).toBe(
        "pat paired 1 call of forge-billing with forge-gw. forge-gw forwards it to forge-ledger, so its arrow will be from forge-billing to forge-ledger, not to forge-gw, and the map doesn't draw it yet. Apply to forge-billing's map, below, draws it.",
      );
      expect(out).toContain(COPY.propose.apply(B));
    });

    it("an AI pairing a person's answer outranks: not in effect, and where the call goes instead", () => {
      const out = show(
        gwView([
          paired(1, {
            pairedBy: "copilot",
            pairedAi: true,
            joins: "forge-ledger",
            onward: "outranked",
          }),
        ]),
      );
      expect(out).toContain(C.pairedOutranked(1, B, G, "forge-ledger", true));
      expect(C.pairedOutranked(1, B, G, "forge-ledger", true)).toBe(
        "AI paired 1 call of forge-billing with forge-gw, but a person's answer names forge-ledger for it, and a person's word stands over the AI's: the pairing is not in effect. Its arrow is from forge-billing to forge-ledger, on the map. To clear the AI's pairing, undo it: pick forge-billing's box, Show the corrections (under Corrections and declarations), and Undo its line.",
      );
      expect(out).not.toContain(COPY.propose.apply(B));
      expect(C.pairedOutranked(1, B, G, "forge-ledger", false)).toContain(
        "Apply to forge-billing's map, below, draws it.",
      );
    });

    it("the read ties it to another box and doesn't say why: only that is said", () => {
      const out = show(gwView([paired(1, { joins: "forge-ledger" })]));
      expect(out).toContain(C.pairedTiedElsewhere("pat", 1, B, G, "forge-ledger", true));
      expect(C.pairedTiedElsewhere("pat", 1, B, G, "forge-ledger", true)).toBe(
        "pat paired 1 call of forge-billing with forge-gw, but the estate's read ties it to forge-ledger, and its facts don't say why here. Its arrow is from forge-billing to forge-ledger, on the map. To change that, undo the pairing: pick forge-billing's box, Show the corrections (under Corrections and declarations), and Undo its line.",
      );
    });

    it("on another box's panel the row names the box it was paired with, and that it forwards", () => {
      const out = show(
        view([
          other(1, {
            status: "joined",
            joins: "forge-ledger",
            pairedBy: "pat",
            pairedWith: G,
            onward: "forwarded",
          }),
        ]),
      );
      expect(out).toContain(C.pairedWith("pat", G, false, "forge-ledger"));
      expect(C.pairedWith("pat", G, false, "forge-ledger")).toBe(
        "paired by a person (pat) with forge-gw, which forwards it to forge-ledger",
      );
      expect(out).not.toContain(C.pairedWith("pat", "forge-ledger"));
      // The summary names the box of the pairing, not the box the call reaches.
      expect(out).toContain(C.pairedElsewhere("pat", 1, "forge-gw (1)", B));
    });
  });

  // The second review: no catalog built yet (the repo was only verified): never "applied since".
  it("says the catalog hasn't been built yet, and offers the Apply that builds it", () => {
    const out = show(view([paired(1, { drawn: false })], { noCatalog: true }));
    expect(out).toContain(C.pairedWaiting("pat", 1, B, L, false, true));
    expect(C.pairedWaiting("pat", 1, B, L, false, true)).toBe(
      "pat paired 1 call of forge-billing with forge-ledger, but no catalog has been built yet, so the map draws nothing. Apply to forge-billing's map, below, builds it and draws the arrow.",
    );
    expect(out).not.toContain("applied since");
    expect(out).toContain(COPY.propose.apply(B));
  });

  // The review (S7): a call paired with a repo drawn inside the box being viewed goes here.
  it("never lists a call that goes to this very box as paired with another box", () => {
    const out = show(
      view([other(1, { status: "here", joins: "forge-ledger-api", now: "e-entries" })]),
    );
    expect(out).not.toContain("with another box");
    expect(out).toContain(C.allHere(L));
  });

  // The review (N10): both ends in one component: no arrow, and no Apply will draw one.
  it("says why a pairing inside one component has no arrow, and offers no Apply for it", () => {
    const out = show(
      view([paired(1, { drawn: false, inside: "forge-payments" })], { applyPending: true }),
    );
    expect(out).toContain(C.pairedInside("pat", 1, B, "forge-payments"));
    expect(C.pairedInside("pat", 1, B, "forge-payments")).toBe(
      "pat paired 1 call of forge-billing with an API in its own component: both ends are inside forge-payments, so no arrow is drawn between boxes. No Apply changes that.",
    );
    expect(out).not.toContain(COPY.propose.apply(B));
    expect(out).not.toContain("doesn't draw");
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
