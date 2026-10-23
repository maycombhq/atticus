import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { HandoffRuntime, MockRuntime, type AiRequest } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { attachToChange } from "@maycombhq/intake";
import { smallStage } from "../src/index.js";

/** ADR 0113: a small change goes from brief to tasks in one AI step, every check still run. */
const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/stages");
const SPECS_CATALOG = join(HERE, "../../../fixtures/specs/catalog.yaml");
const NOW = new Date("2026-10-23T09:00:00Z");
const CHANGE = "return-order-time";
const ANSWER = readFileSync(join(FIX, "small/answer.yaml"), "utf8");

async function estateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-small-"));
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
  await cp(join(FIX, "small", CHANGE), join(root, "openspec/changes", CHANGE), {
    recursive: true,
  });
  return root;
}

const dir = (root: string, id = CHANGE) => join(root, "openspec/changes", id);

function assistant(drafts: string[], seen: AiRequest[] = []) {
  let n = 0;
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      seen.push(req);
      return drafts[Math.min(n++, drafts.length - 1)]!;
    },
    { now: () => NOW },
  );
}

describe("the fast path (atticus change small)", () => {
  it("places, draws the target flows and writes the stories and tasks from one answer", async () => {
    const root = await estateRoot();
    const seen: AiRequest[] = [];
    const r = await smallStage(root, CHANGE, { runtime: assistant([ANSWER], seen), now: NOW });
    expect(r.state).toBe("done");
    // One AI step: the drafter was asked once.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.agent.id).toBe("small-change-planner");
    expect(seen[0]!.pack.prompt).toContain("Return when an order was placed");
    // Today's flow went in with its steps numbered, so the step numbers can be checked.
    expect(seen[0]!.pack.prompt).toContain("flow forge-orders.place-order (repo forge-orders");
    // Every file the three stages write is there, so the checks and the change diagram work.
    const d = dir(root);
    expect(parse(await readFile(join(d, "feature.yaml"), "utf8"))).toMatchObject({
      change: CHANGE,
      flows: [{ id: "forge-orders.place-order", how: "changed" }],
    });
    expect(
      parse(await readFile(join(d, "target-flows/forge-orders.place-order.yaml"), "utf8")),
    ).toMatchObject({ change: "modify", steps: [{ op: "change", step: 5, kind: "respond" }] });
    expect(await readFile(join(d, "design.md"), "utf8")).toContain("forge-orders.place-order");
    expect(await readFile(join(d, "tasks.md"), "utf8")).toBe(
      readFileSync(join(FIX, "small/expected/tasks.md"), "utf8"),
    );
    const story = await readFile(join(d, "stories/s1-place-order.md"), "utf8");
    expect(story).toContain("# Show when an order was placed");
    expect(story).toContain("then the 201 response holds id, sku, quantity and createdAt");
    // The proposal is written from the summary, since nobody wrote one.
    expect(await readFile(join(d, "proposal.md"), "utf8")).toContain(
      "A new order's response says when the order was placed",
    );
    expect(r.files).toContain("tasks.md");
    // The critic ran at the small type's gate (plan), on the one draft.
    const loop = parse(await readFile(join(d, "stage/small.yaml"), "utf8"));
    expect(loop).toMatchObject({ stage: "small", state: "done", critic: [{ gate: "plan" }] });
    expect(r.pr).toBe(`atticus change handoff ${CHANGE} --approve`);
  });

  it("hands back what any of the three stages' checks finds, in the one step's words", async () => {
    const root = await estateRoot();
    const seen: AiRequest[] = [];
    // A wrong step number, and criteria that name none of the task's fields.
    const bad = ANSWER.replace("step: 5", "step: 9").replace(
      "then the 201 response holds id, sku, quantity and createdAt",
      "then it works",
    );
    const r = await smallStage(root, CHANGE, {
      runtime: assistant([bad, ANSWER], seen),
      now: NOW,
    });
    expect(r.state).toBe("done");
    expect(seen).toHaveLength(2);
    expect(seen[1]!.pack.prompt).toMatch(/step 9/);
  });

  it("reads the files attached to the change, cited by file and line", async () => {
    const root = await estateRoot();
    await attachToChange(
      dir(root),
      [
        {
          name: "checkout-note.md",
          bytes: new TextEncoder().encode("# Checkout\n\nShow the order time as HH:MM.\n"),
        },
      ],
      { by: "pat", at: "2026-10-23T08:00:00Z" },
    );
    const seen: AiRequest[] = [];
    await smallStage(root, CHANGE, { runtime: assistant([ANSWER], seen), now: NOW });
    expect(seen[0]!.pack.prompt).toContain("[checkout-note.md:3] Show the order time as HH:MM.");
    expect(seen[0]!.pack.prompt).toContain(`openspec/changes/${CHANGE}/inputs/checkout-note.md`);
  });

  it("refuses a change that isn't small, and says which path it takes", async () => {
    const root = await estateRoot();
    await expect(
      smallStage(root, "add-fraud-check", { runtime: assistant([ANSWER]), now: NOW }),
    ).rejects.toThrow(
      /add-fraud-check is a feature change: the feature, architecture and stories stages/,
    );
  });

  it("takes a brief that says it is small, on a type that allows it", async () => {
    const root = await estateRoot();
    const d = dir(root);
    const c = parse(await readFile(join(d, "change.yaml"), "utf8"));
    await writeFile(join(d, "change.yaml"), stringify({ ...c, type: "config-change" }));
    await writeFile(
      join(d, "brief.md"),
      "Size: standard\n\n" + (await readFile(join(d, "brief.md"), "utf8")),
    );
    await expect(
      smallStage(root, CHANGE, { runtime: assistant([ANSWER]), now: NOW }),
    ).rejects.toThrow(/the feature, architecture and stories stages/);
    await writeFile(join(d, "brief.md"), "# Return the time\n\nSize: small\n\nReturn createdAt.\n");
    const r = await smallStage(root, CHANGE, { runtime: assistant([ANSWER]), now: NOW });
    expect(r.state).toBe("done");
  });

  it("in hand-off mode, is one hand-off: the prompt, the answer, then done", async () => {
    const root = await estateRoot();
    const rt = () => new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    const first = await smallStage(root, CHANGE, { runtime: rt(), now: NOW });
    expect(first.state).toBe("waiting");
    const run = first.waiting!.runId;
    await writeFile(join(root, ".runs", CHANGE, run, "small-answer.yaml"), ANSWER);
    await rt().done(run);
    const done = await smallStage(root, CHANGE, { runtime: rt(), now: NOW, resume: run });
    expect(done.state).toBe("done");
    expect(done.drafts).toBe(1);
  });
});
