import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { attachToChange } from "@maycombhq/intake";
import { renderTaskContext, smallStage, taskContext } from "../src/index.js";

/** ADR 0113: the task's context, where the code is written, without pasting files into a chat. */
const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/stages");
const SPECS_CATALOG = join(HERE, "../../../fixtures/specs/catalog.yaml");
const NOW = new Date("2026-10-23T09:00:00Z");
const CHANGE = "return-order-time";

async function planned(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-taskctx-"));
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
  for (const r of parse(readFileSync(join(FIX, "small/knowledge.yaml"), "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad knowledge record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "knowledge/items", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "small", CHANGE), join(root, "openspec/changes", CHANGE), {
    recursive: true,
  });
  const answer = readFileSync(join(FIX, "small/answer.yaml"), "utf8");
  const runtime = new MockRuntime(
    (req: AiRequest) => (req.agent.id.endsWith("-critic") ? "findings: []" : answer),
    { now: () => NOW },
  );
  expect((await smallStage(root, CHANGE, { runtime, now: NOW })).state).toBe("done");
  return root;
}

describe("atticus task context", () => {
  it("gathers the task, its story and criteria, the step it implements with today's code, and the files to change", async () => {
    const root = await planned();
    await attachToChange(
      join(root, "openspec/changes", CHANGE),
      [
        {
          name: "checkout-note.md",
          bytes: new TextEncoder().encode("# Checkout\n\nShow HH:MM.\n"),
        },
      ],
      { by: "pat", at: "2026-10-23T08:00:00Z" },
    );
    const c = await taskContext(root, CHANGE, "1.1");
    expect(c.task).toMatchObject({
      id: "1.1",
      repo: "forge-orders",
      branch: "task/return-order-time/1.1",
      done: false,
    });
    expect(c.story).toMatchObject({ id: "s1-place-order", title: "Show when an order was placed" });
    expect(c.criteria).toEqual([
      "Given a new order, when it is placed, then the 201 response holds id, sku, quantity and createdAt",
    ]);
    expect(c.step).toMatchObject({
      op: "change",
      kind: "respond",
      fields: ["id", "sku", "quantity", "createdAt"],
      today: {
        number: 5,
        what: "201 Created with the saved order",
        cites: ["forge-orders:src/main/java/forge/orders/OrderController.java:14"],
      },
    });
    // Today's flow, numbered, with the step this task changes marked.
    expect(c.todaySteps.map((s) => [s.n, s.kind, !!s.this])).toEqual([
      [1, "entry", false],
      [2, "call-out", false],
      [3, "transform", false],
      [4, "write", false],
      [5, "respond", true],
    ]);
    // The file the step cites first. B-place: the task's own places only, never the flow's
    // other steps' files (the stock client the flow calls doesn't change).
    expect(c.files[0]).toEqual({
      path: "forge-orders:src/main/java/forge/orders/OrderController.java",
      line: 14,
      why: "today's respond step (step 5), which this task changes",
    });
    expect(c.files.map((f) => f.path)).not.toContain(
      "forge-orders:src/main/java/forge/orders/StockClient.java",
    );
    expect(c.uses).toEqual([]);
    expect(c.inputs).toEqual([
      {
        path: "openspec/changes/return-order-time/inputs/checkout-note.md",
        name: "checkout-note.md",
        kind: "document",
      },
    ]);
    expect(c.prompt).toContain(
      "Implement task 1.1 of the change return-order-time in the repo forge-orders.",
    );
    // The standard the context engine finds for a step that returns a time, marked unverified.
    expect(c.knowledge).toEqual([
      expect.objectContaining({ id: "api-times-utc", kind: "Pattern", verified: false }),
    ]);
  });

  it("renders it as Markdown for an assistant, everything read from the repo marked as data", async () => {
    const root = await planned();
    const md = renderTaskContext(await taskContext(root, CHANGE, "1.1"));
    expect(md).toBe(readFileSync(join(FIX, "small/expected/task-context.md"), "utf8"));
  });

  it("says which tasks there are when the task isn't one", async () => {
    const root = await planned();
    await expect(taskContext(root, CHANGE, "9.9")).rejects.toThrow(
      /There is no task 9\.9 in return-order-time's tasks\.md\. Tasks: 1\.1\./,
    );
  });
});
