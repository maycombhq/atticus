import { describe, expect, it } from "vitest";
import {
  Fact,
  interfaceId,
  JOINED_BY_HOST,
  JOINED_BY_PATH,
  joinFacts,
  joinRecords,
  type JoinRepo,
} from "../src/index.js";

/**
 * A link several calls share (ADR 0135, section 5): two calls of one component that send the
 * same method and path to the same entry make one Interface. It takes every join's evidence and
 * the union of their flags, and is verified when at least one of the joins is: a cited link
 * exists, whatever the other calls guessed. The guesses are kept, so the link still says that a
 * call of it was found by path.
 */

const C = "e5e0010";
const fact = (f: Record<string, unknown>): Fact =>
  Fact.parse({ commit: C, verified: "line", by: "assistant", conf: "declared", ...f });
const call = (id: string, line: number, host?: string): Fact =>
  fact({
    kind: "call",
    id,
    repo: "forge-pay",
    callType: "rest",
    method: "GET",
    path: "/accounts/{id}",
    ...(host ? { host } : {}),
    cite: { file: "src/Clients.java", line, value: "/accounts/{id}" },
  });
const estate = (calls: Fact[]): JoinRepo[] => [
  { repo: "forge-pay", component: "pay-api", facts: calls },
  {
    repo: "forge-accounts",
    component: "accounts-api",
    hosts: ["accounts.forge.internal"],
    facts: [
      fact({
        kind: "entry",
        id: "e-account",
        repo: "forge-accounts",
        entryType: "rest",
        method: "GET",
        path: "/accounts/{id}",
        cite: { file: "src/AccountController.java", line: 10, value: "/accounts/{id}" },
      }),
    ],
  },
];
const ID = interfaceId("pay-api", "accounts-api", "GET", "/accounts/{id}");
const linkOf = (calls: Fact[]) => {
  const repos = estate(calls);
  const out = joinFacts({ repos });
  const iface = joinRecords(out, repos).filter((r) => r.kind === "Interface");
  expect(iface.map((r) => r.id)).toEqual([ID]);
  return {
    out,
    iface: iface[0] as {
      confidence: string;
      flags?: string[];
      evidence: { line: number; side?: string }[];
    },
  };
};

describe("a link several calls share", () => {
  const byHost = call("c-by-host", 20, "https://accounts.forge.internal");
  const byPath = call("c-by-path", 30);

  it("joins each call on its own, one by host and one by path", () => {
    const { out } = linkOf([byHost, byPath]);
    expect(out.joins.map((j) => [j.call.fact, j.how, !!j.inferred])).toEqual([
      ["c-by-host", "host", false],
      ["c-by-path", "path", true],
    ]);
  });

  it("is verified when one call's join is, and keeps the other's guess, the cited how first", () => {
    const { iface } = linkOf([byHost, byPath]);
    expect(iface.confidence).toBe("verified");
    expect(iface.flags).toEqual([JOINED_BY_HOST, JOINED_BY_PATH]);
  });

  it("is the same whichever call is written first", () => {
    expect(linkOf([byPath, byHost]).iface).toEqual(linkOf([byHost, byPath]).iface);
  });

  it("cites every call that shares it, not only the last join's", () => {
    const { iface } = linkOf([byHost, byPath]);
    expect(iface.evidence.filter((e) => e.side === "caller").map((e) => e.line)).toEqual([20, 30]);
  });

  it("stays inferred, guesses first, when every call's join is a guess", () => {
    const { iface } = linkOf([byPath, call("c-by-path-2", 40)]);
    expect(iface.confidence).toBe("inferred");
    expect(iface.flags).toEqual([JOINED_BY_PATH]);
  });

  it("is as before for one call", () => {
    expect(linkOf([byHost]).iface).toMatchObject({
      confidence: "verified",
      flags: [JOINED_BY_HOST],
    });
    expect(linkOf([byPath]).iface).toMatchObject({
      confidence: "inferred",
      flags: [JOINED_BY_PATH],
    });
  });
});
