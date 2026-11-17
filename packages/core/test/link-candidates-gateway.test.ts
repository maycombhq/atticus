import { describe, expect, it } from "vitest";
import { joinFacts, linkCandidates, parseFacts, type CandidateApi } from "../src/index.js";

/**
 * ADR 0199, the second review (M1). forge-refunds calls the gateway forge-gw; the route's
 * forwarding call reaches forge-ledger. The join walks the gateway, so a pairing of the call
 * with forge-gw's route is one link forge-refunds → forge-ledger (through the gateway), and
 * that is the only arrow the catalog will ever have for it. The candidates say so: the pairing
 * stands with forge-gw, the call goes on to forge-ledger, and `drawn` is of that arrow.
 */

const fact = (o: Record<string, unknown>, file: string, line: number, value: string) =>
  JSON.stringify({
    commit: "1111aaa",
    cite: { file, line, value },
    verified: "line",
    by: "assistant",
    conf: "declared",
    ...o,
  });
const refunds = parseFacts(
  [
    fact(
      {
        kind: "call",
        id: "c-request-refund",
        repo: "forge-refunds",
        callType: "rest",
        method: "POST",
        path: "requestRefundPath",
      },
      "src/main/java/forge/refunds/GwClient.java",
      21,
      "requestRefundPath",
    ),
    fact(
      {
        kind: "call",
        id: "c-direct",
        repo: "forge-refunds",
        callType: "rest",
        method: "POST",
        path: "/refunds",
      },
      "src/main/java/forge/refunds/GwClient.java",
      60,
      "/refunds",
    ),
    // Two calls cited on one line (S1).
    fact(
      {
        kind: "call",
        id: "c-status",
        repo: "forge-refunds",
        callType: "rest",
        method: "GET",
        path: "statusPath",
      },
      "src/main/java/forge/refunds/GwClient.java",
      40,
      "statusPath",
    ),
    fact(
      {
        kind: "call",
        id: "c-cancel",
        repo: "forge-refunds",
        callType: "rest",
        method: "POST",
        path: "cancelPath",
      },
      "src/main/java/forge/refunds/GwClient.java",
      40,
      "cancelPath",
    ),
  ].join("\n"),
);
const gw = parseFacts(
  [
    fact(
      {
        kind: "entry",
        id: "e-refunds-request",
        repo: "forge-gw",
        component: "forge-gw",
        entryType: "rest",
        method: "POST",
        path: "/v2/refunds/request",
      },
      "apiproxy/proxies/default.xml",
      10,
      "/v2/refunds/request",
    ),
    fact(
      {
        kind: "call",
        id: "c-forward-refund",
        repo: "forge-gw",
        component: "forge-gw",
        callType: "rest",
        method: "POST",
        path: "/refunds",
        host: "@forgeLedgerUrl@",
        from: "e-refunds-request",
      },
      "apiproxy/targets/default.xml",
      4,
      "/refunds",
    ),
    fact(
      {
        kind: "entry",
        id: "e-status",
        repo: "forge-gw",
        component: "forge-gw",
        entryType: "rest",
        method: "GET",
        path: "/v2/status",
      },
      "apiproxy/proxies/default.xml",
      20,
      "/v2/status",
    ),
    fact(
      {
        kind: "entry",
        id: "e-cancel",
        repo: "forge-gw",
        component: "forge-gw",
        entryType: "rest",
        method: "POST",
        path: "/v2/cancel",
      },
      "apiproxy/proxies/default.xml",
      30,
      "/v2/cancel",
    ),
  ].join("\n"),
);
const ledger = parseFacts(
  fact(
    {
      kind: "entry",
      id: "e-ledger-refunds",
      repo: "forge-ledger",
      entryType: "rest",
      method: "POST",
      path: "/refunds",
    },
    "src/main/java/forge/ledger/RefundsController.java",
    12,
    "/refunds",
  ),
);
if (!refunds.ok || !gw.ok || !ledger.ok) throw new Error("the fixture's facts don't parse");
const repos = [
  { repo: "forge-refunds", facts: refunds.facts },
  { repo: "forge-gw", facts: gw.facts, gateway: true },
  { repo: "forge-ledger", facts: ledger.facts },
];
const apis: CandidateApi[] = [
  { id: "e-refunds-request", kind: "route", method: "POST", path: "/v2/refunds/request" },
  { id: "e-status", kind: "route", method: "GET", path: "/v2/status" },
  { id: "e-cancel", kind: "route", method: "POST", path: "/v2/cancel" },
];
const PAT = {
  repo: "forge-gw",
  entry: "e-refunds-request",
  method: "POST",
  path: "/v2/refunds/request",
  by: "pat",
};
/** The gateway's own forwarding call, paired with the service's entry (its host is a token). */
const GW_PAIRS = {
  "c-forward-refund": {
    repo: "forge-ledger",
    entry: "e-ledger-refunds",
    method: "POST",
    path: "/refunds",
    by: "sam",
  },
};
const of = (c: ReturnType<typeof linkCandidates>, id: string) =>
  c.calls.find((x) => x.fact === id)!;

