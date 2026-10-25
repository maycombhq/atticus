import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  countLines,
  formatLearn,
  learnReport,
  pastCorrections,
  readStory,
  trendOf,
} from "../src/index.js";

/**
 * H3: how much people changed what Atticus drafted, per merged change and stage, from the kept
 * pairs, and whether that falls over time. The fixture holds three archived Forge changes whose
 * drafts needed fewer edits each time, and one whose merge isn't in the clone yet.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/stages/corrections");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

async function root(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "atticus-learn-"));
  await cp(join(FIX, "changes"), join(r, "openspec/changes"), { recursive: true });
  return r;
}

async function golden(name: string, actual: string): Promise<void> {
  const f = join(FIX, "expected", name);
  if (UPDATE) await writeFile(f, actual);
  expect(actual).toBe(await readFile(f, "utf8"));
}

describe("atticus change learn's report (H3)", () => {
  it("measures each merged stage and the trend, as the golden report", async () => {
    const r = await learnReport(await root());
    await golden("learn.json", JSON.stringify(r, null, 2) + "\n");
    await golden("learn.txt", formatLearn(r).join("\n") + "\n");
    expect(r.changes.map((c) => c.change)).toEqual([
      "screen-orders",
      "bulk-orders",
      "reserve-later",
    ]);
    expect(r.trend.byStage.feature!.direction).toBe("falling");
    expect(r.trend.byStage.stories!.direction).toBe("falling");
    expect(r.trend.byStage.architecture!.direction).toBe("too-few");
    expect(r.trend.overall.direction).toBe("falling");
    expect(r.pending).toEqual([
      expect.objectContaining({
        change: "restock-alert",
        stage: "feature",
        pr: 14,
        state: "waiting-for-merge",
      }),
    ]);
  });

  it("counts a story's criteria and fields added and removed, and the parts reworded", async () => {
    const r = await learnReport(await root());
    const s = r.changes[0]!.stages.find((x) => x.stage === "stories")!.stories[0]!;
    expect(s).toMatchObject({
      id: "s1-screen-order",
      status: "edited",
      criteria: {
        added: [
          "Given a rejected verdict, when the order is placed, then 422 says the verdict refused it and no stock is reserved",
        ],
        removed: ["Given any order, when it is placed, then it is logged"],
      },
      fields: { added: ["cardToken"], removed: [] },
      changed: ["title", "Acceptance criteria", "Data changes", "Tasks"],
    });
  });

  it("is deterministic: the same pairs give the same report", async () => {
    const a = JSON.stringify(await learnReport(await root()));
    const b = JSON.stringify(await learnReport(await root()));
    expect(a).toBe(b);
  });

  it("says there is nothing yet when no hand-off has a kept draft", async () => {
    const r = await learnReport(await mkdtemp(join(tmpdir(), "atticus-learn-empty-")));
    expect(r.changes).toEqual([]);
    expect(formatLearn(r)[0]).toContain("No merged hand-off has a kept draft yet");
  });
});

describe("line counts", () => {
  it("pairs a removed line with an added one as changed, and counts the rest", () => {
    expect(countLines("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual({
      drafted: 3,
      merged: 4,
      added: 1,
      removed: 0,
      changed: 1,
    });
    expect(countLines("a\nb\n", undefined)).toMatchObject({ removed: 2, added: 0, changed: 0 });
    expect(countLines(undefined, "x\n")).toMatchObject({ added: 1 });
  });

  it("reads a story's criteria from its tasks when it has no story-level list", () => {
    const s = readStory(
      "# T\n\nAs a shop owner I want x so that y.\n\n## Tasks\n\n### Task 1.1: x\n\n- Fields: sku, quantity\n- Acceptance criteria:\n  - Given a, when b, then c. (Entry: POST /orders)\n",
    );
    expect(s.criteria).toEqual(["Given a, when b, then c"]);
    expect(s.fields).toEqual(["quantity", "sku"]);
    expect(s.statement).toBe("As a shop owner I want x so that y.");
  });
});

describe("the trend", () => {
  it("needs three merged stages, and compares the earlier half with the later", () => {
    const p = (change: string, mergedAt: string, editRate: number) => ({
      change,
      stage: "feature",
      mergedAt,
      editRate,
    });
    expect(trendOf([p("a", "2026-01-01", 0.5), p("b", "2026-02-01", 0.1)]).direction).toBe(
      "too-few",
    );
    expect(
      trendOf([p("c", "2026-03-01", 0.3), p("a", "2026-01-01", 0.3), p("b", "2026-02-01", 0.9)]),
    ).toMatchObject({ earlier: 0.3, later: 0.3, direction: "flat" });
    expect(
      trendOf([p("a", "2026-01-01", 0.1), p("b", "2026-02-01", 0.2), p("c", "2026-03-01", 0.4)]),
    ).toMatchObject({ direction: "rising" });
  });
});

describe("the closest past corrections (H2)", () => {
  it("picks at most two pairs of the same stage that share a repo, table or entry, most shared first", async () => {
    const r = await root();
    const past = await pastCorrections(r, {
      stage: "feature",
      change: "add-fraud-check",
      touches: { repos: ["forge-orders"], tables: [], flows: [], systems: [], entry: "brief" },
    });
    // reserve-later merged as drafted: nothing to learn from it.
    expect(past.map((p) => [p.change, p.shares])).toEqual([
      ["bulk-orders", ["repo forge-orders", "entry brief"]],
      ["screen-orders", ["repo forge-orders", "entry brief"]],
    ]);
    const hunk = past[1]!.files.find((f) => f.path === "feature.yaml")!.hunks[0]!;
    expect(hunk.drafted).toEqual([
      "    how: changed",
      "    why: Reserving stock waits for the screen.",
    ]);
    expect(hunk.merged).toEqual([
      "    how: read",
      "    why: Reserving stock happens only after the screen passes.",
    ]);
  });

  it("finds nothing for a change that shares nothing, and never the change itself", async () => {
    const r = await root();
    expect(
      await pastCorrections(r, {
        stage: "architecture",
        change: "x",
        touches: { repos: ["forge-billing"], tables: [], flows: [], systems: [] },
      }),
    ).toEqual([]);
    expect(
      await pastCorrections(r, {
        stage: "architecture",
        change: "screen-orders",
        touches: { repos: ["forge-orders"], tables: [], flows: [], systems: [] },
      }),
    ).toEqual([]);
    const arch = await pastCorrections(r, {
      stage: "architecture",
      change: "x",
      touches: { repos: [], tables: ["forge-orders-db.orders"], flows: [], systems: [] },
    });
    expect(arch.map((p) => [p.change, p.shares])).toEqual([
      ["screen-orders", ["table forge-orders-db.orders"]],
    ]);
  });
});
