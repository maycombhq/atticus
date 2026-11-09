import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import {
  parseRecord,
  recordPath,
  serializeRecord,
  type CatalogRecord,
  type FlowRecord,
} from "@maycombhq/core";
import { editSha } from "@maycombhq/changes";
import {
  checkStories,
  estateOf,
  findTask,
  FlowDelta,
  GENERATED_MARK,
  loadEstate,
  NUMBERS_FILE,
  numberedStories,
  readStoryNumbers,
  stepKeys,
  storiesFromDeltas,
  StoriesAnswerSchema,
  taskLabel,
  taskRunNotes,
  writeStories,
  type DeltaStory,
} from "../src/index.js";

/**
 * Review round 50: the stories and tasks keep their numbers from run to run. They are worked out
 * again from the target flows each time and were numbered afresh, so a repo the architecture
 * stage added (forge-gateway sorts before forge-orders) moved every story and task after it: a
 * task run under tasks/<label>/ belonged to another task, a story file a person edited was
 * replaced under a new name, and tasks.md's corrections and ticks keyed by label moved. Now a
 * story or task still there keeps its id and label, a new one gets the next free number, and a
 * removed one leaves a gap. Invented: the Forge order summary (fixtures/stages/stories-units/)
 * and fraud check (fixtures/stages/stories/).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures");
const UNITS = join(FIX, "stages/stories-units");
const STORIES = join(FIX, "stages/stories");
const NOW = new Date("2026-11-09T09:00:00Z");
const CHANGE = "add-fraud-check";

const recs = (rows: unknown[]): CatalogRecord[] =>
  rows.map((r) => {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    return p.record;
  });
const units = () => {
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
  return { e, deltas };
};
const rows = (stories: DeltaStory[]) =>
  stories.flatMap((s) => s.tasks.map((t) => [s.repo, s.id, taskLabel(s, t), t.id]));
const GATEWAY = "forge-gateway";

describe("a rerun keeps the numbers the stories and tasks had", () => {
  it("numbers a first draft as before: stories by repo, steps per repo, tasks per story without gaps", () => {
    const { e, deltas } = units();
    const r = numberedStories(deltas, e);
    expect(rows(r.stories)).toEqual(rows(storiesFromDeltas(deltas, e)));
    expect(rows(r.stories)).toEqual([
      ["forge-gateway", "s1-route-orders", "1.1", "1.1"],
      ["forge-orders", "s2-summarise-order", "2.1", "2.1"],
      ["forge-orders", "s2-summarise-order", "2.2", "2.3"],
      ["forge-orders", "s2-summarise-order", "2.3", "2.10"],
      ["forge-web", "s3-view-order", "3.1", "3.1"],
      ["forge-web", "s3-view-order", "3.2", "3.3"],
    ]);
    // no task of a first draft carries a label of its own: its place in the story is its label
    expect(r.stories.flatMap((s) => s.tasks).filter((t) => t.label)).toEqual([]);
  });

  it("the architecture stage adds forge-gateway: orders and web keep theirs, the gateway gets the next numbers", () => {
    const { e, deltas } = units();
    const first = numberedStories(
      deltas.filter((d) => d.repo !== GATEWAY),
      e,
    );
    expect(rows(first.stories)).toEqual([
      ["forge-orders", "s1-summarise-order", "1.1", "1.1"],
      ["forge-orders", "s1-summarise-order", "1.2", "1.3"],
      ["forge-orders", "s1-summarise-order", "1.3", "1.10"],
      ["forge-web", "s2-view-order", "2.1", "2.1"],
      ["forge-web", "s2-view-order", "2.2", "2.3"],
    ]);
    const again = numberedStories(deltas, e, first.numbers);
    expect(rows(again.stories)).toEqual([
      ...rows(first.stories),
      ["forge-gateway", "s3-route-orders", "3.1", "3.1"],
    ]);
    // without the kept numbers, every story and task after the gateway moved (the bug)
    expect(rows(storiesFromDeltas(deltas, e))[1]).toEqual([
      "forge-orders",
      "s2-summarise-order",
      "2.1",
      "2.1",
    ]);
    // the same numbers again: nothing changed, nothing moves
    expect(rows(numberedStories(deltas, e, again.numbers).stories)).toEqual(rows(again.stories));
  });

  it("a step reworded or moved is the same step; a removed task leaves a gap, never reused", () => {
    const { e, deltas } = units();
    const first = numberedStories(deltas, e);
    const web = deltas.find((d) => d.repo === "forge-web")!;
    // reworded: the same step, the same id and label
    const reworded = deltas.map((d) =>
      d !== web
        ? d
        : { ...d, steps: d.steps.map((s, i) => (i === 0 ? { ...s, what: "The page asks" } : s)) },
    );
    expect(rows(numberedStories(reworded, e, first.numbers).stories)).toEqual(rows(first.stories));
    // the web story's first task goes: 3.2 stays 3.2, and a step added after gets 3.3
    const gone = deltas.map((d) =>
      d !== web ? d : { ...d, steps: d.steps.filter((s) => s.op === "change") },
    );
    const second = numberedStories(gone, e, first.numbers);
    expect(rows(second.stories).filter((r) => r[0] === "forge-web")).toEqual([
      ["forge-web", "s3-view-order", "3.2", "3.3"],
    ]);
    const added = gone.map((d) =>
      d.repo !== "forge-web"
        ? d
        : {
            ...d,
            steps: [
              ...d.steps,
              {
                op: "add" as const,
                after: 3,
                kind: "log" as const,
                what: "The view is counted",
                new: "src/app/orders/view-counter.ts",
              },
            ],
          },
    );
    const third = numberedStories(added, e, second.numbers);
    const webRows = rows(third.stories).filter((r) => r[0] === "forge-web");
    expect(webRows.map((r) => r[2])).toEqual(["3.2", "3.3"]);
    // the new step's id is after every id the repo used, the removed ones' too (3.1, 3.2)
    expect(webRows[1]![3]).toBe("3.4");
    const s = third.stories.find((x) => x.repo === "forge-web")!;
    expect(taskLabel(s, s.tasks[0]!)).toBe("3.2");
    expect(findTask(third.stories, "3.2")?.t.id).toBe("3.3");
  });

  it("a step's identity: today's step it changes, or the kind, place, call or table it adds, and its ordinal", () => {
    const { deltas } = units();
    expect(stepKeys(deltas.find((d) => d.repo === GATEWAY)!)).toEqual([
      "forge-gateway forge-gateway.route-orders add validate after 2#1",
      "forge-gateway forge-gateway.route-orders change 3#1",
    ]);
  });

  it("a stage's message names a task by the label a person types, with its id", () => {
    const { e, deltas } = units();
    const stories = storiesFromDeltas(deltas, e);
    const answer = StoriesAnswerSchema.parse({
      stories: stories.map((s) => ({
        id: s.id,
        title: s.name,
        asA: "shop owner",
        iWant: s.name,
        soThat: "it works",
        tasks: [
          {
            id: s.tasks.at(-1)!.id,
            criteria: [{ text: "Given an order, when asked, then it answers", checks: [] }],
          },
        ],
      })),
    });
    const none = checkStories(answer, stories, deltas, []).filter(
      (i) => i.rule === "stories.no-criteria",
    );
    expect(none.map((i) => i.target)).toEqual(["2.1", "2.3", "3.1"]);
    // `atticus task 2.2` is the task the answer keys 2.3: the message says both
    expect(none.find((i) => i.target === "2.3")!.message).toMatch(
      /^Task 2\.2 \(id 2\.3\) \(Add the lookup step: .*\) has no acceptance criteria\.$/,
    );
    // a task whose label is its id is named as before
    expect(none.find((i) => i.target === "2.1")!.message).toMatch(/^Task 2\.1 \(Add the entry /);
  });
});

// ---------------------------------------------------------------- the files, the fraud check

async function fraudRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-stable-numbers-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const all = [
    ...(parse(readFileSync(join(FIX, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of recs(all)) {
    const f = join(root, "catalog/generated", recordPath(r));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(r));
  }
  await cp(join(FIX, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "stages/changes"), join(root, "openspec/changes"), { recursive: true });
  return root;
}

const fraudRecords = () =>
  recs([
    ...(parse(readFileSync(join(FIX, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
  ]);
const FRAUD = (parse(readFileSync(join(STORIES, "deltas.yaml"), "utf8")) as { flows: unknown[] })
  .flows;
/** A new flow in a repo that sorts before forge-orders: the architecture stage adds it. */
const AUDIT = {
  flow: "forge-audit.record-order",
  repo: "forge-audit",
  change: "new",
  name: "An order is recorded for audit",
  trigger: { kind: "listener", what: "An order is placed" },
  why: "Audit keeps every order placed.",
  steps: [
    {
      op: "add",
      kind: "write",
      what: "The order is recorded",
      new: "src/main/java/forge/audit/OrderRecorder.java",
    },
  ],
};
const deltasOf = (flows: unknown[]) =>
  flows.map((d) => FlowDelta.parse({ schemaVersion: 2, ...(d as object) }));

