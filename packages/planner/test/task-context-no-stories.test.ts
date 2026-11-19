import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { renderTaskContext, taskContext } from "../src/index.js";

/**
 * Beta.30, from a trial run: `atticus task context` said "read its story" of a task in a change
 * that has no stories (tasks written by hand, no target flows). It says what is there to read.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/stages");
const SPECS_CATALOG = join(HERE, "../../../fixtures/specs/catalog.yaml");
const CHANGE = "return-order-time";

async function estateWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-taskctx-nostories-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  for (const r of parse(readFileSync(SPECS_CATALOG, "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  const dir = join(root, "openspec/changes", CHANGE);
  await cp(join(FIX, "small", CHANGE), dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return root;
}

const TASKS = "# Tasks\n\n## forge-orders\n\n- [ ] 1.1 Return the time an order was placed\n";

describe("atticus task context, for a task the target flows don't give", () => {
  it("doesn't say to read a story when the change has none", async () => {
    const root = await estateWith({ "tasks.md": TASKS });
    try {
      const c = await taskContext(root, CHANGE, "1.1");
      expect(c.story).toBeUndefined();
      const note = c.notes.find((n) => n.startsWith("Task 1.1 isn't one the target flows give"));
      expect(note).toBe(
        `Task 1.1 isn't one the target flows give, so it has no step or cited code here, and ${CHANGE} has no stories: work from its line in tasks.md and the change's files in openspec/changes/return-order-time/.`,
      );
      expect(renderTaskContext(c)).not.toContain("read its story");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("says the task names no story when the change has stories of other tasks", async () => {
    const root = await estateWith({
      "tasks.md": TASKS,
      "stories/s2-cancel-order.md": "# Cancel an order\n\nAs a shopper I want to cancel.\n",
    });
    try {
      const c = await taskContext(root, CHANGE, "1.1");
      expect(c.notes).toContain(
        "Task 1.1 isn't one the target flows give, so it has no step or cited code here, and tasks.md names no story for it: work from its line in tasks.md and the change's files in openspec/changes/return-order-time/.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("names the story to read when the task has one", async () => {
    const root = await estateWith({
      "tasks.md": `${TASKS.trimEnd()} (story s1-place-order)\n`,
      "stories/s1-place-order.md":
        "# Show when an order was placed\n\nAs a shopper I want to see when my order was placed.\n",
    });
    try {
      const c = await taskContext(root, CHANGE, "1.1");
      expect(c.notes).toContain(
        "Task 1.1 isn't one the target flows give, so it has no step or cited code here; read its story (stories/s1-place-order.md).",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("says so when the task names a story that has no file", async () => {
    const root = await estateWith({ "tasks.md": `${TASKS.trimEnd()} (story s9-missing)\n` });
    try {
      const c = await taskContext(root, CHANGE, "1.1");
      expect(c.notes).toContain(
        "Task 1.1 isn't one the target flows give, so it has no step or cited code here, and its story s9-missing has no file under stories/: work from its line in tasks.md and the change's files in openspec/changes/return-order-time/.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
