import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { runCritic, type CriticResult } from "../src/index.js";

/**
 * ADR 0006 addendum (2026-10-26), trial problem 4: `constitution.data-doc-present` demanded
 * data.md, but org-flow v2 ships no data.md template — the architecture stage writes one only
 * when a target flow changes the schema. So a change that only reads a store was blocked on a
 * document nobody writes. The rule now reads the stage's own artifact: on the stage path it asks
 * for data.md only when the target flows change the schema (a new table, a migration, a column
 * with a type), which is exactly when the stage writes one.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const STAGES = join(HERE, "../../../fixtures/stages");
const CHANGE = "screen-order-consent";
const FLOW = "target-flows/forge-orders.place-order.yaml";
const NOW = "2026-10-20T09:00:00Z";

async function estate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-data-doc-stage-"));
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

const summaries = (r: CriticResult, rule: string) =>
  r.findings.filter((f) => f.finding.rule === rule).map((f) => f.finding.summary);

describe("data.md and the architecture stage's own artifact (ADR 0006 addendum)", () => {
  it("doesn't ask for data.md when the target flows change no schema", async () => {
    const root = await estate();
    // The fixture's one store step is a read of columns the catalog already has: no schema change,
    // so the architecture stage writes no data.md, and nothing may block on one.
    const r = await runCritic(root, CHANGE, { now: NOW, gate: "design" });
    expect(summaries(r, "constitution.data-doc-present")).toEqual([]);
  });

  it("asks for data.md, and names the stage that writes it, once a flow changes the schema", async () => {
    const root = await estate();
    const flow = join(root, "openspec/changes", CHANGE, FLOW);
    const text = await readFile(flow, "utf8");
    await writeFile(
      flow,
      text.replace(
        "      columns:\n        - customer_id",
        "      migration: V12__add_screened_at.sql\n      types:\n        screened_at: timestamptz\n      columns:\n        - screened_at\n        - customer_id",
      ),
    );
    const r = await runCritic(root, CHANGE, { now: NOW, gate: "design" });
    expect(summaries(r, "constitution.data-doc-present")).toEqual([
      "The change touches forge-orders-db but data.md is missing.",
    ]);
    const fix = r.findings.find((f) => f.finding.rule === "constitution.data-doc-present")!.finding
      .fix.text;
    expect(fix).toBe(
      "Run atticus change architecture screen-order-consent: it writes data.md from the target flows (the Changes table, backfill, classification and retention). Edit the flows, never data.md.",
    );
  });

  it("reads orders.status in a design as the orders table, and a record id that only ends in a table's name as nothing (ADR 0203 review)", async () => {
    const design = async (line: string) => {
      const root = await estate();
      const dir = join(root, "openspec/changes", CHANGE);
      // A design off the stage path: no target flow says what the change stores.
      for (const f of [
        "target-flows",
        "feature.yaml",
        "stories",
        "stories.md",
        "tasks.md",
        "stage",
      ])
        await rm(join(dir, f), { recursive: true, force: true });
      await writeFile(join(dir, "design.md"), `# Design\n\n## Operations\n\n${line}\n`);
      return summaries(
        await runCritic(root, CHANGE, { now: NOW, gate: "design" }),
        "constitution.data-doc-present",
      );
    };
    expect(
      await design(
        "| deploy-new | deployment | forge-orders | forge-orders.deployment.prod: env prod |",
      ),
    ).toEqual([]);
    expect(await design("The cut-over backfills orders.status before the switch.")).toEqual([
      "The change touches forge-orders-db but data.md is missing.",
    ]);
    expect(await design("It reads forge-orders-db.orders.status as today.")).toHaveLength(1);
  });
});
