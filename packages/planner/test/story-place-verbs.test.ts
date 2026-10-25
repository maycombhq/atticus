import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import {
  parseRecord,
  recordPath,
  serializeRecord,
  type CatalogRecord,
  type FlowRecord,
} from "@maycombhq/core";
import {
  declaresMethod,
  estateOf,
  FlowDelta,
  partsOf,
  placeIssues,
  renderStoryFile,
  renderTaskContext,
  SELF_CHECK_RULE,
  stepTasks,
  storiesFromDeltas,
  storySteps,
  taskContext,
  taskPrompt,
  type DeltaStory,
  type DeltaTask,
  type StoryWords,
} from "../src/index.js";

/**
 * Where code goes, with the right verb (ADR 0124 addendum B-place), on the order story
 * (fixtures/stages/stories-places/): a new service that calls an existing client and an existing
 * reader, a new page that uses a shared component, and two steps the existing client already
 * does. Under B-tasks the drafter's `before.yaml` came out as 8 tasks from 14 steps, every one
 * of them naming a wrong file (the reader, the text helper, the client, the shared quote list,
 * OrderController with no line, the web client for the page's states) and no step done.
 *
 * A. The architecture check knows three places: `at` (code that changes, path:line), `new` (a
 *    file the change creates, in a folder the repo has) and `uses` (code it only calls).
 * B. The stories say the verb ("change", "new file", "uses"), never "beside"; a new file's steps
 *    are one task; a step the existing client already does is a note, not a task.
 * C. The task context lists the task's own places, and the code it calls apart.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "stages", "stories-places");
const read = (f: string) => readFileSync(join(FIX, f), "utf8");
const recs = (rows: unknown[]): CatalogRecord[] =>
  rows.map((r) => {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    return p.record;
  });
const flows = () => recs(parse(read("flows.yaml")) as unknown[]) as FlowRecord[];
const estate = () =>
  estateOf(
    recs(parse(read("catalog.yaml")) as unknown[]),
    flows().map((flow) => ({ repo: flow.component, flow })),
  );
const deltas = (text: string) =>
  (parse(text) as { flows: unknown[] }).flows.map((d) =>
    FlowDelta.parse({ schemaVersion: 2, ...(d as object) }),
  );
/** A metarepo root with the repos' checkouts under workspace/. */
async function checkouts(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-place-"));
  await cp(join(FIX, "code"), join(root, "workspace"), { recursive: true });
  return root;
}

const SERVER = "forge-orders.order-story";
const WEB = "forge-web.order-story-page";
const O = "forge-orders:src/main/java/forge/orders";
const SERVICE = `${O}/OrderStoryService.java`;
const CONTROLLER = `${O}/OrderStoryController.java`;
const CLIENT = `${O}/ai/AssistantClient.java`;
const PAGE = "forge-web:src/orders/OrderStoryPage.tsx";

/** Where each step's code belongs, by flow and item: the reference a developer would give. */
const BELONGS: Record<string, Record<number, string | "done">> = {
  [SERVER]: {
    1: CONTROLLER,
    2: CONTROLLER,
    3: SERVICE,
    4: SERVICE,
    5: SERVICE,
    6: "done",
    7: SERVICE,
    8: "done",
    9: SERVICE,
    10: CONTROLLER,
  },
  [WEB]: { 1: PAGE, 2: "forge-web:src/api/orders.ts", 3: PAGE, 4: PAGE },
};
/** A step's place: the file a task tells the developer to change or create. */
const placeOf = (t: DeltaTask) => t.newFile ?? t.evidence[0]?.replace(/:\d+$/, "");
/** The tasks naming a file a step doesn't belong in, or no file at all. */
const wrong = (stories: DeltaStory[]) =>
  stories.flatMap((s) =>
    s.tasks.filter((t) => partsOf(t).some((p) => placeOf(p) !== BELONGS[s.flow]![p.position])),
  );