describe("a call paired with a gateway's route", () => {
  const pairs = { "c-request-refund": PAT };
  const join = joinFacts({
    repos,
    pairs: { "forge-refunds": pairs, "forge-gw": GW_PAIRS },
    explain: true,
  });
  const mine = join.joins.find((j) => j.call.fact === "c-request-refund")!;

  it("is one link to the service behind the gateway (the premise)", () => {
    expect(mine.entry.repo).toBe("forge-ledger");
    expect(mine.gateway?.map((h) => h.entry.repo)).toEqual(["forge-gw"]);
  });

  it("stays paired with the gateway's box, says where it goes on to, and whether that arrow is drawn", () => {
    const base = { from: "forge-refunds", facts: refunds.facts, join, apis, pairs };
    const before = linkCandidates({
      ...base,
      to: { repo: "forge-gw" },
      drawn: () => false,
      drawnExact: () => false,
      drawnBoxes: () => [],
    });
    expect(of(before, "c-request-refund")).toMatchObject({
      status: "paired",
      paired: "e-refunds-request",
      pairedBy: "pat",
      joins: "forge-ledger",
      onward: "forwarded",
      drawn: false,
    });
    const after = linkCandidates({
      ...base,
      to: { repo: "forge-gw" },
      drawn: () => true,
      drawnExact: (j) => j.interface === mine.interface,
      drawnBoxes: () => ["forge-ledger"],
    });
    expect(of(after, "c-request-refund")).toMatchObject({
      status: "paired",
      joins: "forge-ledger",
      onward: "forwarded",
      drawn: true,
    });
  });

  it("on the service's box goes there already, paired by pat with the gateway, which forwards it", () => {
    const c = linkCandidates({
      from: "forge-refunds",
      facts: refunds.facts,
      join,
      apis: [],
      pairs,
      to: { repo: "forge-ledger" },
      drawn: () => true,
      drawnExact: () => true,
      drawnBoxes: () => ["forge-ledger"],
    });
    expect(of(c, "c-request-refund")).toMatchObject({
      status: "here",
      pairedBy: "pat",
      pairedWith: "forge-gw",
      onward: "forwarded",
    });
  });

  it("on any other box is listed to move, with the box pat paired it with, not the one it reaches", () => {
    const c = linkCandidates({
      from: "forge-refunds",
      facts: refunds.facts,
      join,
      apis: [],
      pairs,
      to: { repo: "forge-cards" },
      drawn: () => true,
      drawnExact: () => true,
      drawnBoxes: () => ["forge-ledger"],
    });
    expect(of(c, "c-request-refund")).toMatchObject({
      status: "joined",
      joins: "forge-ledger",
      pairedBy: "pat",
      pairedWith: "forge-gw",
      onward: "forwarded",
    });
  });
});

