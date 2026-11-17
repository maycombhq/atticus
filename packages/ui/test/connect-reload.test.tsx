import { describe, expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";
import { mount } from "./support/hooks.js";

/**
 * ADR 0199, the review (S2): the Connect panel offers the Apply that draws a waiting pairing.
 * Once that Apply ends the panel reads the calls again, so "not on the map yet" doesn't stay on
 * the page beside an arrow the map now draws.
 */

vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const { Pairing } = await import("../src/screens/architecture/Connect.js");
const { workChanged } = await import("../src/app/propose.js");

const call = (o: Partial<Api.CandidateCallViewT>): Api.CandidateCallViewT => ({
  fact: "call.post.entries",
  callType: "rest",
  method: "POST",
  path: "/entries",
  at: "src/main/java/forge/billing/LedgerClient.java:10",
  status: "paired",
  paired: "e-entries",
  pairedBy: "pat",
  ...o,
});
const view = (calls: Api.CandidateCallViewT[]): Api.LinkCandidatesViewT => ({
  from: "forge-billing",
  to: { repo: "forge-ledger" },
  toName: "forge-ledger",
  calls,
  apis: [{ id: "e-entries", kind: "entry", method: "POST", path: "/entries" }],
  applyPending: true,
});

describe("the Connect panel after its own Apply", () => {
  it("reads the calls again when work changed while a pairing waited for Apply", () => {
    let reloads = 0;
    mount(
      Pairing as never,
      {
        from: "forge-billing",
        box: { repo: "forge-ledger" },
        cands: {
          state: "ready",
          data: view([call({ drawn: false })]),
          reload: () => void reloads++,
        },
      } as never,
    );
    expect(reloads).toBe(0);
    workChanged();
    expect(reloads).toBe(1);
  });

  it("leaves the panel as it is when nothing waited (a person's picks aren't thrown away)", () => {
    let reloads = 0;
    mount(
      Pairing as never,
      {
        from: "forge-billing",
        box: { repo: "forge-ledger" },
        cands: {
          state: "ready",
          data: view([call({ drawn: true }), call({ fact: "c2", status: "unresolved" })]),
          reload: () => void reloads++,
        },
      } as never,
    );
    workChanged();
    expect(reloads).toBe(0);
  });
});