describe("A. the architecture check: at, new and uses", () => {
  it("refuses the B-tasks draft's places: a path:function at, at on code a step only calls", async () => {
    const e = estate();
    const got = (await placeIssues(deltas(read("before.yaml")), e, await checkouts())).map(
      (i) => `${i.target} ${i.rule}${i.blocking ? "" : " (note)"}`,
    );
    expect(got).toEqual([
      `${SERVER}#1:at delta.at-no-line`,
      `${SERVER}#2:at delta.no-place (note)`,
      `${SERVER}#3:at delta.at-calls`,
      `${SERVER}#4:at delta.at-shared (note)`,
      `${SERVER}#5:at delta.no-place (note)`,
      `${SERVER}#6:at delta.no-place (note)`,
      `${SERVER}#7:at delta.at-calls`,
      `${SERVER}#8:at delta.no-place (note)`,
      `${SERVER}#9:at delta.no-place (note)`,
      `${SERVER}#10:at delta.no-place (note)`,
      `${WEB}#1:at delta.no-place (note)`,
      `${WEB}#3:at delta.no-place (note)`,
      `${WEB}#4:at delta.at-shared (note)`,
    ]);
    const msg = (await placeIssues(deltas(read("before.yaml")), e, await checkouts())).find(
      (i) => i.target === `${SERVER}#3:at`,
    )!.message;
    expect(msg).toBe(
      "Change 3 to forge-orders.order-story puts the new read at src/main/java/forge/orders/OrderEventReader.java:18, which is a method forge-orders.order-story doesn't cite: a step that calls existing code doesn't change it, so write uses: src/main/java/forge/orders/OrderEventReader.java:18, and give the step's own code new: <path> for a file the change creates, or at: path:line in code that changes.",
    );
  });

  it("passes the draft with three places, a step the client already does needing none", async () => {
    expect(await placeIssues(deltas(read("deltas.yaml")), estate(), await checkouts())).toEqual([]);
  });

  it("checks each place on its own", async () => {
    const e = estate();
    const root = await checkouts();
    const one = (step: Record<string, unknown>) =>
      deltas(
        `flows:\n  - ${JSON.stringify({
          flow: SERVER,
          repo: "forge-orders",
          change: "new",
          name: "x",
          trigger: { kind: "endpoint", what: "x", entry: "GET /orders/{orderId}/story" },
          why: "x",
          steps: [{ op: "add", what: "x", ...step }],
        })}`,
      );
    const rules = async (step: Record<string, unknown>, checkout = true) =>
      (await placeIssues(one(step), e, checkout ? root : undefined)).map(
        (i) => `${i.rule}${i.blocking ? "" : " (note)"}`,
      );
    const J = "src/main/java/forge/orders";
    // at: a line of the file; the line of another flow's read is the code a read calls.
    expect(await rules({ kind: "transform", at: `${J}/OrderController.java:24` })).toEqual([]);
    expect(await rules({ kind: "read", at: `${J}/OrderEventReader.java:20` })).toEqual([
      "delta.at-calls",
    ]);
    expect(await rules({ kind: "read", at: `${J}/OrderEventReader.java` })).toEqual([
      "delta.at-no-line",
    ]);
    expect(
      await rules({ kind: "read", at: `${J}/X.java:1`, new: `${J}/OrderStoryService.java` }),
    ).toEqual(["delta.place-both"]);
    // new: a file the repo doesn't have, in a folder it has.
    expect(await rules({ kind: "transform", new: `${J}/story/OrderStory.java` })).toEqual([
      "delta.new-folder",
    ]);
    expect(await rules({ kind: "transform", new: `${J}/OrderController.java` })).toEqual([
      "delta.new-exists",
    ]);
    expect(await rules({ kind: "transform", new: "../forge-web/x.ts" })).toEqual([
      "delta.new-folder",
    ]);
    // Without a checkout, a folder the catalog cites is known, and one it doesn't is a note.
    expect(await rules({ kind: "transform", new: `${J}/OrderStoryService.java` }, false)).toEqual(
      [],
    );
    expect(await rules({ kind: "transform", new: `${J}/story/OrderStory.java` }, false)).toEqual([
      "delta.new-folder (note)",
    ]);
    // uses: a file and a line the repo has.
    expect(
      await rules({ kind: "transform", new: `${J}/S.java`, uses: [`${J}/text/Plain.java:9`] }),
    ).toEqual([]);
    expect(
      await rules({ kind: "transform", new: `${J}/S.java`, uses: `${J}/text/Plain.java:99` }),
    ).toEqual(["delta.uses-line"]);
    expect(
      await rules({ kind: "transform", new: `${J}/S.java`, uses: `${J}/text/Plain.java:tidy` }),
    ).toEqual(["delta.uses-no-line"]);
    expect(
      await rules({ kind: "transform", new: `${J}/S.java`, uses: `${J}/Nowhere.java:3` }),
    ).toEqual(["delta.uses-unknown"]);
  });

  it("tells a declaration from a call", () => {
    for (const l of [
      "  public List<OrderEvent> forOrder(long orderId) {",
      "  public static String tidy(String text) {",
      "export function QuoteList({ quotes, empty }: QuoteListProps) {",
      "def tidy(text):",
      "export const getStory = async (id: string): Promise<Story> => {",
      "  async load(id: string): Promise<void> {",
    ])
      expect([l, declaresMethod(l)]).toEqual([l, true]);
    for (const l of [
      "    return jdbc.query(BY_ORDER, OrderEvent.MAPPER, orderId);",
      "    boolean reserved = spend.reserve(requestId, maxCents);",
      "    spend.settle(requestId, done.costCents());",
      "    if (!reserved)",
      '  @GetMapping("/{orderId}")',
      "}",
    ])
      expect([l, declaresMethod(l)]).toEqual([l, false]);
  });
});

