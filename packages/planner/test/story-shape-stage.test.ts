import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord, type CatalogRecord } from "@maycombhq/core";
import {
  applyShape,
  architectureStage,
  draftedStories,
  EXPAND_AGENT,
  featureStage,
  readShape,
  readStoryNumbers,
  recordShape,
  shapedStories,
  shapeIssues,
  storiesStage,
} from "../src/index.js";

/**
 * ADR 0191 review: the business analyst shapes the stories while a draft of them runs. The draft
 * read the shaping and the numbers when it started; what it writes back keeps what the business
 * analyst recorded meanwhile (a shaping still waiting, and the number reserved for it), and the
 * shaping file is recorded where the stage loop keeps the files it wrote (the change folder).
 * The Forge fraud check (fixtures/stages/stories/).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/stages");
const STORIES_FIX = join(FIX, "stories");
const SPECS_CATALOG = join(HERE, "../../../fixtures/specs/catalog.yaml");
const NOW = new Date("2026-10-24T09:00:00Z");
const CHANGE = "add-fraud-check";
const fixture = (f: string) => readFileSync(join(STORIES_FIX, f), "utf8");

const records = (): CatalogRecord[] =>
  [
    ...(parse(readFileSync(SPECS_CATALOG, "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "catalog-extra.yaml"), "utf8")) as unknown[]),
    ...(parse(fixture("catalog-files.yaml")) as unknown[]),
  ].map((r) => {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    return p.record;
  });

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-shape-stage-"));
  await mkdir(join(dir, "org-pack"), { recursive: true });
  for (const r of records()) {
    const f = join(dir, "catalog/generated", recordPath(r));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(r));
  }
  for (const r of parse(readFileSync(join(FIX, "knowledge.yaml"), "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error("bad knowledge record");
    const f = join(dir, "knowledge/items", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "specs"), join(dir, "specs"), { recursive: true });
  await cp(join(FIX, "changes"), join(dir, "openspec/changes"), { recursive: true });
  return dir;
}

const respond = (draft: string) => (req: AiRequest) => {
  if (req.agent.id.endsWith("-critic")) return "findings: []";
  if (req.agent.id === EXPAND_AGENT)
    return "terms: [fraud screen, place order]\nnames:\n  - { name: Northwind Pay, id: northwind-pay, quote: screened by Northwind Pay }\n";
  return draft;
};

/** A runtime that runs `meanwhile` (once) before it answers the story writer: a person's step. */
class Meanwhile extends MockRuntime {
  private done = false;
  constructor(
    draft: string,
    private readonly meanwhile: () => Promise<void>,
  ) {
    super(respond(draft), { now: () => NOW });
  }
  protected override async produce(run: Parameters<MockRuntime["produce"]>[0]) {
    if (!this.done && run.request.agent.id.includes("stor")) {
      this.done = true;
      await this.meanwhile();
    }
    return super.produce(run);
  }
}

describe("a shaping recorded while the stories are drafted", () => {
  it("is kept, waiting, with its reserved number, and the shape file is the change folder's", async () => {
    const dir = await root();
    const folder = join(dir, "openspec/changes", CHANGE);
    expect(
      (
        await featureStage(dir, CHANGE, {
          runtime: new MockRuntime(respond(fixture("placed.yaml")), { now: () => NOW }),
          now: NOW,
        })
      ).state,
    ).toBe("done");
    expect(
      (
        await architectureStage(dir, CHANGE, {
          runtime: new MockRuntime(respond(fixture("deltas.yaml")), { now: () => NOW }),
          now: NOW,
        })
      ).state,
    ).toBe("done");
    const answer = fixture("answer.yaml");
    expect(
      (
        await storiesStage(dir, CHANGE, {
          runtime: new MockRuntime(respond(answer), { now: () => NOW }),
          now: NOW,
        })
      ).state,
    ).toBe("done");
    const first = (await readStoryNumbers(folder))!;
    const story = first.stories[0]!.id;
    await recordShape(
      folder,
      { op: "rename", story, name: "Screen the order for fraud" },
      { by: "bea", at: "2026-10-24T09:30:00Z" },
    );
    // The next draft starts; the business analyst adds a story while it runs.
    let added = "";
    const res = await storiesStage(dir, CHANGE, {
      runtime: new Meanwhile(answer, async () => {
        const r = await recordShape(
          folder,
          { op: "add", name: "Tell the customer", words: "a refused order says why" },
          { by: "bea", at: "2026-10-24T09:40:00Z" },
        );
        added = r.entry.added!;
      }),
      now: new Date("2026-10-24T10:00:00Z"),
      force: true,
    });
    expect(added).toMatch(/^s\d+-tell-the-customer$/);
    expect(res.answer).toBeDefined();
    const shape = await readShape(folder);
    expect(shape.entries.map((e) => [e.id, e.op, e.applied ?? "waiting"])).toEqual([
      ["sh-1", "rename", "2026-10-24T10:00:00.000Z"],
      ["sh-2", "add", "waiting"],
    ]);
    // The number the business analyst's story was given stays reserved, never given again.
    const numbers = (await readStoryNumbers(folder))!;
    expect(numbers.stories.map((s) => s.id)).toContain(added);
    // The stage loop keeps the shape file at its path in the change folder.
    const loop = parse(await readFile(join(folder, "stage/stories.yaml"), "utf8")) as {
      written: Record<string, string>;
    };
    expect(Object.keys(loop.written)).toContain("stage/stories-shape.yaml");
    expect(Object.keys(loop.written).filter((f) => f.startsWith("openspec/"))).toEqual([]);

    // The app's view of the shaping applies it once: the drafted stories already have it, so
    // applying it to them again gave the added story twice, and said twice it has no task.
    const twice = applyShape((await draftedStories(dir, CHANGE)).stories, shape);
    expect(twice.stories.filter((s) => s.id === added)).toHaveLength(2);
    const once = (await shapedStories(dir, CHANGE, shape))!;
    expect(once.stories.filter((s) => s.id === added)).toHaveLength(1);
    expect(new Set(once.stories.map((s) => s.id)).size).toBe(once.stories.length);
    expect(shapeIssues(once, shape)).toEqual([
      expect.stringContaining(`Story ${added} "Tell the customer" has no task yet`),
    ]);
  }, 60_000);
});
