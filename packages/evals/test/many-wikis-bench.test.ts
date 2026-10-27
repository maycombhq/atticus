import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { manyWikisTotals, renderManyWikisTable, runManyWikisBench } from "../src/index.js";

// ADR 0132: each task's knowledge across 12 wikis, against the pages written by hand before the
// code (fixtures/many-wikis/expected.yaml), before and after authority, scope and page status.

const FX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

describe("the many-wikis bench", () => {
  it("lists nothing out of scope, leads every topic with the expected page, and never does worse", async () => {
    const run = await runManyWikisBench(FX);
    expect(run.rows).toHaveLength(28);
    const before = manyWikisTotals(run, "before");
    const after = manyWikisTotals(run, "after");
    expect(after.never).toBe(0);
    expect(before.never).toBeGreaterThan(0);
    expect(after.leads.right).toBe(after.leads.of);
    expect(after.recall).toBeGreaterThanOrEqual(before.recall);
    expect(after.precision).toBeGreaterThan(before.precision);
    expect(after.suggested.right).toBeGreaterThan(before.suggested.right);
    // The GCP platform's how-to reaches the task that creates the new component, and only it.
    const gcp = run.rows.filter(
      (r) => r.mode === "after" && r.never.includes("cloud-run-new-service"),
    );
    expect(gcp).toEqual([]);
    expect(run.rows.find((r) => r.task === "3.1" && r.mode === "after")!.missing).toEqual([]);
    expect(renderManyWikisTable([run])).toContain(
      "| 12 sources, planted pages (32 pages) | after |",
    );
  }, 300_000);
});