describe("an AI pairing a person's answer outranks", () => {
  const ai = { by: "copilot", ai: { runtime: "copilot", run: "run-1" } };
  const pairs = {
    // The AI paired both with routes of forge-gw.
    "c-direct": { repo: "forge-gw", entry: "e-cancel", method: "POST", path: "/v2/cancel", ...ai },
    "c-status": { repo: "forge-gw", entry: "e-status", method: "GET", path: "/v2/status", ...ai },
  };
  // A person answered each call's target question: forge-ledger. It serves the first, not the
  // second.
  const targets = { "c-direct": "forge-ledger", "c-status": "forge-ledger" };
  const join = joinFacts({
    repos,
    pairs: { "forge-refunds": pairs, "forge-gw": GW_PAIRS },
    targets: { "forge-refunds": targets },
    explain: true,
  });
  const cands = (to: string) =>
    linkCandidates({
      from: "forge-refunds",
      facts: refunds.facts,
      join,
      apis: to === "forge-gw" ? apis : [],
      pairs,
      targets,
      to: { repo: to },
      drawn: () => true,
      drawnExact: () => true,
      drawnBoxes: () => ["forge-ledger"],
    });

  it("the person's answer is what joined the call (the premise)", () => {
    const mine = join.joins.find((j) => j.call.fact === "c-direct")!;
    expect([mine.entry.repo, mine.how, mine.paired]).toEqual(["forge-ledger", "answer", undefined]);
    expect(join.joins.some((j) => j.call.fact === "c-status")).toBe(false);
  });

  it("is said to be outranked, with where the call goes instead, never to wait for an Apply of its own", () => {
    expect(of(cands("forge-gw"), "c-direct")).toMatchObject({
      status: "paired",
      pairedBy: "copilot",
      pairedAi: true,
      joins: "forge-ledger",
      onward: "outranked",
      drawn: true,
    });
  });

  it("is not a pairing at all where the answer joins nothing, or on any other box's row", () => {
    // The answer names a repo that doesn't serve the call: it is as loose as the join says.
    const loose = of(cands("forge-gw"), "c-status");
    expect(loose.status).not.toBe("paired");
    expect(loose.pairedBy).toBeUndefined();
    // On the box it goes to, and on a third: the AI's pairing isn't named as what sent it there.
    for (const to of ["forge-ledger", "forge-cards"]) {
      const row = of(cands(to), "c-direct");
      expect(row.status, to).toBe(to === "forge-ledger" ? "here" : "joined");
      expect(row.pairedBy, to).toBeUndefined();
      expect(row.pairedAi, to).toBeUndefined();
    }
  });
});

describe("two calls cited on one line, one applied and one paired today (S1)", () => {
  const pairs = {
    "c-status": {
      repo: "forge-gw",
      entry: "e-status",
      method: "GET",
      path: "/v2/status",
      by: "pat",
    },
    "c-cancel": {
      repo: "forge-gw",
      entry: "e-cancel",
      method: "POST",
      path: "/v2/cancel",
      by: "pat",
    },
  };
  const join = joinFacts({
    repos,
    pairs: { "forge-refunds": pairs, "forge-gw": GW_PAIRS },
    explain: true,
  });

  it("says only the one whose own Interface the catalog has is drawn", () => {
    const applied = join.joins.find((j) => j.call.fact === "c-status")!;
    const c = linkCandidates({
      from: "forge-refunds",
      facts: refunds.facts,
      join,
      apis,
      pairs,
      to: { repo: "forge-gw" },
      drawn: () => true,
      drawnExact: (j) => j.interface === applied.interface,
      // The line they share is drawn to this box: c-status's arrow.
      drawnBoxes: () => ["forge-gw"],
    });
    expect(of(c, "c-status")).toMatchObject({ status: "paired", drawn: true });
    expect(of(c, "c-cancel")).toMatchObject({ status: "paired", drawn: false });
  });
});
