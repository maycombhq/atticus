import { describe, expect, it } from "vitest";
import {
  joinFacts,
  joinRecords,
  linkCandidates,
  pairScore,
  pairsFromCorrections,
  parseFacts,
  wordsOf,
  type CandidateApi,
  type FactCorrection,
} from "../src/index.js";

/**
 * G1 (ADR 0174): connect two boxes call by call. Forge: forge-refunds calls the gateway proxy
 * forge-gw through a client helper whose paths are field names or settings, so nothing joins;
 * the proxy's routes are the APIs on the other side.
 */

const call = (id: string, path: string, line: number, method = "POST") =>
  JSON.stringify({
    kind: "call",
    id,
    repo: "forge-refunds",
    commit: "1111aaa",
    callType: "rest",
    method,
    path,
    base: "forge.gw.base",
    cite: { file: "src/main/java/forge/refunds/GwClient.java", line, value: path },
    verified: "line",
    by: "assistant",
    conf: "declared",
  });
const route = (id: string, path: string, line: number, method = "POST") =>
  JSON.stringify({
    kind: "entry",
    id,
    repo: "forge-gw",
    commit: "2222bbb",
    component: "forge-gw",
    entryType: "rest",
    method,
    path,
    cite: { file: `apiproxy/proxies/default.xml`, line, value: path },
    verified: "line",
    by: "assistant",
    conf: "declared",
  });

const refunds = parseFacts(
  [
    call("c-request-refund", "requestRefundPath", 21),
    call("c-cancel-payment", "${forge.gw.uris.cancel-payment}", 34),
    call("c-status", "/payments/{id}/status", 40, "GET"),
  ].join("\n"),
);
const gw = parseFacts(
  [
    route("e-refunds-request", "/v2/refunds/request", 10),
    route("e-payments-cancel", "/v2/payments/cancel", 20),
    route("e-payments-status", "/v2/payments/{paymentId}/status", 30, "GET"),
  ].join("\n"),
);
if (!refunds.ok || !gw.ok) throw new Error("fixture facts don't parse");

const apis: CandidateApi[] = gw.facts.map((f) => ({
  id: f.id,
  kind: "route",
  ...(f.kind === "entry" && f.method ? { method: f.method } : {}),
  path: (f as { path: string }).path,
  at: `${f.cite.file}:${f.cite.line}`,
}));

const repos = [
  { repo: "forge-refunds", facts: refunds.facts },
  { repo: "forge-gw", facts: gw.facts },
];

describe("how likely a call is an API", () => {
  it("reads the words of a name that holds a path", () => {
    expect([...wordsOf("requestRefundPath")]).toEqual(["request", "refund"]);
    expect([...wordsOf("${forge.gw.uris.cancel-payment}")]).toEqual([
      "forge",
      "gw",
      "uri",
      "cancel",
      "payment",
    ]);
  });

  it("ranks the same path, a prefix, a parameter and names alike, and halves a method that differs", () => {
    expect(pairScore({ path: "/a/b" }, { path: "/a/b" })).toEqual({ score: 1, why: "same-path" });
    expect(
      pairScore({ path: "/payments/{id}/status" }, { path: "/v2/payments/{x}/status" }),
    ).toEqual({
      score: 0.85,
      why: "prefix",
    });
    expect(pairScore({ path: "/a/${x}" }, { path: "/a/b" })).toEqual({
      score: 0.75,
      why: "parameter",
    });
    expect(pairScore({ path: "requestRefundPath" }, { path: "/v2/refunds/request" })?.why).toBe(
      "names-alike",
    );
    expect(
      pairScore({ method: "GET", path: "/a/b" }, { method: "POST", path: "/a/b" })?.score,
    ).toBe(0.5);
    expect(pairScore({ path: "requestRefundPath" }, { path: "/v2/accounts/open" })).toBeUndefined();
  });
});

