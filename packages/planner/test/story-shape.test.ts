import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parseRecord, type CatalogRecord, type FlowRecord } from "@maycombhq/core";
import {
  applyShape,
  assignFromAnswer,
  estateOf,
  FlowDelta,
  numberedStories,
  readShape,
  readStoryNumbers,
  recordShape,
  removeShape,
  shapeAfterDraft,
  shapeIssues,
  shapePrompt,
  taskLabel,
  writeShape,
  writeStoryNumbers,
  type DeltaStory,
} from "../src/index.js";

/**
 * ADR 0189, "the BA shapes, the AI re-checks": a business analyst renames, splits, merges or adds
 * a story in plain words; the AI maps the tasks to them; nothing is left uncovered; numbers stay.
 * Invented: the Forge order summary (fixtures/stages/stories-units/).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const UNITS = join(HERE, "../../../fixtures/stages/stories-units");
const AT = "2026-11-09T10:00:00Z";

const recs = (rows: unknown[]): CatalogRecord[] =>
  rows.map((r) => {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    return p.record;
  });
function units() {
  const read = (f: string) => readFileSync(join(UNITS, f), "utf8");
  const e = estateOf(
    recs(parse(read("catalog.yaml")) as unknown[]),
    recs(parse(read("flows.yaml")) as unknown[]).map((flow) => ({
      repo: (flow as FlowRecord).component,
      flow: flow as FlowRecord,
    })),
  );
  const deltas = (parse(read("deltas.yaml")) as { flows: unknown[] }).flows.map((d) =>
    FlowDelta.parse({ schemaVersion: 2, ...(d as object) }),
  );
  return numberedStories(deltas, e);
}
const rows = (stories: DeltaStory[]) =>
  stories.map((s) => [s.id, s.name, s.tasks.map((t) => `${taskLabel(s, t)}=${t.id}`).join(" ")]);

async function drafted() {
  const dir = await mkdtemp(join(tmpdir(), "atticus-shape-"));
  const r = units();
  await writeStoryNumbers(dir, r.numbers);
  return { dir, ...r };
}

describe("the business analyst shapes the stories", () => {
  it("refuses before the stories are drafted, and a story that isn't there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-shape-"));
    await expect(
      recordShape(dir, { op: "rename", story: "s1", name: "x" }, { by: "bea", at: AT }),
    ).rejects.toThrow(/aren't drafted yet/);
    const d = await drafted();
    await expect(
      recordShape(d.dir, { op: "rename", story: "s9-nope", name: "x" }, { by: "bea", at: AT }),
    ).rejects.toThrow(/no story s9-nope/);
  });

  it("renames a story: same number, same tasks, the BA's name as its title", async () => {
    const d = await drafted();
    const { shape } = await recordShape(
      d.dir,
      { op: "rename", story: "s2-summarise-order", name: "Show the order's summary" },
      { by: "@bea", at: AT },
    );
    const s = applyShape(d.stories, shape);
    expect(rows(s.stories)).toEqual(
      rows(d.stories).map((r) =>
        r[0] === "s2-summarise-order" ? [r[0], "Show the order's summary", r[2]] : r,
      ),
    );
    expect(s.names.get("s2-summarise-order")).toBe("Show the order's summary");
    expect(shape.entries[0]).toMatchObject({ id: "sh-1", op: "rename", by: "bea" });
  });

  it("splits a story: the first part keeps its number, the new one takes the next free one, reserved", async () => {
    const d = await drafted();
    const { shape, entry } = await recordShape(
      d.dir,
      {
        op: "split",
        story: "s2-summarise-order",
        name: "Summarise the order",
        parts: [{ name: "Price the order", words: "the totals and the tax" }],
      },
      { by: "bea", at: AT },
    );
    expect(entry.parts).toEqual([
      { id: "s4-price-the-order", name: "Price the order", words: "the totals and the tax" },
    ]);
    // reserved: a story added later never takes number 4
    const numbers = (await readStoryNumbers(d.dir))!;
    expect(numbers.stories.map((x) => x.id)).toContain("s4-price-the-order");
    const before = applyShape(d.stories, shape);
    expect(before.stories.map((s) => s.id)).toEqual([
      "s1-route-orders",
      "s2-summarise-order",
      "s4-price-the-order",
      "s3-view-order",
    ]);
    // nothing mapped yet: the new part has no task, and the check says so
    expect(shapeIssues(before, shape)).toEqual([
      expect.stringContaining('Story s4-price-the-order "Price the order" has no task yet'),
    ]);
    expect(shapePrompt(before, shape)).toContain(
      'story s4-price-the-order: "Price the order", for: the totals and the tax (no task yet)',
    );

    // the AI's draft puts task 2.10 under the new part: it moves, numbered 4.1 there
    const answer = {
      stories: [
        { id: "s1-route-orders", tasks: [{ id: "1.1" }] },
        { id: "s2-summarise-order", tasks: [{ id: "2.1" }, { id: "2.3" }] },
        { id: "s4-price-the-order", tasks: [{ id: "2.10" }] },
        { id: "s3-view-order", tasks: [{ id: "3.1" }, { id: "3.3" }] },
      ],
    };
    const assign = assignFromAnswer(answer, before.stories, shape);
    expect(assign).toEqual({ "2.10": "s4-price-the-order" });
    const after = applyShape(d.stories, shape, assign);
    expect(rows(after.stories)).toEqual([
      ["s1-route-orders", rows(d.stories)[0]![1], "1.1=1.1"],
      ["s2-summarise-order", "Summarise the order", "2.1=2.1 2.2=2.3"],
      ["s4-price-the-order", "Price the order", "4.1=2.10"],
      ["s3-view-order", rows(d.stories)[2]![1], "3.1=3.1 3.2=3.3"],
    ]);
    // the critic's re-check: nothing uncovered
    expect(shapeIssues(after, shape)).toEqual([]);
    // kept for every later read, numbers too
    const kept = shapeAfterDraft(shape, after, AT);
    await writeShape(d.dir, kept);
    const again = applyShape(d.stories, await readShape(d.dir));
    expect(rows(again.stories)).toEqual(rows(after.stories));
    expect((await readShape(d.dir)).entries[0]!.applied).toBe(AT);
    const text = await readFile(join(d.dir, "stage/stories-shape.yaml"), "utf8");
    expect(text).toMatch(/"?2\.10"?: s4-price-the-order/);
  });

  it("merges stories of one repo into the first, and refuses two repos", async () => {
    const d = await drafted();
    await expect(
      recordShape(
        d.dir,
        { op: "merge", stories: ["s1-route-orders", "s2-summarise-order"], name: "x" },
        { by: "bea", at: AT },
      ),
    ).rejects.toThrow(/one repo's work/);
  });

  it("adds a story: next free number, its repo from the first task the AI gives it", async () => {
    const d = await drafted();
    const { shape, entry } = await recordShape(
      d.dir,
      { op: "add", name: "Show the order on the page", words: "the web page" },
      { by: "bea", at: AT },
    );
    expect(entry.added).toBe("s4-show-the-order-on-the-page");
    const before = applyShape(d.stories, shape);
    const answer = {
      stories: [{ id: "s4-show-the-order-on-the-page", tasks: [{ id: "3.3" }] }],
    };
    const after = applyShape(d.stories, shape, assignFromAnswer(answer, before.stories, shape));
    const added = after.stories.find((s) => s.id === entry.added)!;
    expect(added.repo).toBe("forge-web");
    expect(rows([added])).toEqual([
      ["s4-show-the-order-on-the-page", "Show the order on the page", "4.1=3.3"],
    ]);
    // a task of a story the shaping didn't touch never moves to another one it didn't
    const odd = applyShape(d.stories, shape, { "1.1": "s3-view-order" });
    expect(odd.stories.find((s) => s.id === "s1-route-orders")!.tasks.map((t) => t.id)).toEqual([
      "1.1",
    ]);
  });

  it("takes back a shaping no draft applied, but not one that was", async () => {
    const d = await drafted();
    const { shape } = await recordShape(
      d.dir,
      { op: "rename", story: "s1-route-orders", name: "Route" },
      { by: "bea", at: AT },
    );
    expect((await removeShape(d.dir, "sh-1")).entries).toEqual([]);
    await recordShape(
      d.dir,
      { op: "rename", story: "s1-route-orders", name: "Route" },
      { by: "bea", at: AT },
    );
    await writeShape(
      d.dir,
      shapeAfterDraft(await readShape(d.dir), applyShape(d.stories, shape), AT),
    );
    await expect(removeShape(d.dir, "sh-1")).rejects.toThrow(/in the stories since/);
  });

  it("changes nothing for a change no one shaped (the prompt is as it was)", () => {
    const { stories } = units();
    const s = applyShape(stories, { schemaVersion: 1, entries: [], assigned: {}, labels: {} });
    expect(rows(s.stories)).toEqual(rows(stories));
    expect(
      shapePrompt(s, { schemaVersion: 1, entries: [], assigned: {}, labels: {} }),
    ).toBeUndefined();
  });
});