describe("B. stories say where code goes, with the verb", () => {
  const planned = () => storiesFromDeltas(deltas(read("deltas.yaml")), estate());
  const story = (stories: DeltaStory[], flow: string) => stories.find((s) => s.flow === flow)!;

  it("groups 14 steps into 4 tasks, none naming a wrong file; B-tasks named 8 of 8 wrong", () => {
    const stories = planned();
    const ids = (flow: string) =>
      story(stories, flow).tasks.map((t) => [t.id, partsOf(t).map((p) => p.position)]);
    // a new file's steps are one task, wherever they sit in the flow
    expect(ids(SERVER)).toEqual([
      ["1.1", [1, 2, 10]],
      ["1.3", [3, 4, 5, 7, 9]],
    ]);
    expect(ids(WEB)).toEqual([
      ["2.1", [1, 3, 4]],
      ["2.2", [2]],
    ]);
    expect(wrong(stories)).toEqual([]);
    // The drafter's B-tasks answer read now (the check refuses it, A): its places are still
    // wrong, but a step it places nowhere is new code whose place isn't given, never a
    // neighbour's file, so the web's call-out is a task of its own and the only right one.
    const before = storiesFromDeltas(deltas(read("before.yaml")), estate());
    expect(stepTasks(story(before, SERVER)).find((t) => t.position === 2)!.evidence).toEqual([]);
    expect([wrong(before).length, before.flatMap((s) => s.tasks).length]).toEqual([10, 11]);
  });

  it("notes the reserve and settle the client already does, under the task that calls it", () => {
    const t = story(planned(), SERVER).tasks[1]!;
    expect(t.done).toEqual([
      {
        id: "1.6",
        position: 6,
        kind: "write",
        what: "The spend is reserved before the call",
        fields: ["request_id", "reserved_cents"],
        by: `${CLIENT}:30`,
        flow: "forge-orders.draft-reply",
        step: 3,
      },
      {
        id: "1.8",
        position: 8,
        kind: "write",
        what: "The spend is settled with what the call cost",
        fields: ["request_id", "spent_cents"],
        by: `${CLIENT}:45`,
        flow: "forge-orders.draft-reply",
        step: 5,
      },
    ]);
    // The call is new code in the service that uses the client's method, which doesn't change.
    const call = partsOf(t).find((p) => p.position === 7)!;
    expect([call.placed, call.newFile, call.uses, call.evidence]).toEqual([
      "new",
      SERVICE,
      [`${CLIENT}:27`],
      [],
    ]);
  });

  it("a uses line no other step calls is the task that wires it, not a note", () => {
    const [d] = deltas(`flows:
  - flow: ${SERVER}
    repo: forge-orders
    change: new
    name: x
    trigger: { kind: endpoint, what: x, entry: "GET /orders/{orderId}/story" }
    why: x
    steps:
      - { op: add, kind: write, what: The spend is reserved, uses: src/main/java/forge/orders/ai/AssistantClient.java:30, store: { table: forge-orders-db.ai_spend, columns: [request_id, reserved_cents] } }
      - { op: add, kind: write, what: The spend is settled, uses: src/main/java/forge/orders/ai/AssistantClient.java:45, store: { table: forge-orders-db.ai_spend, columns: [request_id, spent_cents] } }
`);
    const s = storiesFromDeltas([d!], estate())[0]!;
    expect(s.tasks.map((t) => [t.id, (t.done ?? []).map((x) => x.position)])).toEqual([
      ["1.1", [2]],
    ]);
    expect(s.tasks[0]!.reuses).toEqual({
      flow: "forge-orders.draft-reply",
      step: 3,
      at: `${CLIENT}:30`,
    });
  });

  it("the story file and prompts say change, new file and uses; never beside", () => {
    const stories = planned();
    const s = story(stories, SERVER);
    const words: StoryWords = {
      id: s.id,
      title: "Read an order's story",
      asA: "shop owner",
      iWant: "to read an order's story",
      soThat: "I see what happened to it",
      tasks: s.tasks.map((t) => ({ id: t.id, criteria: [] })),
    } as unknown as StoryWords;
    const md = renderStoryFile("order-story", s, words);
    expect(md).not.toMatch(/new code beside|Where it goes: .*beside/i);
    expect(md).toContain(
      `- Where it goes: new file ${SERVICE} (uses ${O}/OrderEventReader.java:18): item 3`,
    );
    expect(md).toContain(`- Where it goes: new file ${SERVICE}: items 5 and 9`);
    expect(md).toContain(`- Files to touch: ${SERVICE} (new file)`);
    expect(md).toContain(
      `- Code it calls (unchanged): ${O}/OrderEventReader.java:18, ${O}/text/Plain.java:9, ${CLIENT}:27`,
    );
    expect(md).toContain(
      `already done by ${CLIENT}:30 (step 3 of forge-orders.draft-reply), no code`,
    );
    const prompt = taskPrompt("order-story", s, s.tasks[1]!, []);
    expect(prompt).toContain(
      `New file ${SERVICE}: the target flow puts the step's code there, in the repo's own layout.`,
    );
    expect(prompt).toContain(
      `It calls existing code, which doesn't change: ${O}/OrderEventReader.java:18 (item 3), ${O}/text/Plain.java:9 (item 4), ${CLIENT}:27 (item 7). Read it first.`,
    );
    const web = story(stories, WEB);
    const one = taskPrompt("order-story", web, web.tasks[1]!, []);
    expect(one).toContain(
      "Change forge-web:src/api/orders.ts:15: the target flow puts the step's code there.",
    );
    // The implementation steps: the new files and the one change, not the code they call.
    expect(storySteps(s).map((p) => [p.kind, p.file, p.newFile ?? false])).toEqual([
      ["new", CONTROLLER, true],
      ["new", SERVICE, true],
    ]);
  });

  it("a step with no place is new code whose place isn't given, never a neighbour's file", () => {
    const before = storiesFromDeltas(deltas(read("before.yaml")), estate());
    const s = story(before, SERVER);
    const words = {
      id: s.id,
      title: "x",
      asA: "shop owner",
      iWant: "x",
      soThat: "x",
      tasks: s.tasks.map((t) => ({ id: t.id, criteria: [] })),
    } as unknown as StoryWords;
    const md = renderStoryFile("order-story", s, words);
    expect(md).toContain("- Where it goes: new code — place not given");
    expect(md).not.toMatch(/new code beside|Where it goes: .*beside/i);
  });
});

