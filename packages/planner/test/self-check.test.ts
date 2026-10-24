import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { HandoffRuntime, MockRuntime, type AiRequest } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { loadChangeContext } from "@maycombhq/changes";
import {
  architectureStage,
  CHECK_DRAFT_TOOL,
  checkDeltas,
  checkStageDraft,
  draftCheckBox,
  EXPAND_AGENT,
  FlowDelta,
  formatDraftProblems,
  loadEstate,
  stageOfOutput,
  type FeaturePlacement,
} from "../src/index.js";

/**
 * A second live change (2026-10-24): in 20 runs over two real changes, neither reached stories
 * without a person who could read the planner's code. The checks were right; the drafter couldn't
 * meet them, and each failure cost a whole draft. W3a: the drafter checks its own draft with the
 * stage's checks before it hands it in. W3b: a returned field worked out from a column
 * (`edited` from `edited_at is not null`) says so (`fields.derived`).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures");
const PIN = join(FIX, "stages/pin-table");
const NOW = new Date("2026-10-24T09:00:00Z");
const CHANGE = "pin-order-note";
const LEVELS = ["public", "internal", "confidential", "restricted"];
const draft = (name: string) => readFileSync(join(PIN, "drafts", `${name}.yaml`), "utf8");

async function pinRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-self-check-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const rows = [
    ...(parse(readFileSync(join(FIX, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(PIN, "catalog.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(PIN, CHANGE), join(root, "openspec/changes", CHANGE), { recursive: true });
  return root;
}

const placement = (root: string) =>
  readFile(join(root, "openspec/changes", CHANGE, "feature.yaml"), "utf8").then(
    (t) => parse(t) as FeaturePlacement,
  );

describe("W3a: the drafter checks its own draft with the stage's checks", () => {
  it("checkStageDraft runs the stage's own checks on an answer's text, with nothing written", async () => {
    const root = await pinRoot();
    const problems = await checkStageDraft(root, CHANGE, "architecture", draft("sends-extra"));
    expect(problems.map((p) => p.rule)).toContain("delta.sent-not-stored");
    expect(problems.every((p) => p.blocking)).toBe(true);
    expect(await checkStageDraft(root, CHANGE, "architecture", draft("answered"))).toEqual([]);
    // Nothing was written: no target flows and no loop state.
    await expect(
      readFile(join(root, "openspec/changes", CHANGE, "stage/architecture.yaml"), "utf8"),
    ).rejects.toThrow();
  });

  it("says a problem with its line, in a few short lines a small model can act on", async () => {
    const root = await pinRoot();
    const text = formatDraftProblems(
      await checkStageDraft(root, CHANGE, "architecture", "flows: [ {\n"),
    );
    expect(text.split("\n")[0]).toBe("The stage's checks found 1 problem in your draft:");
    expect(text).toContain("- line ");
    expect(text.split("\n").at(-1)).toBe("Fix it in the file, then check again.");
    expect(formatDraftProblems([])).toBe(
      "The stage's checks find nothing to fix: hand the draft in.",
    );
  });

  it("the check_draft tool returns the problems, and stops after the self-check limit", async () => {
    const root = await pinRoot();
    const req = {
      change: CHANGE,
      outputPath: "architecture-answer.yaml",
      outputIn: "run",
      selfCheck: { command: `atticus stage check ${CHANGE} architecture`, limit: 2 },
    } as unknown as AiRequest;
    expect(stageOfOutput("architecture-answer.yaml")).toBe("architecture");
    const box = draftCheckBox(root, req)!;
    expect(box.definitions.map((d) => d.name)).toEqual([CHECK_DRAFT_TOOL]);
    const first = await box.call(CHECK_DRAFT_TOOL, { draft: draft("sends-extra") });
    expect(first).toContain(
      "sends pinnedAt to forge-orders-db.order_pin but stores it in no column",
    );
    expect(await box.call(CHECK_DRAFT_TOOL, { draft: draft("answered") })).toBe(
      "The stage's checks find nothing to fix: hand the draft in.",
    );
    expect(await box.call(CHECK_DRAFT_TOOL, { draft: draft("answered") })).toBe(
      "You have used the 2 checks a draft may have: hand your answer in as it is.",
    );
    // No box for a request that isn't a stage's draft.
    expect(
      draftCheckBox(root, { ...req, selfCheck: undefined } as unknown as AiRequest),
    ).toBeUndefined();
  });

  it("each draft's request asks for the self-check, and the drafter is told to use it", async () => {
    const root = await pinRoot();
    const reqs: AiRequest[] = [];
    const rt = new MockRuntime(
      (req: AiRequest) => {
        if (req.agent.id.endsWith("-critic")) return "findings: []";
        if (req.agent.id === EXPAND_AGENT) return "terms: []\nnames: []\n";
        reqs.push(req);
        return draft("answered");
      },
      { now: () => NOW },
    );
    await architectureStage(root, CHANGE, { runtime: rt, now: NOW });
    expect(reqs[0]!.selfCheck).toEqual({
      command: `atticus stage check ${CHANGE} architecture`,
      limit: 3,
    });
    expect(reqs[0]!.pack.prompt).toContain(
      "Check your answer with the stage's own checks before you hand it in",
    );
  });

  it("a hand-off draft whose check failed is still with the assistant, not drafted again", async () => {
    const root = await pinRoot();
    const tick = (() => {
      let t = NOW.getTime();
      return () => new Date((t += 5000));
    })();
    const rt = () => new HandoffRuntime({ root, validate: async () => ["a problem"], now: tick });
    const first = await architectureStage(root, CHANGE, {
      runtime: rt(),
      now: NOW,
      context: { engine: false },
    });
    expect(first.state).toBe("waiting");
    const run = first.waiting!.runId;
    await writeFile(join(root, ".runs", CHANGE, run, "architecture-answer.yaml"), "flows: []\n");
    await rt().done(run);
    const again = await architectureStage(root, CHANGE, {
      runtime: rt(),
      now: NOW,
      context: { engine: false },
    });
    expect(again.state).toBe("waiting");
    expect(again.waiting?.runId).toBe(run);
  });
});

describe("W3b: a returned field worked out from columns says so (fields.derived)", () => {
  /** place-order's response gains inStock, worked out from the quantity it stores. */
  const derived = (expression?: string) =>
    FlowDelta.parse({
      schemaVersion: 2,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "modify",
      why: "The reply says whether the order is in stock.",
      steps: [
        {
          op: "change",
          step: 5,
          kind: "respond",
          what: "201 Created with the saved order and whether it is in stock",
          fields: {
            returns: ["id", "sku", "quantity", "inStock"],
            ...(expression ? { derived: { inStock: expression } } : {}),
          },
        },
      ],
    });
  const PLACED = {
    schemaVersion: 1,
    change: CHANGE,
    entry: "brief",
    summary: "The reply says whether the order is in stock.",
    features: [],
    flows: [{ id: "forge-orders.place-order", how: "changed", why: "Its reply changes." }],
    newFlows: [],
    gaps: [],
    conflicts: [],
    questions: [],
  } as unknown as FeaturePlacement;
  const check = async (d: FlowDelta) => {
    const root = await pinRoot();
    const e = await loadEstate(root, (await loadChangeContext(root)).records);
    return checkDeltas([d], e, PLACED, [], { levels: LEVELS }).filter((i) => i.blocking);
  };

  it("without it, the field comes from nowhere; with it, the field is given", async () => {
    expect((await check(derived())).map((i) => i.rule)).toEqual(["delta.field-from-nowhere"]);
    expect(await check(derived("quantity > 0"))).toEqual([]);
  });

  it("the expression names columns the flow reads or the table has, as a fact", async () => {
    const got = await check(derived("stock_left > 0"));
    expect(got.map((i) => [i.rule, i.target])).toEqual([
      ["delta.derived-unknown-column", "forge-orders.place-order#1:inStock"],
    ]);
    expect(got[0]!.message).toBe(
      "Change 1 to forge-orders.place-order works out inStock from stock_left > 0, but stock_left is no column a step before it reads or writes, nor one of their tables' (created_at, id, quantity, sku). Name the columns it is worked out from.",
    );
  });

  it("the format shows it", async () => {
    const root = await pinRoot();
    const seen: string[] = [];
    const rt = new MockRuntime(
      (req: AiRequest) => {
        if (req.agent.id.endsWith("-critic")) return "findings: []";
        if (req.agent.id === EXPAND_AGENT) return "terms: []\nnames: []\n";
        seen.push(req.pack.prompt);
        return draft("answered");
      },
      { now: () => NOW },
    );
    await architectureStage(root, CHANGE, { runtime: rt, now: NOW });
    expect(seen[0]).toContain(
      'derived: { <a field worked out from columns>: "<how, e.g. edited_at is not null>" }',
    );
    // ADR 0125: an entry step lists the request fields it requires, so the check can say who breaks
    expect(seen[0]).toContain(
      "required: [<an entry step: the request fields it requires once the change is in>]",
    );
    void placement;
  });
});
