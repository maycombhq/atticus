import { describe, expect, it } from "vitest";
import { claim, fact, run } from "./claims-helpers.js";
import type { Claim } from "../src/index.js";

/**
 * ADR 0206, the review's point 7: a deployment or route read in another repo the operation names, by
 * a deploy fact whose `exposes` names this repo or one of its components.
 */

describe("a deployment read in another repo the operation names (the review's point 7)", () => {
  const deployRepoFact = fact({
    repo: "forge-deploy",
    kind: "deploy",
    id: "d-9",
    env: "prod",
    platform: "anvil",
    exposes: "ledger-api",
    host: "ledger.anvil.forge.example",
    resourceName: "ledger",
    cite: { file: "anvil/ledger.yaml", line: 3, value: "ledger", quote: "name: ledger" },
  });
  const withOther = (x: Partial<Claim> = {}) => [
    claim("deployment", { platform: "anvil", env: "prod" }, { with: ["forge-deploy"], ...x }),
    claim("route", { host: "ledger.anvil.forge.example" }, { with: ["forge-deploy"], ...x }),
  ];

  it("a deploy fact with exposes naming the repo's component is present, cited in that repo", () => {
    const r = run(
      withOther(),
      [],
      {},
      {
        names: ["ledger-api"],
        elsewhere: [
          { repo: "forge-deploy", facts: [deployRepoFact], basis: { from: "facts", unread: [] } },
        ],
      },
    );
    expect(r.claims.map((c) => c.outcome)).toEqual(["present", "present"]);
    expect(r.claims[0]!.at).toEqual([
      { source: "code", repo: "forge-deploy", path: "anvil/ledger.yaml", line: 3 },
    ]);
  });

  it("only a repo the operation names is read for it", () => {
    const r = run(
      withOther({ with: [] }),
      [],
      {},
      {
        names: ["ledger-api"],
        elsewhere: [
          { repo: "forge-deploy", facts: [deployRepoFact], basis: { from: "facts", unread: [] } },
        ],
      },
    );
    expect(r.claims.map((c) => c.outcome)).toEqual(["missing", "missing"]);
  });

  it("another repo with a file no fact covers leaves missing couldn't confirm", () => {
    const r = run(
      withOther(),
      [],
      {},
      {
        names: ["ledger-api"],
        elsewhere: [
          {
            repo: "forge-deploy",
            facts: [],
            basis: { from: "facts", unread: ["anvil/ledger.yaml"] },
          },
        ],
      },
    );
    expect(r.claims.map((c) => c.outcome)).toEqual(["unconfirmed", "unconfirmed"]);
    expect(r.claims[0]!.what).toContain("forge-deploy");
  });

  it("another repo that serves something of its own, and declares no other's deployment, doesn't hold this one's outcome", () => {
    const service = fact({
      repo: "forge-deploy",
      kind: "entry",
      id: "e-1",
      entryType: "rest",
      method: "GET",
      path: "/v1/health",
      cite: { file: "src/Health.java", line: 3, value: "/v1/health" },
    });
    const r = run(
      withOther(),
      [
        fact({
          kind: "deploy",
          id: "d-0",
          env: "prod",
          platform: "hosts",
          resourceName: "ledger",
          host: "ledger.hosts.forge.example",
          cite: { file: "deploy/hosts.yaml", line: 2, value: "ledger", quote: "name: ledger" },
        }),
      ],
      {},
      {
        names: ["ledger-api"],
        elsewhere: [
          {
            repo: "forge-deploy",
            facts: [service],
            basis: { from: "facts", unread: ["deploy/anvil.yaml"] },
          },
        ],
      },
    );
    expect(r.claims.map((c) => c.outcome)).toEqual(["present-differently", "present-differently"]);
  });
});
