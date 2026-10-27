import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  joinVendorOperations,
  parseFacts,
  type Fact,
  type JoinRepo,
  type JoinVendor,
} from "../src/index.js";

/**
 * A gateway's forwarding calls matched to the vendor operations they reach (ADR 0130): the
 * partner gateway forwards three routes to Northwind Pay (an invented vendor) through the
 * TargetServer `northwind-pay`, whose host the vendor's published spec names.
 */

const DIR = join(__dirname, "..", "..", "..", "fixtures", "vendor-impact");
const read = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(DIR, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const estate = (): JoinRepo[] => [
  { repo: "forge-shop-bff", facts: read("forge-shop-bff"), component: "shop-bff" },
  {
    repo: "forge-billing",
    facts: read("forge-billing"),
    component: "billing-api",
    hosts: ["billing.forge.internal"],
  },
  {
    repo: "forge-partner-gateway",
    facts: read("forge-partner-gateway"),
    component: "partner-gateway",
    hosts: ["partner.forge.example"],
    gateway: true,
    facing: "external",
  },
];
const V1 = "inputs/partner-specs/northwind-pay-openapi-v1.yaml";
/** Northwind Pay 1.0.0's operations as intake reads them: the spec path and the server's in front. */
const northwind = (): JoinVendor => ({
  system: "northwind-pay",
  names: ["Northwind Pay"],
  hosts: ["api.northwindpay.example"],
  operations: [
    {
      id: "op.create-charge",
      method: "POST",
      path: "/charges",
      fullPath: "/v1/charges",
      cite: `${V1}:12`,
    },
    {
      id: "op.get-charge",
      method: "GET",
      path: "/charges/{chargeId}",
      fullPath: "/v1/charges/{chargeId}",
      cite: `${V1}:28`,
    },
    {
      id: "op.capture",
      method: "POST",
      path: "/charges/{chargeId}/capture",
      fullPath: "/v1/charges/{chargeId}/capture",
      cite: `${V1}:42`,
    },
    {
      id: "op.refund",
      method: "POST",
      path: "/charges/{chargeId}/refunds",
      fullPath: "/v1/charges/{chargeId}/refunds",
      cite: `${V1}:54`,
    },
  ],
});
const GW = "forge-partner-gateway";
const DEFAULT_XML = "proxies/northwind-pay-v1/apiproxy/proxies/default.xml";
const TIE = {
  repo: GW,
  fact: "config.targetserver.northwind-pay",
  component: "partner-gateway",
  at: "environments/prod/targetservers.json:4",
};
const swap = (repos: JoinRepo[], repo: string, f: (fs: Fact[]) => Fact[]): JoinRepo[] =>
  repos.map((r) => (r.repo === repo ? { ...r, facts: f([...r.facts]) } : r));

describe("joinVendorOperations", () => {
  it("matches each forwarding call to the vendor operation it reaches, path parameters aside", () => {
    const got = joinVendorOperations({ repos: estate(), vendors: [northwind()] });
    expect(got.gaps).toEqual([]);
    expect(got.asks).toEqual([]);
    expect(got.matches).toEqual([
      {
        call: {
          repo: GW,
          fact: "call.post.v1-charges",
          component: "partner-gateway",
          at: `${DEFAULT_XML}:5`,
        },
        route: {
          repo: GW,
          fact: "entry.post.partners-northwind-charges",
          component: "partner-gateway",
          at: `${DEFAULT_XML}:5`,
        },
        tie: TIE,
        vendor: "northwind-pay",
        how: "host",
        operation: "op.create-charge",
        method: "POST",
        path: "/v1/charges",
      },
      {
        call: {
          repo: GW,
          fact: "call.post.v1-charges-chargeid-capture",
          component: "partner-gateway",
          at: `${DEFAULT_XML}:8`,
        },
        route: {
          repo: GW,
          fact: "entry.post.partners-northwind-charges-chargeid-capture",
          component: "partner-gateway",
          at: `${DEFAULT_XML}:8`,
        },
        tie: TIE,
        vendor: "northwind-pay",
        how: "host",
        operation: "op.capture",
        method: "POST",
        path: "/v1/charges/{chargeId}/capture",
      },
      {
        call: {
          repo: GW,
          fact: "call.post.v1-charges-chargeid-refunds",
          component: "partner-gateway",
          at: `${DEFAULT_XML}:11`,
        },
        route: {
          repo: GW,
          fact: "entry.post.partners-northwind-charges-chargeid-refunds",
          component: "partner-gateway",
          at: `${DEFAULT_XML}:11`,
        },
        tie: TIE,
        vendor: "northwind-pay",
        how: "host",
        operation: "op.refund",
        method: "POST",
        path: "/v1/charges/{chargeId}/refunds",
      },
    ]);
  });

  it("is the same whatever order the repos and operations come in", () => {
    const v = northwind();
    expect(
      joinVendorOperations({
        repos: [...estate()].reverse(),
        vendors: [{ ...v, operations: [...v.operations].reverse() }],
      }),
    ).toEqual(joinVendorOperations({ repos: estate(), vendors: [northwind()] }));
  });

  it("matches the spec's own path when the forwarding call leaves the server path out", () => {
    const repos = swap(estate(), GW, (fs) =>
      fs.map((f) =>
        f.id === "call.post.v1-charges" && f.kind === "call" ? { ...f, path: "/charges" } : f,
      ),
    );
    const m = joinVendorOperations({ repos, vendors: [northwind()] }).matches;
    expect(m.find((x) => x.call.fact === "call.post.v1-charges")?.operation).toBe(
      "op.create-charge",
    );
  });

  it("says a forwarding call to an operation the vendor doesn't publish is a gap", () => {
    const repos = swap(estate(), GW, (fs) =>
      fs.map((f) =>
        f.id === "call.post.v1-charges-chargeid-capture" && f.kind === "call"
          ? { ...f, path: "/v1/charges/{chargeId}/void" }
          : f,
      ),
    );
    const got = joinVendorOperations({ repos, vendors: [northwind()] });
    expect(got.matches.map((m) => m.operation)).toEqual(["op.create-charge", "op.refund"]);
    expect(got.gaps).toEqual([
      {
        call: {
          repo: GW,
          fact: "call.post.v1-charges-chargeid-capture",
          component: "partner-gateway",
          at: `${DEFAULT_XML}:8`,
        },
        route: {
          repo: GW,
          fact: "entry.post.partners-northwind-charges-chargeid-capture",
          component: "partner-gateway",
          at: `${DEFAULT_XML}:8`,
        },
        tie: TIE,
        vendor: "northwind-pay",
        method: "POST",
        path: "/v1/charges/{chargeId}/void",
        message:
          "partner-gateway forwards POST /v1/charges/{chargeId}/void to Northwind Pay, whose spec publishes no such operation",
      },
    ]);
  });

  it("names the methods the vendor does publish on that path when only the method differs", () => {
    const repos = swap(estate(), GW, (fs) =>
      fs.map((f) =>
        f.id === "call.post.v1-charges" && f.kind === "call" ? { ...f, method: "PUT" } : f,
      ),
    );
    const gap = joinVendorOperations({ repos, vendors: [northwind()] }).gaps[0]!;
    expect(gap.message).toBe(
      "partner-gateway forwards PUT /v1/charges to Northwind Pay, whose spec publishes no such operation (it publishes POST on that path)",
    );
  });

  it("asks which operation is meant when two answer the forwarding call equally well", () => {
    const repos = swap(estate(), GW, (fs) =>
      fs.map((f) => {
        if (f.id !== "call.post.v1-charges-chargeid-capture" || f.kind !== "call") return f;
        const { method: _m, ...rest } = f;
        return { ...rest, path: "/v1/charges/{chargeId}" };
      }),
    );
    const n = northwind();
    const v: JoinVendor = {
      ...n,
      operations: [
        ...n.operations,
        {
          id: "op.cancel",
          method: "DELETE",
          path: "/charges/{chargeId}",
          fullPath: "/v1/charges/{chargeId}",
          cite: `${V1}:30`,
        },
      ],
    };
    const got = joinVendorOperations({ repos, vendors: [v] });
    expect(got.asks).toEqual([
      {
        call: {
          repo: GW,
          fact: "call.post.v1-charges-chargeid-capture",
          component: "partner-gateway",
          at: `${DEFAULT_XML}:8`,
        },
        route: {
          repo: GW,
          fact: "entry.post.partners-northwind-charges-chargeid-capture",
          component: "partner-gateway",
          at: `${DEFAULT_XML}:8`,
        },
        vendor: "northwind-pay",
        question:
          "Which of Northwind Pay's operations does /v1/charges/{chargeId}, which partner-gateway forwards, reach: DELETE /charges/{chargeId} or GET /charges/{chargeId}?",
        candidates: ["op.cancel", "op.get-charge"],
      },
    ]);
  });

  it("finds the vendor by its name in the host when its spec names no server", () => {
    const got = joinVendorOperations({ repos: estate(), vendors: [{ ...northwind(), hosts: [] }] });
    expect(got.matches).toHaveLength(3);
  });

  it("takes the vendor a call's `to` or a person's answer names, and leaves a host nobody claims alone", () => {
    const noTie = swap(estate(), GW, (fs) => fs.filter((f) => f.kind !== "config"));
    expect(joinVendorOperations({ repos: noTie, vendors: [northwind()] }).matches).toEqual([]);
    const named = swap(noTie, GW, (fs) =>
      fs.map((f) =>
        f.id === "call.post.v1-charges" && f.kind === "call" ? { ...f, to: "Northwind Pay" } : f,
      ),
    );
    expect(
      joinVendorOperations({ repos: named, vendors: [northwind()] }).matches.map((m) => [
        m.how,
        m.operation,
      ]),
    ).toEqual([["named", "op.create-charge"]]);
    const answered = joinVendorOperations({
      repos: noTie,
      vendors: [northwind()],
      targets: { [GW]: { "call.post.v1-charges-chargeid-refunds": "northwind-pay" } },
    });
    expect(answered.matches.map((m) => [m.how, m.operation])).toEqual([["answer", "op.refund"]]);
  });

  it("reads only gateways' forwarding calls: a service's own calls are the estate join's", () => {
    const got = joinVendorOperations({ repos: estate(), vendors: [northwind()] });
    expect(got.matches.every((m) => m.call.repo === GW)).toBe(true);
  });
});
