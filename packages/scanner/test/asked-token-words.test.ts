import { describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import { askedTokenOf } from "../src/build.js";

/**
 * ADR 0195, the beta.28.1 addendum's sub-addendum (the owner, 2026-11-19): an arrow removed
 * because its call is asked about now says why in the words of its host's form.
 */
const ev = { source: "code", repo: "forge-payments", path: "src/Client.java", line: 6 };
const arrow = {
  kind: "Interface",
  id: "if-1",
  from: "forge-payments",
  to: "forge-ledger",
  evidence: [{ ...ev, side: "caller" }],
} as unknown as CatalogRecord;
const loose = (raw: string) =>
  ({
    kind: "Unresolved",
    id: "unresolved.forge-payments.c-token",
    owner: "forge-payments",
    raw,
    evidence: [ev],
  }) as unknown as CatalogRecord;
const at = (raw: string) => new Map([[`${ev.repo}\u0000${ev.path}\u0000${ev.line}`, [loose(raw)]]]);

describe("the words of an arrow asked about now, by its host's form", () => {
  it("a deploy token nothing sets, or a variable Atticus couldn't find the value of", () => {
    expect(askedTokenOf(arrow, at("PUT http://${FORGE_LEDGER_URL}/v1/x"))).toBe(
      "the host is a deploy token nothing sets: asked now (Unresolved/unresolved.forge-payments.c-token)",
    );
    expect(askedTokenOf(arrow, at("PUT http://@forgeLedgerUrl@/v1/x"))).toMatch(/deploy token/);
    for (const raw of ["PUT http://${this.cfg.url}/v1/x", "PUT http://$baseUrl/v1/x"])
      expect(askedTokenOf(arrow, at(raw)), raw).toBe(
        "the host is a variable Atticus couldn't find the value of: asked now (Unresolved/unresolved.forge-payments.c-token)",
      );
    // A loose end whose host is a real one isn't this.
    expect(askedTokenOf(arrow, at("PUT http://ledger.forge.internal/v1/x"))).toBeUndefined();
  });
});
