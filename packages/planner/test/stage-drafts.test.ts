import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import {
  addCorrection,
  CORRECTIONS_RULE,
  correctionsText,
  draftItems,
  draftItemText,
  draftProvenance,
  EXPAND_AGENT,
  featureStage,
  PlannerError,
  readCorrections,
  readDrafted,
  recordPersonSave,
  removeCorrection,
} from "../src/index.js";

/**
 * ADR 0181 (stage drafts): every stage draft says it was drafted by AI, with its run, until a
 * person saves it; a person's correction of an AI-drafted item is read by the stage's next run as
 * the person's word (and, with Apply to similar, applied to every item like it); and a stage with
 * no corrections sends exactly the prompt it sent before, so the recorded replays still match.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/stages");
const SPECS_CATALOG = join(HERE, "../../../fixtures/specs/catalog.yaml");
const NOW = new Date("2026-10-24T09:00:00Z");
const CHANGE = "add-fraud-check";
const REL = `openspec/changes/${CHANGE}`;
const PRIYA = "Priya Nair <priya@forge.example>";

async function estateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-stage-drafts-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const rows = [
    ...(parse(readFileSync(SPECS_CATALOG, "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  for (const r of parse(readFileSync(join(FIX, "knowledge.yaml"), "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad knowledge record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "knowledge/items", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "changes"), join(root, "openspec/changes"), { recursive: true });
  return root;
}

const EXPANSION = `terms: [fraud screen, place order, reserve stock]
names:
  - { name: Northwind Pay, id: northwind-pay, quote: screened by Northwind Pay }
`;

const PLACED = `summary: Every new order is screened by Northwind Pay before stock is reserved; a rejected order is refused.
features:
  - id: cap-ordering
    why: Placing an order is the feature that gains the screen.
flows:
  - id: forge-orders.place-order
    how: changed
    why: The screen runs between receiving the order and reserving stock.
  - id: forge-stock.reserve-stock
    how: read
    why: Reserving stock happens only after the screen passes.
gaps:
  - what: No call to Northwind Pay exists yet.
    why: The estate never talks to the fraud screen today.
`;

/** The draft after the person's correction: the gap and the flow it names both say the gateway. */
const CORRECTED = `summary: Every new order is screened by Northwind Pay through the Forge gateway before stock is reserved; a rejected order is refused.
features:
  - id: cap-ordering
    why: Placing an order is the feature that gains the screen.
flows:
  - id: forge-orders.place-order
    how: changed
    why: The screen runs between receiving the order and reserving stock, calling Northwind Pay through the Forge gateway.
  - id: forge-stock.reserve-stock
    how: read
    why: Reserving stock happens only after the screen passes.
gaps:
  - what: No route to Northwind Pay through the Forge gateway exists yet.
    why: The gateway has no route to the fraud screen today.
`;

