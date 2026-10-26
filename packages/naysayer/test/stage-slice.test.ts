import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import {
  changeFolder,
  changeFootprint,
  changeStore,
  changeTypeOf,
  loadChangeContext,
} from "@maycombhq/changes";
import { buildContext, catalogSlice, readChangeFiles } from "../src/index.js";

/**
 * The critic's catalog slice for a change on the stage path (ADR 0124 addendum B-change): the
 * records its target flows touch, from a footprint read from feature.yaml and target-flows/, not
 * the 21 tokens an empty change.yaml gave.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const STAGES = join(HERE, "../../../fixtures/stages");
const CHANGE = "screen-order-consent";

async function estate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-stage-slice-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const rows = [
    ...(parse(readFileSync(join(STAGES, "../specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(STAGES, "catalog-extra.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(STAGES, "footprint/catalog.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(STAGES, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(STAGES, "footprint", CHANGE), join(root, "openspec/changes", CHANGE), {
    recursive: true,
  });
  return root;
}

describe("the critic's catalog slice on the stage path", () => {
  it("holds the records the target flows touch, and not the rest of the component", async () => {
    const root = await estate();
    const lifecycle = await loadChangeContext(root);
    const change = await changeStore(root).read(CHANGE);
    const footprint = await changeFootprint(lifecycle, change);
    const ctx = buildContext({
      root,
      change,
      type: changeTypeOf(lifecycle, change.type),
      lifecycle,
      footprint,
      files: await readChangeFiles(changeFolder(root, change.id)),
      gate: lifecycle.orgPack.gates.gates.find((g) => g.id === "design")!,
      now: "2026-10-24T12:00:00Z",
    });
    const ids = [...catalogSlice(ctx).matchAll(/^(?:- | {2})id: (\S+)$/gm)].map((m) => m[1]);
    expect(ids).toEqual(
      expect.arrayContaining([
        "forge",
        "northwind-pay",
        "forge-orders",
        "forge-orders.post-orders",
        "forge-orders-db",
        "forge-orders-db.customer_consent",
        "forge-orders-db.customer_consent.customer_id",
        "forge-orders-db.customer_consent.purpose",
        "forge-orders-db.customer_consent.revoked_at",
      ]),
    );
    // Entries of the component the change neither starts at nor calls stay out.
    expect(ids).not.toContain("forge-orders.get-orders-orderid");
    expect(ids).not.toContain("forge-orders.delete-orders-orderid");
  });
});