describe("D. what the same run hit", () => {
  it("the self-check rule names no tool a hand-off doesn't have", () => {
    expect(SELF_CHECK_RULE).not.toContain("check_draft");
    expect(SELF_CHECK_RULE).toContain("the command the finishing step below gives");
  });
});

describe("C. the task context: the task's own places, and the code it calls apart", () => {
  it("lists the new file as the file to change and the reader, helper and client as code it calls", async () => {
    const root = await checkouts();
    await mkdir(join(root, "org-pack"), { recursive: true });
    for (const r of recs(parse(read("catalog.yaml")) as unknown[])) {
      const f = join(root, "catalog/generated", recordPath(r));
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, serializeRecord(r));
    }
    for (const f of flows()) {
      const p = join(root, "specs", f.component, `${f.id}.yaml`);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, serializeRecord(f));
    }
    const dir = join(root, "openspec/changes/order-story");
    await mkdir(join(dir, "target-flows"), { recursive: true });
    await writeFile(
      join(dir, "change.yaml"),
      [
        "schemaVersion: 1",
        "id: order-story",
        "title: An order's story",
        "type: feature",
        "template: feature",
        "state: plan",
        "createdAt: 2026-10-25T09:00:00Z",
        "createdBy: pat",
        "systems: [forge]",
        "history:",
        "  - { from: draft, to: plan, at: 2026-10-25T09:00:00Z, by: pat, reason: Created }",
        "",
      ].join("\n"),
    );
    for (const d of deltas(read("deltas.yaml")))
      await writeFile(join(dir, "target-flows", `${d.flow}.yaml`), stringify(d));
    await writeFile(
      join(dir, "tasks.md"),
      "# Tasks\n\n## forge-orders\n\n- [ ] 1.1 The controller\n- [ ] 1.3 The service\n",
    );
    const c = await taskContext(root, "order-story", "1.3");
    expect(c.notes.filter((n) => !n.includes("worktree"))).toEqual([
      `Step 6 (The spend is reserved before the call) is already done by existing code at ${CLIENT}:30 (step 3 of forge-orders.draft-reply): no change.`,
      `Step 8 (The spend is settled with what the call cost) is already done by existing code at ${CLIENT}:45 (step 5 of forge-orders.draft-reply): no change.`,
    ]);
    expect(c.files.map((f) => f.path)).toEqual([SERVICE]);
    expect(c.uses.map((u) => `${u.path}:${u.line}`)).toEqual([
      `${O}/OrderEventReader.java:18`,
      `${O}/text/Plain.java:9`,
      `${CLIENT}:27`,
    ]);
    const md = renderTaskContext(c);
    expect(md).toContain(
      `## Files likely to change\n\n- ${SERVICE}: the new file step 3's code goes in (new)\n`,
    );
    expect(md).toContain("## Code it calls");
    expect(md).toContain(`- ${O}/OrderEventReader.java:18: step 3 calls it`);
  });
});
