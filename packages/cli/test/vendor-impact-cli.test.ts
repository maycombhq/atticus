import { readFileSync } from "node:fs";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { changeFootprint, loadChangeContext, changeStore } from "@maycombhq/changes";
import { changeNew } from "../src/change-commands.js";
import { intakeImpact } from "../src/vendor-impact-commands.js";

/**
 * atticus intake impact <spec> (ADR 0130): what a newer version of a vendor's spec does to the
 * estate, printed and as JSON, and a change started from it with the footprint filled in.
 * Northwind Pay is an invented vendor; the expected output is written by hand.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FX = join(HERE, "../../../fixtures/vendor-impact");
const V1 = "inputs/partner-specs/northwind-pay-openapi-v1.yaml";
const V2 = "inputs/partner-specs/northwind-pay-openapi-v2.yaml";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

/** A metarepo with the Forge org pack, the fixture's profile and manifest, its specs, facts and flows. */
async function root(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "atticus-cli-vendor-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(r, "org-pack"), { recursive: true });
  await writeFile(join(r, "org-pack/sources.yaml"), "schemaVersion: 1\nwikis: []\n");
  await cp(join(FX, "org-pack/profiles/forge"), join(r, "org-pack/profiles/forge"), {
    recursive: true,
  });
  for (const d of ["inputs", "facts", "specs"])
    await cp(join(FX, d), join(r, d), { recursive: true });
  return r;
}

describe("atticus intake impact", () => {
  it("prints each change of the newer version and what in the estate it reaches, cited", async () => {
    const r = await root();
    const c = capture();
    expect(await intakeImpact(r, V2, {}, c.io)).toBe(1);
    expect(c.err).toEqual([]);
    expect(c.out.join("\n") + "\n").toBe(readFileSync(join(FX, "expected/impact.txt"), "utf8"));
  });

  it("gives the diff and the impact as JSON, the impact the hand-written one", async () => {
    const r = await root();
    const c = capture();
    expect(await intakeImpact(r, V2, { json: true }, c.io)).toBe(1);
    const got = JSON.parse(c.out.join("\n")) as { diff: unknown[]; impact: unknown };
    expect(got.impact).toEqual(parse(readFileSync(join(FX, "expected/impact.yaml"), "utf8")));
    expect(got.diff).toEqual(
      (parse(readFileSync(join(FX, "expected/diff.yaml"), "utf8")) as { changes: unknown[] })
        .changes,
    );
  });

  it("takes the older version too, or the file name alone, and compares it with the one that replaces it", async () => {
    const r = await root();
    for (const spec of [V1, "northwind-pay-openapi-v1.yaml", join(r, V2)]) {
      const c = capture();
      expect(await intakeImpact(r, spec, { json: true }, c.io)).toBe(1);
      const got = JSON.parse(c.out.join("\n")) as { impact: { older: { path: string } } };
      expect(got.impact.older.path).toBe(V1);
    }
  });

  it("says what to do when there is no other version, or no such spec", async () => {
    const r = await root();
    await writeFile(
      join(r, "inputs/partner-specs/northwind-pay-openapi-v1.yaml"),
      "openapi: 3.0.3\ninfo: { title: Something Else, version: 1.0.0 }\npaths: {}\n",
    );
    let c = capture();
    expect(await intakeImpact(r, V2, {}, c.io)).toBe(1);
    expect(c.err).toEqual([
      `${V2} has no other version beside it in inputs/, so there is nothing to compare. Add each version of a vendor's spec beside the last (atticus intake add), never over it.`,
    ]);
    c = capture();
    expect(await intakeImpact(r, "inputs/partner-specs/nothing.yaml", {}, c.io)).toBe(1);
    expect(c.err).toEqual([
      "There is no inputs/partner-specs/nothing.yaml in inputs/. atticus intake list shows what is there.",
    ]);
    c = capture();
    expect(await intakeImpact(r, "", {}, c.io)).toBe(2);
    expect(c.err).toEqual(["Name the vendor spec: atticus intake impact <spec> [--json]"]);
  });
});

describe("atticus change new --impact", () => {
  it("starts a change whose footprint is the impact: the vendor, the repos, the flows and the Interfaces", async () => {
    const r = await root();
    const c = capture();
    expect(
      await changeNew(
        r,
        { title: "Absorb Northwind Pay 2.0.0", type: "integration", by: "pat", impact: V2 },
        c.io,
        { now: "2026-10-26T09:00:00Z" },
      ),
    ).toBe(0);
    expect(c.out).toEqual([
      "Created absorb-northwind-pay-2-0-0 (integration, from the decommission template). It is in define.",
      "Its footprint is what Northwind Pay 2.0.0 reaches: 3 repos, 3 flows, 4 Interfaces. The impact is attached as inputs/northwind-pay-2-0-0-impact.md.",
      "Write the brief: openspec/changes/absorb-northwind-pay-2-0-0/brief.md",
    ]);
    const change = await changeStore(r).read("absorb-northwind-pay-2-0-0");
    expect(change.systems).toEqual(["billing", "northwind-pay", "platform", "shop"]);
    expect(change.touches.repos).toEqual([
      "forge-billing",
      "forge-partner-gateway",
      "forge-shop-bff",
    ]);
    expect(change.touches.interfaces).toEqual([
      { id: "if-88a31c9267d4d8ff", status: "planned-modify" },
      { id: "if-c804394bfd01dd5d", status: "planned-modify" },
      { id: "if-dcf1176ce394baa4", status: "planned-modify" },
      { id: "if-f58bce6a7580e064", status: "planned-modify" },
    ]);
    expect(change.touches.records).toEqual([
      "billing-api.pay-invoice",
      "billing-api.refund-invoice",
      "northwind-pay.post-capture",
      "northwind-pay.post-charge",
      "northwind-pay.post-refund",
      "shop-bff.checkout",
    ]);
    const footprint = await changeFootprint(await loadChangeContext(r), change);
    expect(footprint.flows).toEqual([
      { id: "billing-api.pay-invoice", repo: "forge-billing", change: "modify" },
      { id: "billing-api.refund-invoice", repo: "forge-billing", change: "modify" },
      { id: "shop-bff.checkout", repo: "forge-shop-bff", change: "modify" },
    ]);
    expect(footprint.repos).toEqual(["forge-billing", "forge-partner-gateway", "forge-shop-bff"]);
    const md = await readFile(
      join(r, "openspec/changes/absorb-northwind-pay-2-0-0/inputs/northwind-pay-2-0-0-impact.md"),
      "utf8",
    );
    expect(md.split("\n").slice(0, 3)).toEqual([
      "# What Northwind Pay 2.0.0 changes, and what in the estate it reaches",
      "",
      "Northwind Pay: inputs/partner-specs/northwind-pay-openapi-v1.yaml (1.0.0) → inputs/partner-specs/northwind-pay-openapi-v2.yaml (2.0.0)",
    ]);
  });

  it("refuses a spec with nothing to compare, and starts no change", async () => {
    const r = await root();
    const c = capture();
    expect(
      await changeNew(
        r,
        {
          title: "Absorb",
          type: "integration",
          by: "pat",
          impact: "inputs/partner-specs/nothing.yaml",
        },
        c.io,
      ),
    ).toBe(1);
    expect(c.err).toEqual([
      "There is no inputs/partner-specs/nothing.yaml in inputs/. atticus intake list shows what is there.",
    ]);
    await expect(changeStore(r).read("absorb")).rejects.toThrow();
  });
});
