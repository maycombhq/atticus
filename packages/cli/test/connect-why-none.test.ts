import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { whyNoneOf } from "../src/ui-api-connect.js";

/**
 * ADR 0210 (2.0.0-beta.33), the field report of 2026-11-23: Connect said "Atticus found no call
 * in <proxy>'s code that goes to <module>" and nothing about why. Now it says which: the read has
 * no call (a gateway's routes read, its forwarding calls not), every call stays inside its own
 * component, or the candidates list none.
 */
const view = (calls: Partial<Api.LinkCandidatesViewT["calls"][number]>[], more = {}) =>
  ({
    from: "forge-edge-wallets",
    to: { repo: "forge-wallets-module" },
    toName: "forge-wallets-module",
    calls: calls.map((c, i) => ({
      fact: `call.${i}`,
      callType: "rest",
      path: "/x",
      at: "a:1",
      status: "joined",
      ...c,
    })),
    apis: [],
    ...more,
  }) as Api.LinkCandidatesViewT;

describe("why Connect has no call to offer", () => {
  it("a read with no call: says so, with the command that reads it again", () => {
    const cmd = "atticus map --all --gaps --repos forge-edge-wallets";
    expect(whyNoneOf(view([], { noCalls: { command: cmd } }), false)).toEqual({
      why: "no-calls",
      calls: 0,
      command: cmd,
    });
    // The gateway sentence only for a gateway repo (the review).
    expect(whyNoneOf(view([], { noCalls: { command: cmd } }), true)).toEqual({
      why: "no-calls",
      calls: 0,
      command: cmd,
      gateway: true,
    });
    expect(
      whyNoneOf(
        view([], { noCalls: { command: "atticus verify forge-edge-wallets", why: "unverified" } }),
        false,
      ),
    ).toEqual({
      why: "no-calls",
      calls: 0,
      command: "atticus verify forge-edge-wallets",
      unverified: true,
    });
  });

  it("calls that all stay inside the component", () => {
    expect(whyNoneOf(view([{ inside: "wallets" }, { inside: "wallets" }]), false)).toEqual({
      why: "all-inside",
      calls: 2,
    });
  });

  it("call facts with no candidate listed never claim the read has no call", () => {
    expect(whyNoneOf(view([]), false)).toEqual({ why: "none-open", calls: 0 });
  });
});
