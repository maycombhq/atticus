import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parseRecord, type CatalogRecord, type FlowRecord } from "@maycombhq/core";
import {
  checkStories,
  estateOf,
  foldAnswer,
  FlowDelta,
  knownFieldNames,
  partsOf,
  readTaskSteps,
  renderStoryFile,
  stepTasks,
  storiesFromDeltas,
  StoriesAnswerSchema,
  storySteps,
  taskPrompt,
  type DeltaStory,
} from "../src/index.js";

/**
 * Tasks a developer takes (ADR 0124 addendum B-tasks), on the order summary
 * (fixtures/stages/stories-units/): a one-page feature whose stories came out as 17 tasks, one per
 * target-flow step, 11 of the server's 12 placed in no file.
 *
 * A. Consecutive steps of a story that go into the same file are one task; a step that adds a
 *    table or columns is a task of its own (its migration lands first); a step existing code
 *    already does is a note under the task that wires the capability, not a task.
 * B. B-place: an added step goes where the target flow says, a new file (`new`) or code that
 *    changes (`at`); the code it only calls (`uses`) is no place. A step with no place is new
 *    code whose place isn't given, never beside a neighbour's code (B-tasks did that, and named
 *    code the step only calls as the file to change).
 * C. The story file says its context once, lists each criterion once and keeps today's flow
 *    behind a summary.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "stages", "stories-units");
const read = (f: string) => readFileSync(join(FIX, f), "utf8");
const recs = (rows: unknown[]): CatalogRecord[] =>
  rows.map((r) => {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    return p.record;
  });
const estate = () =>
  estateOf(
    recs(parse(read("catalog.yaml")) as unknown[]),
    recs(parse(read("flows.yaml")) as unknown[]).map((flow) => ({
      repo: (flow as FlowRecord).component,
      flow: flow as FlowRecord,
    })),
  );
const deltas = (text = read("deltas.yaml")) =>
  (parse(text) as { flows: unknown[] }).flows.map((d) =>
    FlowDelta.parse({ schemaVersion: 2, ...(d as object) }),
  );
const answer = () => StoriesAnswerSchema.parse(parse(read("answer.yaml")));
const planned = () => {
  const e = estate();
  const d = deltas();
  return { e, d, stories: storiesFromDeltas(d, e) };
};
const story = (stories: DeltaStory[], flow: string) => stories.find((s) => s.flow === flow)!;
const SERVER = "forge-orders.summarise-order";
const WEB = "forge-web.view-order";
const ROUTE = "forge-gateway.route-orders";
const READER = "forge-orders:src/main/java/forge/orders/OrderEventReader.java:18";
const CLIENT = "forge-orders:src/main/java/forge/orders/ai/AssistantClient.java";

describe("A. tasks are units of work a developer takes", () => {
  it("groups the order summary's 17 steps into 7 tasks, each listing the steps it covers", () => {
    const { stories } = planned();
    const ids = (flow: string) =>
      story(stories, flow).tasks.map((t) => [t.id, partsOf(t).map((p) => p.position)]);
    expect(ids(ROUTE)).toEqual([["1.1", [1, 2]]]);
    expect(ids(SERVER)).toEqual([
      // B-place: the new controller, the entry's handler and its answer, one task
      ["2.1", [1, 2, 12]],
      // lookup, read, prompt, reserve (wiring the existing client), drop, log: the new service
      ["2.3", [3, 4, 5, 6, 9, 11]],
      // a new table: its migration lands first, so it is a task of its own
      ["2.10", [10]],
    ]);
    expect(ids(WEB)).toEqual([
      ["3.1", [1, 2]],
      ["3.3", [3]],
    ]);
    // Each step keeps its own id, traceable to the step; the task takes its first step's.
    expect(partsOf(story(stories, SERVER).tasks[1]!).map((p) => p.id)).toEqual([
      "2.3",
      "2.4",
      "2.5",
      "2.6",
      "2.9",
      "2.11",
    ]);
    expect(stepTasks(story(stories, SERVER)).map((t) => t.id)).toEqual([
      "2.1",
      "2.2",
      "2.12",
      "2.3",
      "2.4",
      "2.5",
      "2.6",
      "2.9",
      "2.11",
      "2.10",
    ]);
  });

  it("a step the existing client already does is a note under the task that wires it, citing the code", () => {
    const { stories } = planned();
    const t = story(stories, SERVER).tasks.find((x) => x.id === "2.3")!;
    expect(t.done).toEqual([
      {
        id: "2.7",
        position: 7,
        kind: "call-out",
        what: "Northwind Models writes the summary",
        fields: ["prompt", "text", "citations"],
        by: `${CLIENT}:38`,
        flow: "forge-orders.draft-reply",
        step: 4,
      },
      {
        id: "2.8",
        position: 8,
        kind: "write",
        what: "The spend is settled with what the call cost",
        fields: ["request_id", "spent_cents"],
        by: `${CLIENT}:45`,
        flow: "forge-orders.draft-reply",
        step: 5,
      },
    ]);
    // The step that starts the run is the wiring: it calls the capability, and says whose it is.
    expect(partsOf(t).find((p) => p.position === 6)!.reuses).toEqual({
      flow: "forge-orders.draft-reply",
      step: 3,
      at: `${CLIENT}:31`,
    });
    // A done step's fields are no task's to check; its criteria still read.
    expect(t.fields).not.toContain("spent_cents");
  });

  it("a single step that matches an existing one is still a task: only a run's later steps are done", () => {
    const e = estate();
    const [d] = deltas(`flows:
  - flow: forge-orders.quick-summary
    repo: forge-orders
    change: new
    name: A quick summary
    trigger: { kind: endpoint, what: x, entry: "GET /orders/{orderId}/quick" }
    why: x
    steps:
      - { op: add, kind: entry, what: The controller reads the order id, fields: { reads: [orderId] } }
      - { op: add, kind: call-out, what: Northwind Models writes it, to: { component: northwind-models, entry: POST /v1/completions }, fields: { sends: [prompt], returns: [text] } }
      - { op: add, kind: respond, what: 200 with the text, fields: { returns: [text] } }
`);
    const s = storiesFromDeltas([d!], e)[0]!;
    expect(s.tasks.flatMap((t) => t.done ?? [])).toEqual([]);
    // B-place: the call names no place, so it has none: never the class it calls.
    const call = stepTasks(s).find((t) => t.kind === "call-out")!;
    expect([call.placed, call.evidence]).toEqual([undefined, []]);
  });

  it("the fraud check's call-out and branch in OrderController are one task; the write with its migration another", async () => {
    const { stories } = await fraud();
    expect(stories[0]!.tasks.map((t) => [t.id, partsOf(t).map((p) => p.id)])).toEqual([
      ["1.1", ["1.1", "1.2"]],
      ["1.3", ["1.3"]],
    ]);
  });

  it("an answer written per step reads per task: a step's criteria and tests go to the task covering it", () => {
    const { stories, d, e } = planned();
    const a = answer();
    const folded = foldAnswer(a, stories);
    const s2 = folded.stories.find((s) => s.id === "s2-summarise-order")!;
    expect(s2.tasks.map((t) => [t.id, t.criteria.length])).toEqual([
      ["2.1", 5],
      ["2.3", 12],
      ["2.10", 3],
    ]);
    // Folding is idempotent, and the checks read either form the same.
    expect(foldAnswer(folded, stories)).toEqual(folded);
    const blocking = (x: typeof a) =>
      checkStories(x, stories, d, [], {
        sections: true,
        known: knownFieldNames(e, d),
        estate: e,
      }).filter((i) => i.blocking);
    expect(blocking(a)).toEqual([]);
    expect(blocking(folded)).toEqual([]);
  });

  it("an also naming a step folds to its task, and a task's criteria never name itself", () => {
    const { stories } = planned();
    const a = answer();
    a.stories[1]!.tasks[0]!.criteria[0]!.also = ["2.2", "2.10"];
    const s2 = foldAnswer(a, stories).stories[1]!;
    expect(s2.tasks[0]!.criteria[0]!.also).toEqual(["2.10"]);
  });
});

describe("B. new code goes where the target flow says (B-place)", () => {
  const SERVICE = "forge-orders:src/main/java/forge/orders/OrderSummaryService.java";

  it("each step has its new file; the reader it uses is no place; a step with none is placed nowhere", () => {
    const { stories } = planned();
    const steps = stepTasks(story(stories, SERVER));
    const at = (n: number) => steps.find((t) => t.position === n)!;
    expect([at(4).placed, at(4).newFile, at(4).uses, at(4).evidence]).toEqual([
      "new",
      SERVICE,
      [READER],
      [],
    ]);
    // B-tasks' own draft: the read's `at` on the reader, every other step with no place. No step
    // is placed beside the reader any more: it says the place isn't given.
    const old = deltas().map((d) => ({
      ...d,
      steps: d.steps.map((s) => {
        const { new: _new, uses: _uses, ...rest } = s;
        return s.uses
          ? { ...rest, at: "src/main/java/forge/orders/OrderEventReader.java:18" }
          : rest;
      }),
    }));
    const before = stepTasks(story(storiesFromDeltas(old, estate()), SERVER));
    for (const n of [3, 5, 6, 9, 10, 11])
      expect([n, before.find((t) => t.position === n)!.evidence]).toEqual([n, []]);
  });

  it("says new file and uses in the story file, the task's prompt and the implementation steps", () => {
    const { stories } = planned();
    const s = story(stories, SERVER);
    const t = s.tasks.find((x) => x.id === "2.3")!;
    expect(taskPrompt("order-summary", s, t, [])).toContain(
      `It calls existing code, which doesn't change: ${READER} (item 4). Read it first.`,
    );
    const md = renderStoryFile("order-summary", s, foldAnswer(answer(), stories).stories[1]!);
    expect(md).toContain(`- Where it goes: new file ${SERVICE} (uses ${READER}): item 4`);
    expect(md).not.toContain("new code beside");
    // the new files are places; the reader they call isn't
    expect(
      storySteps(s)
        .filter((p) => p.kind === "new")
        .map((p) => [p.file, p.tasks]),
    ).toEqual([
      ["forge-orders:src/main/java/forge/orders/OrderSummaryController.java", ["2.1"]],
      [SERVICE, ["2.3"]],
      [SERVICE, ["2.10"]],
    ]);
    expect(storySteps(s).some((p) => p.file?.includes("OrderEventReader"))).toBe(false);
  });
});

describe("C. shorter story files", () => {
  it("the order summary's files are about 40% shorter, the server's about half, each criterion written once", () => {
    const { stories } = planned();
    const folded = foldAnswer(answer(), stories);
    let lines = 0;
    const each = new Map<string, number>();
    for (const s of stories) {
      const md = renderStoryFile(
        "order-summary",
        s,
        folded.stories.find((w) => w.id === s.id)!,
      );
      lines += md.split("\n").length;
      each.set(s.id, md.split("\n").length);
      // each criterion's words once in the file: under Acceptance criteria
      for (const w of folded.stories.find((x) => x.id === s.id)!.tasks)
        for (const c of w.criteria)
          expect([c.text, md.split(c.text).length - 1]).toEqual([c.text, 1]);
    }
    // Before B-tasks, the same answer rendered per step: 17 tasks and 788 lines (route 146,
    // server 460, web 182). Measured after: 7 tasks and 486 lines (109, 239, 138).
    expect(lines).toBeLessThanOrEqual(490);
    expect(each.get("s2-summarise-order")).toBeLessThanOrEqual(240);
  });

  it("today's flow is a summary with a link; each covered step and done note is a Step line conform reads", async () => {
    const { stories } = planned();
    const s = story(stories, SERVER);
    const md = renderStoryFile("order-summary", s, foldAnswer(answer(), stories).stories[1]!);
    expect(md).toContain(
      "- Step: add (call-out), item 7 of target-flows/forge-orders.summarise-order.yaml: Northwind Models writes the summary; already done by forge-orders:src/main/java/forge/orders/ai/AssistantClient.java:38 (step 4 of forge-orders.draft-reply), no code",
    );
    const dir = await mkdtemp(join(tmpdir(), "atticus-units-"));
    await mkdir(join(dir, "stories"));
    await writeFile(join(dir, "stories", `${s.id}.md`), md);
    const steps = await readTaskSteps(dir);
    expect([3, 4, 5, 6, 7, 8, 9, 11].map((n) => steps.get(`${SERVER}#${n}`))).toEqual(
      Array(8).fill("2.3"),
    );
    const web = story(stories, WEB);
    const webMd = renderStoryFile("order-summary", web, foldAnswer(answer(), stories).stories[2]!);
    expect(webMd).not.toContain("Today, flow");
    expect(webMd).toContain(
      "Today, forge-web.view-order (A shop owner views an order) has 3 steps and 1 error path; the change adds 2 steps and changes 1. The full flow, today's and once the change is in, is in target-flows/forge-web.view-order.yaml.",
    );
    // the error paths the change passes through stay: they are short and a developer needs them
    expect(webMd).toContain(
      "- GET /orders/{orderId} answers 404: the page says the order isn't found",
    );
  });
});

/** The fraud check, as the story files test plans it (fixtures/stages/stories). */
async function fraud() {
  const F = join(__dirname, "..", "..", "..", "fixtures");
  const rows = [
    ...(parse(readFileSync(join(F, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(F, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(F, "stages/stories/catalog-files.yaml"), "utf8")) as unknown[]),
  ];
  const flows = [
    "forge-orders/forge-orders.place-order.yaml",
    "forge-stock/forge-stock.reserve-stock.yaml",
  ].map((f) => ({
    repo: f.split("/")[0]!,
    flow: recs([parse(readFileSync(join(F, "stages/specs", f), "utf8"))])[0] as FlowRecord,
  }));
  const e = estateOf(recs(rows), flows);
  return {
    stories: storiesFromDeltas(
      deltas(readFileSync(join(F, "stages/stories/deltas.yaml"), "utf8")),
      e,
    ),
  };
}
