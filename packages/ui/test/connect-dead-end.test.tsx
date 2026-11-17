import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { Pairing } from "../src/screens/architecture/Connect.js";

/**
 * ADR 0200 (a field report on 2.0.0-beta.28.4): Connect opened from a gateway repo against
 * another team's system with no spec on file, every call of the repo already drawn. The panel
 * said to pick an API under "Move a call here" (there was none) and offered "Write 0 pairs". It
 * now says what can be done, and never shows a write button that writes nothing. On the
 * invented Forge estate: forge-edge (a gateway) and Harbor Audit.
 */

const C = COPY.connect;
const un = (h: string) =>
  h
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const call = (o: Partial<Api.CandidateCallViewT>): Api.CandidateCallViewT => ({
  fact: "call.get.ledger",
  callType: "rest",
  method: "GET",
  path: "/ledger/v1/entries",
  at: "apiproxy/targets/default.xml:4",
  status: "joined",
  joins: "forge-ledger",
  ...o,
});
const harbor: Api.LinkBoxT = { system: "harbor-audit" };
const view = (o: Partial<Api.LinkCandidatesViewT> = {}): Api.LinkCandidatesViewT => ({
  from: "forge-edge",
  to: harbor,
  toName: "Harbor Audit",
  calls: [call({}), call({ fact: "call.post.ledger", method: "POST" })],
  apis: [],
  noApis: { why: "no-spec", command: "atticus intake add <harbor-audit's OpenAPI file>" },
  ...o,
});
const render = (data: Api.LinkCandidatesViewT, box: Api.LinkBoxT = harbor) =>
  un(
    renderToStaticMarkup(<Pairing from="forge-edge" box={box} cands={{ state: "ready", data }} />),
  );

describe("Connect against a box with no spec and no loose call", () => {
  it("says the truth about the calls, with no 'Move a call here' to send the person to", () => {
    const out = render(view());
    expect(out).toContain(C.noApis["no-spec"]!("Harbor Audit"));
    expect(out).toContain(C.noLooseNoApis("forge-ledger (2)", "Harbor Audit"));
    expect(out).not.toContain(C.noLoose("forge-ledger (2)"));
    expect(out).not.toContain("Move a call here");
  });

  it("says what to do when the outside system is the caller: drag the other way, or Declare a link", () => {
    const out = render(view());
    expect(out).toContain(
      "If Harbor Audit calls forge-edge, drag the line from Harbor Audit to forge-edge, or pick Harbor Audit and choose Declare a link…",
    );
  });

  it("shows no write button at all: nothing here could be written", () => {
    const out = render(view());
    expect(out).not.toContain("Write 0 pairs");
    expect(out).not.toMatch(/<button[^>]*class="btn primary"/);
    expect(out).not.toContain(C.preview);
  });

  it("says the same of loose calls with no API to pair them with, and offers no write either", () => {
    const out = render(
      view({ calls: [call({ status: "unresolved", joins: undefined }), call({ fact: "c2" })] }),
    );
    expect(out).toContain(C.looseNoApis(1, "forge-edge", "Harbor Audit"));
    expect(out).toContain(C.systemCallsRepo("Harbor Audit", "forge-edge"));
    expect(out).not.toMatch(/<button[^>]*class="btn primary"/);
  });

  it("keeps the hint to an outside system only: a repo with nothing read says how to read it", () => {
    const out = render(
      view({
        to: { repo: "forge-teller" },
        toName: "forge-teller",
        noApis: { why: "not-read", command: "atticus map --all --repos forge-teller" },
      }),
      { repo: "forge-teller" },
    );
    expect(out).toContain(C.noApis["not-read"]!("forge-teller"));
    expect(out).toContain(C.noLooseNoApis("forge-ledger (2)", "forge-teller"));
    expect(out).not.toContain("Declare a link");
    expect(out).not.toMatch(/<button[^>]*class="btn primary"/);
  });
});

describe("Connect with something to pair", () => {
  const apis: Api.LinkCandidatesViewT["apis"] = [
    { id: "op-events", kind: "operation", method: "POST", path: "/audit/v1/events" },
  ];
  it("holds the write back with the reason while nothing is ticked, and never counts zero pairs", () => {
    const out = render(view({ apis, noApis: undefined }));
    // Every call has an arrow; Harbor Audit has an API to move one to.
    expect(out).toContain(C.noLoose("forge-ledger (2)"));
    expect(out).toContain(C.moveTitle(2));
    expect(out).not.toContain("Write 0 pairs");
    expect(out).toContain(C.pickFirst);
    expect(out).toMatch(
      new RegExp(`<button[^>]*class="btn primary"[^>]*disabled=""[^>]*>Write the pairs</button>`),
    );
    // With an API to pair with, the other direction isn't pushed at the person.
    expect(out).not.toContain(C.systemCallsRepo("Harbor Audit", "forge-edge"));
  });

  it("never words a count of none as pairs to write", () => {
    expect(C.confirm(0, false)).toBe("Write the pairs");
    // One wording, in one place: no second copy of it to drift.
    expect("confirmNone" in C).toBe(false);
    expect(C.confirm(1, false)).toBe("Write the pair");
    expect(C.confirm(3, true)).toBe("Write 3 pairs and answer for all");
    expect(C.confirm(0, true)).toBe("Answer for all its calls");
  });
});

describe("what works instead of declaring a service's entry", () => {
  it("names the topic choice by the words on its radio button", () => {
    expect(COPY.declare.notGatewayDo("Harbor Audit", "forge-ledger", true)).toContain(
      `choose "${COPY.declare.kinds.publishes}" above`,
    );
  });
});