function assistant(prompts: string[] = [], answer = PLACED) {
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === EXPAND_AGENT) return EXPANSION;
      prompts.push(req.pack.prompt);
      return answer;
    },
    { now: () => NOW },
  );
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("the items of a stage draft a person can correct", () => {
  it("are a Markdown file's sections, tasks.md's tasks and a target flow's steps", () => {
    const md = [
      "<!-- mark -->",
      "# Proposal: Screen orders",
      "",
      "## Why",
      "",
      "Stolen cards.",
      "",
      "## What Changes",
      "",
      "- Screen each order.",
      "",
      "### New Capabilities",
      "- `orders-screen`",
      "",
      "```",
      "## not a heading",
      "```",
      "## Why",
      "again",
    ].join("\n");
    expect(draftItems("proposal.md", md)).toEqual([
      { id: "why", label: "Why" },
      { id: "what-changes", label: "What Changes" },
      { id: "new-capabilities", label: "New Capabilities" },
      { id: "why-2", label: "Why" },
    ]);
    // A section runs to the next heading of its level or above, sub-sections included.
    expect(draftItemText("proposal.md", md, "what-changes")).toContain("orders-screen");
    expect(draftItemText("proposal.md", md, "why")).toBe("## Why\n\nStolen cards.");
    expect(draftItemText("proposal.md", md)).toBe(md);

    const tasks =
      "# Tasks\n\n- [ ] 1.1 Add the call-out step (story s1)\n- [x] 1.2 Refuse a rejected order\n";
    expect(draftItems("tasks.md", tasks)).toEqual([
      { id: "task-1.1", label: "1.1 Add the call-out step (story s1)" },
      { id: "task-1.2", label: "1.2 Refuse a rejected order" },
    ]);

    const flow = `schemaVersion: 2
flow: forge-orders.place-order
repo: forge-orders
change: modify
why: Screen each order.
steps:
  - op: add
    after: 1
    kind: call-out
    what: Northwind Pay screens the order
    to: { component: northwind-pay, entry: POST /v1/screenings, new: true }
  - op: change
    step: 3
    kind: write
    what: The order is saved with its verdict
    store: { table: orders, columns: [fraud_verdict] }
`;
    expect(draftItems("target-flows/forge-orders.place-order.yaml", flow)).toEqual([
      {
        id: "step-1",
        label: "Step 1 (add call-out): Northwind Pay screens the order",
        like: ["northwind-pay", "POST /v1/screenings"],
      },
      {
        id: "step-2",
        label: "Step 2 (change write): The order is saved with its verdict",
        like: ["orders"],
      },
    ]);
    expect(draftItems("target-flows/x.yaml", "not: [valid")).toEqual([]);
    expect(draftItems("needs.yaml", "a: 1")).toEqual([]);
  });
});

describe("who drafted a stage file (stage/drafted.yaml)", () => {
  it("is the AI, with the stage and the run, until a person saves it; then that person", async () => {
    const root = await estateRoot();
    const dir = join(root, REL);
    const done = await featureStage(root, CHANGE, { runtime: assistant(), now: NOW });
    expect(done.state).toBe("done");
    const run = done.runs.at(-1)!.runId;
    const d = await readDrafted(dir, CHANGE);
    for (const f of ["feature.yaml", "feature.md", "proposal.md"])
      expect(d.files[f]).toMatchObject({ by: "ai", stage: "feature", run, iteration: 1 });
    const files = ["feature.yaml", "feature.md", "proposal.md", "design.md"];
    expect(await draftProvenance(dir, CHANGE, files)).toEqual({
      "feature.yaml": { by: "ai", stage: "feature", run, at: "2026-10-24T09:00:00Z" },
      "feature.md": { by: "ai", stage: "feature", run, at: "2026-10-24T09:00:00Z" },
      "proposal.md": { by: "ai", stage: "feature", run, at: "2026-10-24T09:00:00Z" },
    });
    // A person's save in the app says who and when.
    const mine = `${await readFile(join(dir, "proposal.md"), "utf8")}\nOne more line.\n`;
    await writeFile(join(dir, "proposal.md"), mine);
    await recordPersonSave(dir, CHANGE, {
      file: "proposal.md",
      who: PRIYA,
      at: "2026-10-25T08:00:00Z",
      content: mine,
    });
    // An edit outside the app is a person's, with no name.
    await writeFile(join(dir, "feature.md"), "# Feature\n\nEdited by hand.\n");
    const p = await draftProvenance(dir, CHANGE, files);
    expect(p["proposal.md"]).toEqual({ by: "person", who: PRIYA, at: "2026-10-25T08:00:00Z" });
    expect(p["feature.md"]).toEqual({ by: "person" });
    expect(p["feature.yaml"]).toMatchObject({ by: "ai", run });
  });

  it("falls back to the loop file's hashes for a change drafted before drafted.yaml was kept", async () => {
    const root = await estateRoot();
    const dir = join(root, REL);
    await featureStage(root, CHANGE, { runtime: assistant(), now: NOW });
    await writeFile(join(dir, "stage/drafted.yaml"), "");
    const loop = parse(await readFile(join(dir, "stage/feature.yaml"), "utf8")) as {
      written: Record<string, string>;
    };
    const written = [{ stage: "feature" as const, hashes: loop.written }];
    // An empty drafted.yaml doesn't read: the loop's hashes still say who wrote what.
    await writeFile(join(dir, "stage/drafted.yaml"), "schemaVersion: 1\nchange: add-fraud-check\n");
    await writeFile(join(dir, "proposal.md"), "# By hand\n");
    const p = await draftProvenance(dir, CHANGE, ["feature.yaml", "proposal.md"], written);
    expect(p).toEqual({
      "feature.yaml": { by: "ai", stage: "feature" },
      "proposal.md": { by: "person" },
    });
  });
});

