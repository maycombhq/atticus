import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFacts, type Fact } from "@maycombhq/core";
import { dirSource, verifyFacts } from "../src/index.js";

/**
 * ADR 0164, addendum of 2026-11-17: verify says, as a note and never a rejection, which classes
 * of a request or response no field of that payload reaches, so the contract check can't place
 * their fields. On the invented forge-desk (fixtures/contract-paths).
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/contract-paths");
const facts = (): Fact[] => {
  const p = parseFacts(readFileSync(join(FIX, "facts", "forge-desk.jsonl"), "utf8"));
  if (!p.ok) throw new Error(JSON.stringify(p.issues));
  return p.facts;
};
const verify = (f: Fact[]) =>
  verifyFacts({
    facts: f,
    source: dirSource(join(FIX, "repos", "forge-desk")),
    commit: f[0]!.commit,
  });

describe("verify: a payload's class no field reaches", () => {
  it("says nothing when every class is reached from its payload's fields", async () => {
    const r = await verify(facts());
    expect(r.rejected).toEqual([]);
    expect(r.fieldsUnplaced).toBeUndefined();
  });

  it("names the class, its fields and why, and rejects nothing", async () => {
    const f = facts().filter(
      (x) =>
        ![
          "field.shipments-response.cargo",
          "field.shipments-response-cargo.shipments",
          "field.shipment.stamps",
        ].includes(x.id),
    );
    const r = await verify(f);
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toHaveLength(f.length);
    expect(r.fieldsUnplaced).toEqual([
      {
        owner: "call.post.forge-parcels-shipments",
        side: "response",
        class: "Shipment",
        file: "src/main/java/forge/desk/parcels/model/response/Shipment.java",
        fields: ["field.shipment.shipment_id", "field.shipment.weight_grams"],
        why: "Shipment is not reached from the response's fields",
      },
    ]);
  });
});
