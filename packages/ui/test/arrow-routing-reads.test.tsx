import { describe, expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";
import { all, mount } from "./support/hooks.js";

/**
 * Review of beta.27: an arrow reads a gateway proxy's facts only when its routing actions are
 * shown (an arrow that is a proxy's routing only, or This link is wrong under such a call), never
 * for a mixed arrow whose form corrects its callers' calls. Rendered with the tiny hooks runtime,
 * no DOM, so the reads each component asks for are seen.
 */

vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});

const { EvidenceContext, staticEvidence } = await import("../src/app/evidence.js");
const { ArrowWrong, ArrowWrongForm, RoutingActions } =
  await import("../src/screens/architecture/WhyLinked.js");

const PROXY = "forge-wallets-proxy";
const JOIN: Api.HierJoinT = {
  interface: "if-accounts",
  from: "web-app",
  to: "accounts-api",
  how: "host",
  gateway: false,
  verified: true,
  method: "GET",
  path: "/accounts",
  caller: [{ source: "code", repo: "forge-web", at: "src/accounts.service.ts:21" }],
  callee: [{ source: "code", repo: "forge-accounts", at: "src/Accounts.java:9" }],
  hops: [],
  other: [],
};
const ROUTE: Api.HierJoinT = {
  ...JOIN,
  interface: "if-route",
  from: "wallets-proxy",
  gateway: true,
  verified: false,
  how: "path",
  caller: [],
  hops: [
    { source: "gateway", repo: PROXY, at: "apiproxy/proxies/default.xml:4" },
    { source: "gateway", repo: PROXY, at: "apiproxy/targets/accounts.xml:7" },
  ],
};
const edge = (joins: Api.HierJoinT[]): Api.HierEdgeT => ({
  id: "calls:system:wallets>system:accounts",
  from: "system:wallets",
  to: "system:accounts",
  type: "calls",
  count: joins.length,
  state: "current",
  gaps: [],
  evidence: [],
  joins,
});

/** An evidence that records every repo whose facts are asked for. */
function spy() {
  const asked: string[] = [];
  const ev = { ...staticEvidence({}), need: (r: string) => void asked.push(r) };
  (EvidenceContext as unknown as { _currentValue: unknown })._currentValue = ev;
  return asked;
}

describe("reading a gateway proxy's facts", () => {
  it("a mixed arrow reads its callers' facts, never the proxy's", () => {
    const asked = spy();
    mount(ArrowWrong, { link: edge([JOIN, ROUTE]), known: [] });
    expect(asked).toEqual(["forge-web"]);
  });

  it("a mixed arrow's form never renders the routing actions, closed or open", () => {
    spy();
    for (const startOpen of [false, true]) {
      const m = mount(ArrowWrongForm, {
        link: edge([JOIN, ROUTE]),
        viewOf: () => undefined,
        known: [],
        startOpen,
      });
      expect(all(m.tree).some((e) => e.type === RoutingActions)).toBe(false);
    }
  });

  it("an arrow that is a proxy's routing only renders them, and they read the proxy's facts", () => {
    const asked = spy();
    const m = mount(ArrowWrongForm, { link: edge([ROUTE]), viewOf: () => undefined, known: [] });
    expect(all(m.tree).some((e) => e.type === RoutingActions)).toBe(true);
    expect(asked).toEqual([]);
    mount(RoutingActions, { joins: [ROUTE], of: () => ({ state: "loading" as const }) });
    expect(asked).toEqual([PROXY]);
  });
});
