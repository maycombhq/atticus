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

const { all } = await import("./support/hooks.js");

describe("the Connect panel after its own Apply", () => {
  // The second review (S2): the read after the Apply must not throw away what the person
  // picked and ticked meanwhile for calls that are still loose.
  it("keeps the person's picks and ticks for calls still loose, and starts only new calls", () => {
    const loose = (fact: string, o: Partial<Api.CandidateCallViewT> = {}) =>
      call({ fact, status: "unresolved", paired: undefined, pairedBy: undefined, ...o });
    const apis: Api.LinkCandidatesViewT["apis"] = [
      { id: "e-entries", kind: "entry", method: "POST", path: "/entries" },
      { id: "e-other", kind: "entry", method: "POST", path: "/other" },
    ];
    const first = {
      ...view([
        call({ drawn: false }),
        loose("c-loose", { suggestion: { api: "e-entries", score: 0.6, why: "names-alike" } }),
      ]),
      apis,
    };
    const props = {
      from: "forge-billing",
      box: { repo: "forge-ledger" },
      cands: { state: "ready", data: first, reload: () => undefined } as Record<string, unknown>,
    };
    const m = mount(Pairing as never, props as never);
    const els = () => all(m.tree);
    const select = () =>
      els().find((e) => e.type === "select" && String(e.props["aria-label"]).includes("/entries"))!;
    const box = () =>
      els().find(
        (e) =>
          e.type === "input" &&
          e.props.type === "checkbox" &&
          String(e.props["aria-label"]).includes("/entries"),
      )!;
    // Started with the suggestion, not ticked (names alike is a hint).
    expect(select().props.value).toBe("e-entries");
    expect(box().props.checked).toBe(false);
    // The person picks another API (which ticks it).
    (select().props.onChange as (e: unknown) => void)({ target: { value: "e-other" } });
    m.render();
    expect(select().props.value).toBe("e-other");
    expect(box().props.checked).toBe(true);
    // The Apply ended and the calls were read again: the paired call is drawn now, the loose
    // one is still loose, and a call read since is new.
    props.cands = {
      state: "ready",
      reload: () => undefined,
      data: {
        ...first,
        applyPending: undefined,
        calls: [
          call({ drawn: true }),
          loose("c-loose", { suggestion: { api: "e-entries", score: 0.6, why: "names-alike" } }),
          loose("c-new", {
            path: "/other",
            suggestion: { api: "e-other", score: 0.95, why: "same-path" },
            confident: true,
          }),
        ],
      },
    };
    m.render();
    expect(select().props.value).toBe("e-other");
    expect(box().props.checked).toBe(true);
    const fresh = els().find(
      (e) => e.type === "select" && String(e.props["aria-label"]).includes("/other"),
    )!;
    expect(fresh.props.value).toBe("e-other");
  });

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