async function draft(root: string, flows: unknown[], notes: string[] = []) {
  const estate = await loadEstate(root, fraudRecords());
  const dir = join(root, "openspec/changes", CHANGE);
  const { stories, numbers } = numberedStories(
    deltasOf(flows),
    estate,
    await readStoryNumbers(dir),
  );
  const answer = StoriesAnswerSchema.parse(
    parse(readFileSync(join(STORIES, "answer.yaml"), "utf8")),
  );
  await writeStories(root, CHANGE, stories, answer, [], NOW, [], { estate, numbers, notes });
  return { dir, stories };
}

const taskLines = (md: string, repo: string) => {
  const at = md.split("\n");
  const from = at.indexOf(`## ${repo}`);
  const lines: string[] = [];
  for (const l of at.slice(from + 1)) {
    if (l.startsWith("## ")) break;
    if (l.startsWith("- [")) lines.push(l);
  }
  return lines;
};

describe("the story files and tasks.md keep their numbers", () => {
  it("a repo added before forge-orders: s1's file and its 1.x tasks stay, the new story is s2", async () => {
    const root = await fraudRoot();
    const { dir } = await draft(root, FRAUD);
    const before = await readFile(join(dir, "tasks.md"), "utf8");
    expect(await readdir(join(dir, "stories"))).toEqual(["s1-place-order.md"]);
    expect(await readStoryNumbers(dir)).toMatchObject({
      repos: { "forge-orders": 1 },
      stories: [{ repo: "forge-orders", flow: "forge-orders.place-order", id: "s1-place-order" }],
    });
    await draft(root, [AUDIT, ...FRAUD]);
    const after = await readFile(join(dir, "tasks.md"), "utf8");
    expect(taskLines(after, "forge-orders")).toEqual(taskLines(before, "forge-orders"));
    expect(taskLines(after, "forge-audit")).toEqual([
      "- [ ] 2.1 Add the write step: The order is recorded (story s2-record-order)",
    ]);
    expect((await readdir(join(dir, "stories"))).sort()).toEqual([
      "s1-place-order.md",
      "s2-record-order.md",
    ]);
    expect(await readFile(join(dir, NUMBERS_FILE), "utf8")).toMatch(/^# The numbers Atticus gave/);
  });

  it("a removed story's file a person edited is kept and said; one nobody edited goes", async () => {
    const root = await fraudRoot();
    await draft(root, FRAUD);
    const { dir } = await draft(root, [AUDIT, ...FRAUD]);
    const file = join(dir, "stories/s2-record-order.md");
    const text = await readFile(file, "utf8");
    expect(text.startsWith(GENERATED_MARK)).toBe(true);
    await mkdir(join(dir, "stage"), { recursive: true });
    await writeFile(
      join(dir, "stage/stories.yaml"),
      stringify({
        written: { "stories/s2-record-order.md": editSha("stories/s2-record-order.md", text) },
      }),
    );
    // nobody edited it: the story goes with its flow
    const notes: string[] = [];
    await draft(root, FRAUD, notes);
    expect(await readdir(join(dir, "stories"))).toEqual(["s1-place-order.md"]);
    expect(notes).toEqual([]);
    // a person edited it: it stays, and the stage says so
    await writeFile(file, `${text}\nThe auditors asked for the order's total too.\n`);
    await draft(root, FRAUD, notes);
    expect((await readdir(join(dir, "stories"))).sort()).toEqual([
      "s1-place-order.md",
      "s2-record-order.md",
    ]);
    expect(notes).toEqual([
      "stories/s2-record-order.md is a story the target flows no longer have, and a person edited it since Atticus wrote it, so it is kept: delete it once its words are no longer needed.",
    ]);
    // the removed story's number isn't reused: the audit flow back is s2 again, another flow s3
    await draft(root, [AUDIT, ...FRAUD]);
    expect((await readStoryNumbers(dir))!.stories.map((s) => s.id)).toEqual([
      "s1-place-order",
      "s2-record-order",
    ]);
  });

  it("a task run whose label now names another task is said, never silently reused", async () => {
    const root = await fraudRoot();
    const { dir } = await draft(root, FRAUD);
    await mkdir(join(dir, "tasks/1.1"), { recursive: true });
    await writeFile(
      join(dir, "tasks/1.1/task-run.yaml"),
      "schemaVersion: 1\nchange: add-fraud-check\ntask: '1.1'\nrepo: forge-orders\n",
    );
    const estate = await loadEstate(root, fraudRecords());
    // kept numbers: task 1.1 is the same task, nothing to say
    const kept = numberedStories(deltasOf([AUDIT, ...FRAUD]), estate, await readStoryNumbers(dir));
    expect(await taskRunNotes(dir, kept.stories)).toEqual([]);
    // a change drafted before the numbers were kept: numbered afresh, 1.1 is now the audit task
    await rm(join(dir, NUMBERS_FILE));
    const fresh = numberedStories(deltasOf([AUDIT, ...FRAUD]), estate, await readStoryNumbers(dir));
    expect(await taskRunNotes(dir, fresh.stories)).toEqual([
      "tasks/1.1/ has a task run for the task of story s1-place-order, but task 1.1 is now Add the write step: The order is recorded (story s1-record-order, forge-audit): the run isn't this task's. Check it before running task 1.1; nothing was moved.",
    ]);
  });
});
