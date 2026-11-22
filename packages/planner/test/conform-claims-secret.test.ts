import { describe, expect, it } from "vitest";
import { PLAIN, claim, fact, run } from "./claims-helpers.js";

/**
 * ADR 0206, the review's blocker 1: a secret's key is kept by a reference only when the reference is
 * written on the cited line; a literal (`source: literal:<file>`, or a value) is present differently.
 * The literals here are plain words built from parts, never a secret's shape, and are said nowhere.
 */

describe("a secret's key (ADR 0206, the review's blocker 1)", () => {
  const values = { "deploy/values-prod.yaml": [`ledger.client.key: ${PLAIN}`] };
  const cite = {
    file: "deploy/values-prod.yaml",
    line: 1,
    value: "ledger.client.key",
    quote: `ledger.client.key: ${PLAIN}`,
  };

  it("a secret written as a literal (source literal:<file>, as /atticus-map writes it) is present differently, never present", () => {
    const r = run(
      [claim("secret", { key: "ledger.client.key" })],
      [
        fact({
          kind: "config",
          id: "k-0",
          settingKind: "config",
          key: "ledger.client.key",
          source: "literal:deploy/values-prod.yaml",
          cite,
        }),
      ],
      values,
    );
    const c = r.claims[0]!;
    expect(c.outcome).toBe("present-differently");
    expect(c.found).toBe("key ledger.client.key, set to a literal in deploy/values-prod.yaml");
    expect(c.what).toBe(
      "forge-ledger sets ledger.client.key to a literal in deploy/values-prod.yaml: keep it in the secret store.",
    );
    expect(JSON.stringify(r)).not.toContain(PLAIN);
  });

  it("a literal given as a value is present differently too, and the value is never said", () => {
    const r = run(
      [claim("secret", { key: "ledger.client.key" })],
      [
        fact({
          kind: "config",
          id: "k-0",
          settingKind: "config",
          key: "ledger.client.key",
          value: PLAIN,
          cite,
        }),
      ],
      values,
    );
    expect(r.claims[0]!.outcome).toBe("present-differently");
    expect(r.claims[0]!.found).toBe(
      "key ledger.client.key, set to a literal in deploy/values-prod.yaml",
    );
    expect(JSON.stringify(r)).not.toContain(PLAIN);
  });

  it("a reference the cited line doesn't show is couldn't confirm, never present", () => {
    const r = run(
      [claim("secret", { key: "ledger.client.key" })],
      [
        fact({
          kind: "config",
          id: "k-0",
          settingKind: "config",
          key: "ledger.client.key",
          source: "vault:forge/ledger/client",
          cite,
        }),
      ],
      values,
    );
    const c = r.claims[0]!;
    expect(c.outcome).toBe("unconfirmed");
    expect(c.what).toBe(
      "Atticus couldn't confirm that forge-ledger keeps ledger.client.key by a reference to where secrets are kept: deploy/values-prod.yaml:1 doesn't show vault:forge/ledger/client, so the reference is only the assistant's reading.",
    );
    expect(c.next).toBe(
      "Have your assistant read deploy/values-prod.yaml in forge-ledger's branch again into openspec/changes/move-orders-to-anvil/conform/facts/forge-ledger.jsonl, citing the line (or a cite.with part) that names where the value is kept, then check again: atticus change conform move-orders-to-anvil. Or check it by hand.",
    );
    expect(JSON.stringify(r)).not.toContain(PLAIN);
  });

  it("a reference written on the cited line is present, and says so", () => {
    const r = run(
      [claim("secret", { key: "ledger.client.key" })],
      [
        fact({
          kind: "config",
          id: "k-0",
          settingKind: "config",
          key: "ledger.client.key",
          source: "env:LEDGER_CLIENT_KEY",
          cite: { ...cite, quote: "ledger.client.key: ${LEDGER_CLIENT_KEY}" },
        }),
      ],
      { "deploy/values-prod.yaml": ["ledger.client.key: ${LEDGER_CLIENT_KEY}"] },
    );
    expect(r.claims[0]!.outcome).toBe("present");
    expect(r.claims[0]!.why).toBe("Written on the cited lines: source env:LEDGER_CLIENT_KEY.");
  });
});
