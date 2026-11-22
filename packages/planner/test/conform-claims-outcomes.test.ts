import { describe, expect, it } from "vitest";
import { claim, fact, run } from "./claims-helpers.js";

/**
 * ADR 0206, the review: missing only when nothing is unread (a mutation that survived), a fact that
 * names no env against a claim for one, and a pipeline's file by its path.
 */

describe("missing needs nothing unread (the review's surviving mutation)", () => {
  const nothing = [claim("config", { key: "ledger.retry.max" })];
  it("a key no fact has, with a file no fact covers, is couldn't confirm", () => {
    const r = run(
      nothing,
      [],
      {},
      { basis: { from: "facts", unread: ["deploy/values-prod.yaml"] } },
    );
    expect(r.claims[0]!.outcome).toBe("unconfirmed");
  });
  it("and with the built-in readers only, or nobody's read", () => {
    expect(run(nothing, [], {}, { basis: { from: "readers" } }).claims[0]!.outcome).toBe(
      "unconfirmed",
    );
    expect(run(nothing, [], {}, { basis: { from: "none" } }).claims[0]!.outcome).toBe(
      "unconfirmed",
    );
  });
  it("and is missing when the facts cover the commit with nothing unread", () => {
    expect(run(nothing, [], {}).claims[0]!.outcome).toBe("missing");
  });
});
describe("a fact that names no env, against a claim for prod (the review's nits)", () => {
  it("a deployment with no env is couldn't confirm, not present differently", () => {
    const r = run(
      [claim("deployment", { platform: "anvil", env: "prod" })],
      [
        fact({
          kind: "deploy",
          id: "d-0",
          platform: "hosts",
          resourceName: "ledger",
          cite: { file: "deploy/hosts.yaml", line: 2, value: "ledger", quote: "name: ledger" },
        }),
      ],
      { "deploy/hosts.yaml": ["kind: Host", "name: ledger"] },
    );
    expect(r.claims[0]!.outcome).toBe("unconfirmed");
    expect(r.claims[0]!.what).toBe(
      "Atticus couldn't confirm that forge-ledger runs on anvil in prod: deploy/hosts.yaml:2 names no env, so which env it is for isn't read.",
    );
  });

  it("a setting with no env is couldn't confirm too", () => {
    const r = run(
      [claim("config", { key: "ledger.retry.max", env: "prod", value: "5" })],
      [
        fact({
          kind: "config",
          id: "k-0",
          settingKind: "retry",
          key: "ledger.retry.max",
          value: "3",
          cite: {
            file: "src/main/resources/application.yaml",
            line: 1,
            value: "ledger.retry.max",
            quote: "ledger.retry.max: 3",
          },
        }),
      ],
      {},
    );
    expect(r.claims[0]!.outcome).toBe("unconfirmed");
  });
});
describe("a pipeline's file is its path in the repo (the review's nits)", () => {
  const pipeline = (file: string, files: string[]) =>
    run([claim("pipeline", { file })], [], {}, { files }).claims[0]!;
  it("a file of that name in another folder isn't it", () => {
    expect(pipeline("pipeline.yaml", ["ci/old/pipeline.yaml"]).outcome).toBe("missing");
    expect(pipeline(".anvil/pipeline.yaml", ["test/.anvil/pipeline.yaml"]).outcome).toBe("missing");
    expect(pipeline("./.anvil/pipeline.yaml", [".anvil/pipeline.yaml"]).outcome).toBe("present");
  });
  it("a migration keeps today's rule: its file name, wherever the migrations are", () => {
    const r = run(
      [claim("migration", { file: "V7__receipts.sql" })],
      [],
      {},
      { files: ["src/main/resources/db/migration/V7__receipts.sql"] },
    );
    expect(r.claims[0]!.outcome).toBe("present");
  });
});
