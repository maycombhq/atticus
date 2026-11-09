import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, readQuestion, type FlowRecord } from "@maycombhq/core";
import {
  applyStroke,
  droppedQuestion,
  drawnStrokes,
  keepDroppedQuestion,
  namesIn,
  plannedComponents,
  plannedRepos,
  readStageLoop,
  renderDeploy,
  replyInStage,
  sketchOf,
  stageComments,
  Stroke,
  threadReplies,
  writeStageLoop,
  type FlowDelta,
} from "../src/index.js";
import { deployIssues } from "../src/stages/deploy-order.js";

/**
 * ADR 0188: a stage is one conversation. What the thread adds in the planner: a person's reply
 * (a question they answered, listed where the next round reads it), keeping a question that
 * couldn't be kept, the components a change plans, the retire stroke, and the names a hand-off
 * round seeds its selection with, without a model. On the invented Forge estate.
 */

const CHANGE = "add-gift-note";
const AT = "2026-11-09T10:00:00Z";

async function metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-thread-"));
  const dir = join(root, "openspec/changes", CHANGE);
  await mkdir(join(dir, "stage"), { recursive: true });
  await writeFile(join(dir, "change.yaml"), `id: ${CHANGE}\n`);
  await writeFile(join(dir, "brief.md"), "# Gift note\n\nA buyer adds a note.\nThird line.\n");
  return root;
}

async function ranStage(root: string, stage: "feature" | "architecture" = "feature") {
  const dir = join(root, "openspec/changes", CHANGE);
  const { loop } = await readStageLoop(dir, CHANGE, stage);
  await writeStageLoop(dir, { ...loop, iteration: 1, updatedAt: AT });
}

