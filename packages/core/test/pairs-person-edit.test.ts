import { describe, expect, it } from "vitest";
import { FactCorrection, joinFacts, pairsFromCorrections, parseFacts } from "../src/index.js";

/**
 * Review round 2 (beta.23): a person's "This link is wrong, it goes to X" writes an `edit` with
 * `set: { to }`. A person's word stands over the AI's: that edit wins over any AI pairing, and
 * the newest of a person's words (a pairing or an edit of `to`) wins over an older one.
 * Forge: forge-refunds' status call, paired by the AI with the gateway, then set by a person to
 * forge-ledger.
 */

const FILE = "src/main/java/forge/refunds/GwClient.java";
const target = { kind: "call" as const, file: FILE, line: 40, value: "/payments/{id}/status" };

// The call as the verifier hands it to the join once the person's edit is applied.
const callFact = (to?: string) =>
  JSON.stringify({
    kind: "call",
    id: "c-status",
    repo: "forge-refunds",
    commit: "1111aaa",
    callType: "rest",
    method: "GET",
    path: "/payments/{id}/status",
    base: "forge.gw.base",
    ...(to ? { to } : {}),
    cite: { file: FILE, line: 40, value: "/payments/{id}/status" },
    verified: to ? "person" : "line",
    by: to ? "person" : "assistant",
    conf: "declared",
  });
const entry = (repo: string, id: string, path: string, line: number) =>
  JSON.stringify({
    kind: "entry",
    id,
    repo,
    commit: "2222bbb",
    component: repo,
    entryType: "rest",
    method: "GET",
    path,
    cite: { file: "src/E.java", line, value: path },
    verified: "line",
    by: "assistant",
    conf: "declared",
  });

const gwLink = (at: string, ai: boolean) =>
  FactCorrection.parse({
    schemaVersion: 2,
    fact: "c-status",
    target,
    action: "link",
    link: {
      repo: "forge-gw",
      entry: "e-payments-status",
      method: "GET",
      path: "/v2/payments/{paymentId}/status",
    },
    by: ai ? "atticus" : "pat",
    at,
    ...(ai
      ? { ai: { runtime: "copilot-acp", run: "20261108-101500-ab12", bar: "confident" } }
      : {}),
  });
const editTo = (at: string, to = "forge-ledger") =>
  FactCorrection.parse({
    schemaVersion: 1,
    fact: "c-status",
    target,
    action: "edit",
    set: { to },
    by: "tom",
    at,
  });

function parsed(text: string) {
  const r = parseFacts(text);
  if (!r.ok) throw new Error("fixture does not parse");
  return r.facts;
}

const joinWith = (corrections: FactCorrection[]) => {
  const refunds = parsed(callFact("forge-ledger"));
  const pairs = pairsFromCorrections(refunds, corrections, { declined: true });
  const j = joinFacts({
    repos: [
      { repo: "forge-refunds", facts: refunds },
      {
        repo: "forge-gw",
        facts: parsed(
          entry("forge-gw", "e-payments-status", "/v2/payments/{paymentId}/status", 30),
        ),
      },
      {
        repo: "forge-ledger",
        facts: parsed(entry("forge-ledger", "e-ledger-status", "/payments/{id}/status", 12)),
      },
    ],
    pairs: { "forge-refunds": pairs },
  });
  return { pairs, joins: j.joins.map((x) => [x.call.fact, x.entry.repo]) };
};

describe("a person's edit of where a call goes", () => {
  it("wins over an older AI pairing", () => {
    const r = joinWith([gwLink("2026-11-08T10:00:00Z", true), editTo("2026-11-09T10:00:00Z")]);
    expect(r.pairs).toEqual({});
    expect(r.joins).toEqual([["c-status", "forge-ledger"]]);
  });

  it("wins over a newer AI pairing too", () => {
    const r = joinWith([editTo("2026-11-08T10:00:00Z"), gwLink("2026-11-09T10:00:00Z", true)]);
    expect(r.joins).toEqual([["c-status", "forge-ledger"]]);
  });

  it("wins over an older pairing of a person's", () => {
    const r = joinWith([gwLink("2026-11-08T10:00:00Z", false), editTo("2026-11-09T10:00:00Z")]);
    expect(r.joins).toEqual([["c-status", "forge-ledger"]]);
  });

  it("loses to a newer pairing of a person's", () => {
    const r = joinWith([editTo("2026-11-08T10:00:00Z"), gwLink("2026-11-09T10:00:00Z", false)]);
    expect(r.joins).toEqual([["c-status", "forge-gw"]]);
  });

  it("an edit that does not set `to` leaves the pairing standing", () => {
    const refunds = parsed(callFact());
    const pathOnly = FactCorrection.parse({
      schemaVersion: 1,
      fact: "c-status",
      target,
      action: "edit",
      set: { path: "/payments/{id}/status" },
      by: "tom",
      at: "2026-11-09T10:00:00Z",
    });
    const p = pairsFromCorrections(refunds, [gwLink("2026-11-08T10:00:00Z", true), pathOnly]);
    expect(Object.keys(p)).toEqual(["c-status"]);
  });
});
