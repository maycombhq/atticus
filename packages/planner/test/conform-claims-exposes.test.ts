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
    cite: {
      file: "anvil/ledger.yaml",
      line: 3,
      value: "ledger",
      quote: "name: ledger",
      with: [{ file: "anvil/ledger.yaml", line: 4, value: "ledger-api" }],
    },
  });
  /** The descriptor's lines: its name, then the component it exposes. */
  const DESCRIPTOR = {
    "anvil/ledger.yaml": ["kind: Service", "platform: anvil", "name: ledger", "app: ledger-api"],
  };
  const withOther = (x: Partial<Claim> = {}) => [
    claim("deployment", { platform: "anvil", env: "prod" }, { with: ["forge-deploy"], ...x }),
    claim("route", { host: "ledger.anvil.forge.example" }, { with: ["forge-deploy"], ...x }),
  ];

  it("a deploy fact with exposes naming the repo's component is present, cited in that repo", () => {
    const r = run(withOther(), [], DESCRIPTOR, {
      names: ["ledger-api"],
      elsewhere: [
        { repo: "forge-deploy", facts: [deployRepoFact], basis: { from: "facts", unread: [] } },
      ],
    });
    expect(r.claims.map((c) => c.outcome)).toEqual(["present", "present"]);
    expect(r.claims[0]!.at).toEqual([
      { source: "code", repo: "forge-deploy", path: "anvil/ledger.yaml", line: 3 },
    ]);
  });

  it("only a repo the operation names is read for it", () => {
    const r = run(withOther({ with: [] }), [], DESCRIPTOR, {
      names: ["ledger-api"],
      elsewhere: [
        { repo: "forge-deploy", facts: [deployRepoFact], basis: { from: "facts", unread: [] } },
      ],
    });
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

  it("a link to the repo that no cited line writes is couldn't confirm, never present (the re-review's blocker)", () => {
    const banana = fact({
      repo: "forge-portal-bff",
      kind: "deploy",
      id: "d-1",
      env: "prod",
      platform: "anvil",
      exposes: "ledger-api",
      host: "ledger.anvil.forge.example",
      resourceName: "banana",
      cite: { file: "deploy/anvil.yaml", line: 3, value: "banana", quote: "name: banana" },
    });
    const r = run(
      withOther({ with: ["forge-portal-bff"] }),
      [],
      { "deploy/anvil.yaml": ["kind: Service", "platform: anvil", "name: banana"] },
      {
        names: ["ledger-api"],
        elsewhere: [
          { repo: "forge-portal-bff", facts: [banana], basis: { from: "facts", unread: [] } },
        ],
      },
    );
    expect(r.claims.map((c) => c.outcome)).toEqual(["unconfirmed", "unconfirmed"]);
    expect(r.claims[0]!.what).toBe(
      "Atticus couldn't confirm that forge-ledger runs on anvil in prod: forge-portal-bff:deploy/anvil.yaml:3 says it exposes ledger-api, but no line it cites names ledger-api or forge-ledger, so the link to forge-ledger is only the assistant's reading.",
    );
    expect(r.claims[0]!.at[0]).toEqual({
      source: "code",
      repo: "forge-portal-bff",
      path: "deploy/anvil.yaml",
      line: 3,
    });
  });
});