describe("a reply in the stage's thread", () => {
  it("is a question the person answered, listed in the loop file, not one of the stage's questions", async () => {
    const root = await metarepo();
    await ranStage(root);
    const r = await replyInStage(root, {
      change: CHANGE,
      stage: "feature",
      text: "Keep the note under 200 characters.",
      by: "priya",
      at: AT,
    });
    expect(r.question.state).toBe("answered");
    expect(r.question.answer?.text).toBe("Keep the note under 200 characters.");
    expect(r.files).toEqual([
      `questions/${r.question.id}.yaml`,
      `openspec/changes/${CHANGE}/stage/feature.yaml`,
    ]);
    const { loop } = await readStageLoop(join(root, "openspec/changes", CHANGE), CHANGE, "feature");
    expect(loop.questions).toContain(r.question.id);
    const replies = await threadReplies(root, CHANGE, "feature");
    expect(replies).toMatchObject([{ text: "Keep the note under 200 characters.", read: false }]);
    // The stage tab's questions leave it out: it is the thread's.
    expect((await stageComments(root, CHANGE, "feature")).others).not.toContain(r.question.id);
  });

  it("is refused before the stage has run: nothing would read it", async () => {
    const root = await metarepo();
    await expect(
      replyInStage(root, { change: CHANGE, stage: "feature", text: "x", by: "priya", at: AT }),
    ).rejects.toThrow(/hasn't run yet/);
  });

  it("for the proposal, is listed in stage/proposal-thread.yaml", async () => {
    const root = await metarepo();
    const r = await replyInStage(root, {
      change: CHANGE,
      stage: "proposal",
      text: "Name the vendor Northwind Pay.",
      by: "priya",
      at: AT,
    });
    const file = parse(
      await readFile(join(root, "openspec/changes", CHANGE, "stage/proposal-thread.yaml"), "utf8"),
    ) as { replies: string[] };
    expect(file.replies).toEqual([r.question.id]);
    expect((await threadReplies(root, CHANGE, "proposal")).map((x) => x.text)).toEqual([
      "Name the vendor Northwind Pay.",
    ]);
  });
});

describe("a question that couldn't be kept", () => {
  it("is kept with the nearest line of the file it cited, or none", async () => {
    const root = await metarepo();
    const brief = `openspec/changes/${CHANGE}/brief.md`;
    const d = await droppedQuestion(root, "How long may a note be?", [`${brief}:31`], 1, AT);
    // The brief has 4 lines: line 31 is past its end, so its last line is the nearest.
    expect(d.nearest).toBe(`${brief}:4`);
    expect(d.key).toMatch(/^[0-9a-f]{12}$/);
    const none = await droppedQuestion(root, "Who signs it?", ["nowhere.md:3"], 1, AT);
    expect(none.nearest).toBeUndefined();
  });

  it("Keep it anyway raises it as the stage's open question and takes it off the dropped list", async () => {
    const root = await metarepo();
    await ranStage(root);
    const dir = join(root, "openspec/changes", CHANGE);
    const brief = `openspec/changes/${CHANGE}/brief.md`;
    const d = await droppedQuestion(root, "How long may a note be?", [`${brief}:31`], 1, AT);
    const { loop } = await readStageLoop(dir, CHANGE, "feature");
    await writeStageLoop(dir, { ...loop, dropped: [d] });
    const kept = await keepDroppedQuestion(root, {
      change: CHANGE,
      stage: "feature",
      key: d.key,
      by: "priya",
      at: AT,
    });
    expect(kept.question).toMatchObject({ state: "open", evidence: [`${brief}:4`] });
    expect((await readQuestion(root, kept.question.id))?.question).toBe("How long may a note be?");
    const after = (await readStageLoop(dir, CHANGE, "feature")).loop;
    expect(after.dropped).toBeUndefined();
    expect(after.questions).toContain(kept.question.id);
    await expect(
      keepDroppedQuestion(root, { change: CHANGE, stage: "feature", key: d.key, by: "p", at: AT }),
    ).rejects.toThrow(/no question it couldn't keep/);
  });
});

const ev = [{ source: "code", repo: "forge-orders", path: "src/Orders.java", line: 3 }];
const flow = (id: string, component: string): FlowRecord => {
  const r = parseRecord({
    kind: "Flow",
    schemaVersion: 2,
    id,
    component,
    name: `Flow ${id}`,
    template: "default@1",
    trigger: { kind: "endpoint", what: "POST /x is called", evidence: ev },
    steps: [{ kind: "entry", what: "It arrives", refs: [], evidence: ev }],
  });
  if (!r.ok || r.record.kind !== "Flow") throw new Error(JSON.stringify(r));
  return r.record;
};
const estate = {
  flows: [
    { repo: "forge-orders", flow: flow("forge-orders.place-order", "forge-orders") },
    { repo: "forge-legacy", flow: flow("forge-legacy.export", "forge-legacy") },
    { repo: "forge-legacy", flow: flow("forge-legacy.import", "forge-legacy") },
  ],
  ids: new Set([
    "forge-orders",
    "forge-legacy",
    "forge-orders.place-order",
    "forge-legacy.export",
    "forge-legacy.import",
  ]),
};

describe("the components a change plans", () => {
  const scheduler: FlowDelta = {
    schemaVersion: 2,
    flow: "forge-scheduler.run-reminders",
    repo: "forge-scheduler",
    change: "new",
    name: "Run reminders",
    trigger: { kind: "job", what: "Every hour" },
    why: "Drawn on the canvas by priya.",
    runsOn: { component: "forge-scheduler" },
    steps: [],
  };
  const calls: FlowDelta = {
    schemaVersion: 2,
    flow: "forge-orders.place-order",
    repo: "forge-orders",
    change: "modify",
    why: "Drawn on the canvas by priya.",
    steps: [
      {
        op: "add",
        kind: "call-out",
        what: "Asks for a reminder",
        to: { component: "forge-notify", entry: "POST /reminders", new: true },
      },
    ],
  };

  it("are the new boxes and the new targets the catalog doesn't have, and a component retired", () => {
    const retired = applyStroke(
      [scheduler, calls],
      Stroke.parse({ kind: "retire", component: "forge-legacy", why: "Replaced by the scheduler" }),
      estate,
      "priya",
      "abcd1234",
    );
    const planned = plannedComponents(retired.deltas, estate);
    expect([...planned.values()]).toEqual([
      { component: "forge-scheduler", action: "new", repo: "forge-scheduler" },
      { component: "forge-notify", action: "new", repo: "forge-notify" },
      { component: "forge-legacy", action: "retire", repo: "forge-legacy" },
    ]);
    expect([...plannedRepos(retired.deltas, estate)]).toEqual(["forge-scheduler", "forge-notify"]);
  });

  it("may be deployed: the deploy order names a planned repo, marked planned", () => {
    const e = { ...estate, records: [], byId: new Map(), flowById: new Map() } as never;
    const issues = deployIssues(
      [scheduler, calls],
      [{ repo: "forge-scheduler" }, { repo: "forge-orders" }],
      e,
    );
    expect(issues.filter((i) => i.rule === "delta.deploy-unknown-repo")).toEqual([]);
    expect(renderDeploy([{ repo: "forge-scheduler" }], new Set(["forge-scheduler"]))[2]).toBe(
      "1. forge-scheduler (planned in this change: no repo builds it yet).",
    );
    // A repo nothing plans is still refused.
    expect(
      deployIssues([calls], [{ repo: "forge-nowhere" }, { repo: "forge-orders" }], e).map(
        (i) => i.rule,
      ),
    ).toContain("delta.deploy-unknown-repo");
  });
});

describe("the retire stroke", () => {
  it("removes every flow of the component today, in one stroke that Undo takes back together", () => {
    const r = applyStroke(
      [],
      Stroke.parse({ kind: "retire", component: "forge-legacy", why: "Replaced" }),
      estate,
      "priya",
      "abcd1234",
    );
    expect(r.problem).toBeUndefined();
    expect(r.deltas.map((d) => [d.flow, d.change])).toEqual([
      ["forge-legacy.export", "remove"],
      ["forge-legacy.import", "remove"],
    ]);
    expect(drawnStrokes(r.deltas)).toEqual([
      { flow: "forge-legacy.export", index: 0, what: "retired forge-legacy", by: "priya" },
    ]);
    // The architecture stage keeps it as drawn.
    expect(sketchOf(r.deltas)).toHaveLength(2);
    const undone = applyStroke(
      r.deltas,
      Stroke.parse({ kind: "undo", flow: "forge-legacy.export", index: 0 }),
      estate,
      "priya",
    );
    expect(undone.deltas).toEqual([]);
    expect(undone.changed).toEqual(["forge-legacy.export", "forge-legacy.import"]);
  });

  it("says why it can't: a component with no flow today, or one the change already changes", () => {
    expect(
      applyStroke([], Stroke.parse({ kind: "retire", component: "forge-x", why: "y" }), estate, "p")
        .problem,
    ).toBe("forge-x isn't a component of today's map.");
    const changed: FlowDelta = {
      schemaVersion: 2,
      flow: "forge-legacy.export",
      repo: "forge-legacy",
      change: "modify",
      why: "w",
      steps: [],
    };
    expect(
      applyStroke(
        [changed],
        Stroke.parse({ kind: "retire", component: "forge-legacy", why: "y" }),
        estate,
        "p",
      ).problem,
    ).toMatch(/^forge-legacy.export is changed in this change already/);
  });
});

describe("a hand-off round's seeds, without a model", () => {
  it("are the estate's names and aliases the input uses as whole words", () => {
    const ix = {
      names: () => [
        { id: "forge-orders", kind: "Component", names: ["Orders service"] },
        { id: "northwind-pay", kind: "System", names: ["Northwind Pay"] },
        { id: "api", kind: "Component", names: [] },
      ],
    };
    const e = namesIn("The Orders service calls Northwind Pay's API for a refund.", ix);
    expect(e.names).toEqual([
      { name: "Orders service", id: "forge-orders", quote: "Orders service" },
      { name: "Northwind Pay", id: "northwind-pay", quote: "Northwind Pay" },
    ]);
    expect(e.terms).toEqual([]);
    expect(namesIn("forge-ordersx isn't it", ix).names).toEqual([]);
  });
});
