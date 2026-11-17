import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkContracts, parseFacts, type Fact } from "@maycombhq/core";
import { openApiContractSpecs, readVendorSpec } from "@maycombhq/intake";
import { dirSource, verifyFacts } from "@maycombhq/verify";

/**
 * A field's place in the payload (ADR 0164, addendum of 2026-11-17), from the files: the
 * invented forge-desk's classes (fixtures/contract-paths/repos), its facts as a reader wrote
 * them (each class's fields bare, in the class's own file) and Forge Parcels' Shipments
 * OpenAPI spec as intake reads it from inputs/inbox. Files only; nothing here is a real system.
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/contract-paths");
const SPEC = "inputs/inbox/forge-parcels-shipments-v1.yaml";
const CALL = "call.post.forge-parcels-shipments";
const LIST = "cargo.shipments";

const facts = (): Fact[] => {
  const p = parseFacts(readFileSync(join(FIX, "facts", "forge-desk.jsonl"), "utf8"));
  if (!p.ok) throw new Error(JSON.stringify(p.issues));
  return p.facts;
};
const spec = () => {
  const vendor = readVendorSpec(SPEC, readFileSync(join(FIX, SPEC), "utf8"), "forge-parcels");
  if (!vendor) throw new Error("the spec doesn't read");
  return openApiContractSpecs(vendor);
};
const check = (f: Fact[]) => {
  const specs = spec();
  return checkContracts({
    repos: [{ repo: "forge-desk", facts: f }],
    join: { joins: [], asks: [], misses: [], lineage: [], gaps: [] },
    outside: [{ system: "forge-parcels", name: "Forge Parcels Shipments API", specs }],
    vendorMatches: [
      {
        call: { repo: "forge-desk", fact: CALL, component: "forge-desk", at: "x:1" },
        vendor: "forge-parcels",
        how: "host",
        operation: specs[0]!.id!,
        method: "POST",
        path: "/parcels/v1/shipments",
      } as never,
    ],
  });
};

describe("forge-desk against Forge Parcels' spec, from the files", () => {
  it("the facts verify against the classes they cite", async () => {
    const f = facts();
    const report = await verifyFacts({
      facts: f,
      source: dirSource(join(FIX, "repos", "forge-desk")),
      commit: f[0]!.commit,
    });
    expect(report.rejected, JSON.stringify(report.rejected)).toEqual([]);
  });

  it("the spec read through intake nests its fields, required ones marked", () => {
    const fields = spec()[0]!.fields;
    const names = (side: string, required?: boolean) =>
      fields
        .filter((x) => x.side === side && (required === undefined || x.required === required))
        .map((x) => x.name);
    expect(names("request", true)).toEqual([
      "receipt",
      "receipt.receiptNo",
      "cargo",
      LIST,
      `${LIST}[].parcelId`,
    ]);
    expect(names("response")).toContain("receipt.stamps[].depot");
    expect(names("response")).toContain(`${LIST}[].stamps[].depot`);
  });

  it("no false mismatch; the two real differences at their full paths; the envelope unconfirmed", () => {
    const r = check(facts());
    expect(r.findings.map((f) => `${f.status} ${f.kind} ${f.side} ${f.field}`)).toEqual([
      "mismatch field-missing response receipt.depot_token",
      "unconfirmed field-not-sent request receipt",
      "unconfirmed field-not-sent request receipt.receiptNo",
      `mismatch field-type response ${LIST}[].weightGrams`,
    ]);
    expect(r.links).toHaveLength(1);
    expect(r.links[0]).toMatchObject({ compared: 1, mismatches: 2, unconfirmed: 2 });
    expect(r.findings[1]!.message).toBe(
      `Forge Parcels Shipments API's spec forge-parcels-shipments-v1.yaml requires the request field receipt (${SPEC}:35), which forge-desk's call doesn't send; unconfirmed: forge-desk's call's request fields on record don't start at the payload's root`,
    );
  });
});