describe("a person's correction of an AI-drafted item (stage/corrections.yaml)", () => {
  it("is read by the stage's next run as the person's word, and marked applied with what it touched", async () => {
    const root = await estateRoot();
    const dir = join(root, REL);
    await featureStage(root, CHANGE, { runtime: assistant(), now: NOW });
    const c = await addCorrection(dir, CHANGE, {
      stage: "feature",
      file: "feature.md",
      item: "gaps",
      label: "Gaps",
      text: "  We reach Northwind Pay through the Forge gateway: the gap is the gateway's route.  ",
      similar: true,
      like: "Northwind Pay",
      by: PRIYA,
      at: "2026-10-24T10:00:00Z",
    });
    expect(c).toMatchObject({
      stage: "feature",
      state: "waiting",
      scope: "similar",
      like: "Northwind Pay",
      text: "We reach Northwind Pay through the Forge gateway: the gap is the gateway's route.",
    });
    const prompts: string[] = [];
    const again = await featureStage(root, CHANGE, {
      runtime: assistant(prompts, CORRECTED),
      now: NOW,
    });
    expect(again.state).toBe("done");
    expect(prompts).toHaveLength(1);
    // Atticus's instruction says what to do; the person's words go as data, in the hand-backs.
    expect(prompts[0]).toContain(CORRECTIONS_RULE);
    expect(prompts[0]).toContain(
      "Corrections a person made (the person's instruction; follow each one):",
    );
    expect(prompts[0]).toContain(
      `- feature.md, Gaps: "We reach Northwind Pay through the Forge gateway: the gap is the gateway's route." (${PRIYA}, 2026-10-24). Apply the same correction to every similar item (every other step, story, section or task naming Northwind Pay).`,
    );
    expect(prompts[0]).toContain("never overrides a fact verified from code");
    const [after] = await readCorrections(dir, CHANGE);
    expect(after).toMatchObject({
      id: c.id,
      state: "applied",
      run: again.runs.at(-1)!.runId,
      iteration: 2,
      appliedAt: "2026-10-24T09:00:00Z",
    });
    // The other items the draft changed that name Northwind Pay.
    expect(after!.touched).toEqual(
      expect.arrayContaining(["feature.md#touches", "proposal.md#what-changes"]),
    );
    expect(after!.touched).not.toContain("feature.md#gaps");
    // Nothing waits now: a third run with nothing new doesn't draft again.
    const third: string[] = [];
    expect((await featureStage(root, CHANGE, { runtime: assistant(third), now: NOW })).state).toBe(
      "done",
    );
    expect(third).toEqual([]);
  });

  it("is kept in later briefs, and one the draft didn't follow stays read, not applied", async () => {
    const root = await estateRoot();
    const dir = join(root, REL);
    await featureStage(root, CHANGE, { runtime: assistant(), now: NOW });
    await addCorrection(dir, CHANGE, {
      stage: "feature",
      file: "proposal.md",
      item: "why",
      label: "Why",
      text: "Say the shop loses stock to stolen cards.",
      similar: false,
      by: PRIYA,
      at: "2026-10-24T10:00:00Z",
    });
    // The draft comes back the same: the item didn't change.
    await featureStage(root, CHANGE, { runtime: assistant([], PLACED), now: NOW });
    const [c] = await readCorrections(dir, CHANGE);
    expect(c).toMatchObject({ state: "read", iteration: 2 });
    expect(c!.touched).toBeUndefined();
    // A later redraft still has it in its brief (a person's word stands, as an answer does).
    await addCorrection(dir, CHANGE, {
      stage: "feature",
      file: "feature.md",
      item: "gaps",
      label: "Gaps",
      text: "Name the gateway.",
      similar: false,
      by: PRIYA,
      at: "2026-10-24T11:00:00Z",
    });
    const prompts: string[] = [];
    await featureStage(root, CHANGE, { runtime: assistant(prompts, CORRECTED), now: NOW });
    expect(prompts[0]).toContain('- proposal.md, Why: "Say the shop loses stock to stolen cards."');
    expect(prompts[0]).toContain('- feature.md, Gaps: "Name the gateway."');
    const all = await readCorrections(dir, CHANGE);
    // Why comes from the brief, so the draft can't change it: it stays read, never applied.
    expect(all.map((x) => x.state)).toEqual(["read", "applied"]);
  });

  it("can be taken back while it waits, and not once a draft read it; an empty one is refused", async () => {
    const root = await estateRoot();
    const dir = join(root, REL);
    await featureStage(root, CHANGE, { runtime: assistant(), now: NOW });
    const empty = await addCorrection(dir, CHANGE, {
      stage: "feature",
      file: "proposal.md",
      label: "proposal.md",
      text: "   ",
      similar: true,
      by: PRIYA,
      at: "2026-10-24T10:00:00Z",
    }).catch((e: unknown) => e);
    expect((empty as PlannerError).code).toBe("invalid");
    const c = await addCorrection(dir, CHANGE, {
      stage: "feature",
      file: "proposal.md",
      label: "proposal.md",
      text: "Shorter, please.",
      similar: false,
      by: PRIYA,
      at: "2026-10-24T10:00:00Z",
    });
    expect(await removeCorrection(dir, CHANGE, c.id)).toBe(true);
    expect(await readCorrections(dir, CHANGE)).toEqual([]);
    expect(await removeCorrection(dir, CHANGE, c.id)).toBe(false);
    const d = await addCorrection(dir, CHANGE, {
      stage: "feature",
      file: "proposal.md",
      label: "proposal.md",
      text: "Shorter, please.",
      similar: false,
      by: PRIYA,
      at: "2026-10-24T10:01:00Z",
    });
    await featureStage(root, CHANGE, { runtime: assistant(), now: NOW });
    const refused = await removeCorrection(dir, CHANGE, d.id).catch((e: unknown) => e);
    expect((refused as PlannerError).code).toBe("refused");
  });

  it("lists nothing in the hand-backs when there are none", () => {
    expect(correctionsText([])).toBeUndefined();
  });
});

describe("a stage with no corrections", () => {
  // The feature stage's prompt for this fixture, as it was before ADR 0181 (recorded replays
  // are keyed by the prompt's hash, so it must not move by a byte).
  // ADR 0191: re-pinned when the format asked what each question asks (its asks line, one rule).
  const BEFORE = "5814ca67b56b439e185ab1a99c0fa468ed5757fa56e2f7e747540a13b45c88a5";

  it("sends exactly the prompt it sent before, with or without an empty corrections file", async () => {
    const first: string[] = [];
    const root = await estateRoot();
    await featureStage(root, CHANGE, { runtime: assistant(first), now: NOW });
    expect(sha(first[0]!)).toBe(BEFORE);
    // Corrections of another stage, or all taken back, change nothing.
    const other = await estateRoot();
    const dir = join(other, REL);
    await mkdir(join(dir, "stage"), { recursive: true });
    await writeFile(
      join(dir, "stage/corrections.yaml"),
      "schemaVersion: 1\nchange: add-fraud-check\ncorrections: []\n",
    );
    const second: string[] = [];
    await featureStage(other, CHANGE, { runtime: assistant(second), now: NOW });
    expect(second[0]).toBe(first[0]);
    expect(second[0]).not.toContain("Corrections a person made");
  });
});
