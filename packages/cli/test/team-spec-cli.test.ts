import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { intakeImpact } from "../src/vendor-impact-commands.js";

/**
 * O2 (ADR 0142): another team's spec as their system. The Forge Risk Team (invented, boundary
 * `internal`, its host an alias from a hosts question, no repo in the estate) publishes an
 * OpenAPI spec, taken in through intake as a vendor's is; `atticus intake impact` lands billing's
 * own call on its operation, says the field 2.0.0 requires isn't sent, and walks up to the shop.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FX = join(HERE, "../../../fixtures/team-spec");
const V2 = "inputs/partner-specs/forge-risk-openapi-v2.yaml";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

async function root(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "atticus-cli-team-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(r, "org-pack"), { recursive: true });
  await writeFile(join(r, "org-pack/sources.yaml"), "schemaVersion: 1\nwikis: []\n");
  await cp(join(FX, "org-pack/profiles/forge"), join(r, "org-pack/profiles/forge"), {
    recursive: true,
  });
  for (const d of ["inputs", "facts"]) await cp(join(FX, d), join(r, d), { recursive: true });
  return r;
}

describe("atticus intake impact, another team's spec", () => {
  it("lands the estate's own call on the team's operation and checks the field that crosses", async () => {
    const r = await root();
    const c = capture();
    expect(await intakeImpact(r, V2, {}, c.io)).toBe(1);
    expect(c.err).toEqual([]);
    expect(c.out[0]).toBe(
      "Forge Risk Team: inputs/partner-specs/forge-risk-openapi-v1.yaml (1.0.0) → inputs/partner-specs/forge-risk-openapi-v2.yaml (2.0.0)",
    );
    expect(c.out).toContain(
      "  called directly by billing-api: POST /v1/assessments, forge-billing src/main/java/forge/billing/RiskClient.java:12 (on Forge Risk Team), doesn't send channel",
    );
    expect(c.out).toContain(
      "    under forge-billing src/main/java/forge/billing/InvoicesController.java:13",
    );
    expect(c.out).toContain(
      "    ← shop-bff: forge-shop-bff src/main/java/forge/shop/BillingClient.java:9, under forge-shop-bff src/main/java/forge/shop/CheckoutController.java:16",
    );
    expect(c.out).toContain("Affected: forge-billing, forge-shop-bff.");
  });

  it("gives the impact's systems, the team's among them", async () => {
    const r = await root();
    const c = capture();
    expect(await intakeImpact(r, V2, { json: true }, c.io)).toBe(1);
    const got = JSON.parse(c.out.join("\n")) as {
      impact: { systems: string[]; changes: { forwards: { direct?: boolean }[] }[] };
    };
    expect(got.impact.systems).toEqual(["billing", "forge-risk", "shop"]);
    expect(got.impact.changes[0]!.forwards.map((f) => f.direct)).toEqual([true]);
  });
});
