import { describe, expect, it } from "vitest";
import { joinFacts, NO_TARGET, type Fact, type JoinRepo } from "../src/index.js";

/**
 * Asked with `explain`, the join says why each call it neither joined, asked about nor left to an
 * outside system was left: in its own words, at the point it gave up (for `atticus doctor
 * --counts`, which counts them by reason). On invented Forge repos; no network.
 */

const call = (repo: string, id: string, extra: Record<string, unknown>): Fact =>
  ({
    kind: "call",
    id,
    repo,
    commit: "4444ddd",
    callType: "rest",
    cite: { file: "src/client.ts", line: 3, value: "x" },
    verified: "line",
    by: "assistant",
    conf: "declared",
    ...extra,
  }) as Fact;
const entry = (repo: string, id: string, extra: Record<string, unknown>): Fact =>
  ({
    kind: "entry",
    id,
    repo,
    commit: "5555eee",
    entryType: "rest",
    cite: { file: "src/routes.ts", line: 7, value: "x" },
    verified: "line",
    by: "assistant",
    conf: "declared",
    ...extra,
  }) as Fact;

describe("why the join left a call (explain)", () => {
  const repos = (): JoinRepo[] => [
    {
      repo: "forge-web",
      component: "web-app",
      facts: [
        // No host, no base, no target, and no entry serves it.
        call("forge-web", "call.get.nowhere", { method: "GET", path: "/nowhere" }),
        // A placeholder host no setting resolves (J0), and no entry serves it by path.
        call("forge-web", "call.get.later", { method: "GET", host: "${LATER_URL}", path: "/x/y" }),
        // A host the manifest lists, and no route there serves the path.
        call("forge-web", "call.get.customers-gone", {
          method: "GET",
          host: "customers.forge.example",
          path: "/gone",
        }),
        // A target named, with no entry for it.
        call("forge-web", "call.get.ledger-gone", {
          method: "GET",
          to: "forge-ledger",
          path: "/gone",
        }),
        // A health check with no target.
        call("forge-web", "call.get.health", { method: "GET", path: "/health" }),
        // A person answered that nothing answers it.
        call("forge-web", "call.get.none", { method: "GET", path: "/none" }),
        // A publish no listener hears.
        call("forge-web", "call.publish.unheard", {
          callType: "event-topic",
          method: "publish",
          path: "forge.unheard",
        }),
        // A host nobody lists: asked, not left.
        call("forge-web", "call.get.unknown", {
          method: "GET",
          host: "elsewhere.example",
          path: "/a",
        }),
      ],
    },
    {
      repo: "forge-customers",
      component: "customers-api",
      hosts: ["customers.forge.example"],
      facts: [entry("forge-customers", "entry.get.customers", { method: "GET", path: "/c" })],
    },
    { repo: "forge-ledger", component: "ledger-api", facts: [] },
  ];

  it("gives each left call its reason, and nothing without explain", () => {
    const input = {
      repos: repos(),
      targets: { "forge-web": { "call.get.none": NO_TARGET } },
    };
    expect(joinFacts(input).left).toBeUndefined();
    const r = joinFacts({ ...input, explain: true });
    const why = Object.fromEntries((r.left ?? []).map((l) => [l.call.fact, l.reason]));
    expect(why).toEqual({
      "call.get.nowhere": "no-host",
      "call.get.later": "unresolved-placeholder",
      "call.get.customers-gone": "host-no-route",
      "call.get.ledger-gone": "target-no-route",
      "call.get.health": "generic-path",
      "call.get.none": "answered-none",
      "call.publish.unheard": "topic-unheard",
    });
    expect(r.asks.map((a) => [a.call.fact, a.reason])).toEqual([
      ["call.get.unknown", "unknown-host"],
    ]);
  });
});