describe("the candidates of two boxes", () => {
  it("lists A's loose calls with what the join said, B's APIs, and a suggestion for each", () => {
    const join = joinFacts({ repos, explain: true });
    const c = linkCandidates({
      from: "forge-refunds",
      facts: refunds.facts,
      join,
      apis,
      to: { repo: "forge-gw" },
    });
    expect(c.apis.map((a) => a.id)).toEqual([
      "e-payments-cancel",
      "e-payments-status",
      "e-refunds-request",
    ]);
    const by = Object.fromEntries(c.calls.map((x) => [x.fact, x]));
    // Its base is a setting no repo's host answers: the join asked which repo it is.
    expect(by["c-request-refund"]).toMatchObject({
      status: "asked",
      suggestion: { api: "e-refunds-request", why: "names-alike" },
    });
    expect(by["c-cancel-payment"]!.suggestion).toMatchObject({ api: "e-payments-cancel" });
    expect(by["c-status"]!.suggestion).toMatchObject({ api: "e-payments-status", why: "prefix" });
  });

  it("joins a call a person paired, by the entry's id or its method and path, flagged as theirs", () => {
    const pairs = {
      "forge-refunds": {
        "c-request-refund": {
          repo: "forge-gw",
          entry: "e-refunds-request",
          method: "POST",
          path: "/v2/refunds/request",
          by: "pat",
        },
        // The entry's id changed in a later read: found again by method and path.
        "c-cancel-payment": {
          repo: "forge-gw",
          entry: "e-old-id",
          method: "POST",
          path: "/v2/payments/cancel",
          by: "pat",
        },
        // Nothing serves it now: a miss that says who paired it.
        "c-status": {
          repo: "forge-gw",
          entry: "e-gone",
          method: "GET",
          path: "/v1/gone",
          by: "pat",
        },
      },
    };
    const join = joinFacts({ repos, pairs, explain: true });
    const mine = join.joins.filter((j) => j.call.repo === "forge-refunds");
    expect(mine.map((j) => [j.call.fact, j.entry.fact, j.paired?.by])).toEqual([
      ["c-cancel-payment", "e-payments-cancel", "pat"],
      ["c-request-refund", "e-refunds-request", "pat"],
    ]);
    expect(join.misses.find((m) => m.call.fact === "c-status")?.message).toContain("pat paired");
    // A pairing is the person's word, not code: its Interface is inferred, with their evidence.
    const recs = joinRecords(join, repos) as unknown as {
      kind: string;
      from: string;
      confidence: string;
      evidence: { source: string; by?: string }[];
      flags?: string[];
    }[];
    const paired = recs.filter(
      (r) => r.kind === "Interface" && r.flags?.includes("joined-by-person"),
    );
    expect(paired.length).toBeGreaterThan(0);
    for (const r of paired) {
      expect(r.confidence).toBe("inferred");
      expect(r.evidence).toContainEqual(expect.objectContaining({ source: "manual", by: "pat" }));
    }
    const c = linkCandidates({
      from: "forge-refunds",
      facts: refunds.facts,
      join,
      apis,
      pairs: pairs["forge-refunds"],
      to: { repo: "forge-gw" },
    });
    expect(c.calls.find((x) => x.fact === "c-request-refund")).toMatchObject({
      status: "paired",
      paired: "e-refunds-request",
    });
  });

  it("reads a repo's pairings from its corrections, newest first, met by id or by what is cited", () => {
    const link = (at: string, path: string, fact = "c-request-refund"): FactCorrection => ({
      schemaVersion: 1,
      fact,
      target: {
        kind: "call",
        file: "src/main/java/forge/refunds/GwClient.java",
        line: 21,
        value: "requestRefundPath",
      },
      action: "link",
      link: { repo: "forge-gw", entry: "e-refunds-request", method: "POST", path },
      by: "pat",
      at,
    });
    const p = pairsFromCorrections(refunds.facts, [
      link("2026-11-06T10:00:00.000Z", "/v2/refunds/old"),
      link("2026-11-06T11:00:00.000Z", "/v2/refunds/request", "c-renamed"),
    ]);
    expect(p).toEqual({
      "c-request-refund": {
        repo: "forge-gw",
        entry: "e-refunds-request",
        method: "POST",
        path: "/v2/refunds/request",
        by: "pat",
      },
    });
  });
});
