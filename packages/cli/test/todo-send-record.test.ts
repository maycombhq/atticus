import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileStepStore, ManualNotifier } from "@maycombhq/adapters";

/**
 * Beta.27 final fixes: an owner question's step marked done is a send on record, but putting it
 * on record can fail after the step is already done. Marking it done still succeeds, says the
 * send isn't on record and why, and the hand-off sync after it still runs.
 */

const synced: string[] = [];
vi.mock("../src/owner-questions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/owner-questions.js")>()),
  recordStepSend: async () => {
    throw new Error("catalog/curated/ownerquestion is not a folder");
  },
}));
vi.mock("../src/change-commands.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/change-commands.js")>()),
  syncAfterManualStep: async (_root: string, s: { id: string }) => {
    synced.push(s.id);
  },
}));
const { todoDone } = await import("../src/todo-commands.js");

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  synced.length = 0;
});

describe("todo done of an owner question's step whose send can't be put on record", () => {
  it("is marked done, says the send isn't on record and why, and still syncs", async () => {
    root = await mkdtemp(join(tmpdir(), "atticus-todo-send-record-"));
    const n = new ManualNotifier({ store: fileStepStore(root), now: () => "2026-11-12T09:00:00Z" });
    const { id } = await n.send(
      { channel: "@team-ledger", title: "A question for Ledger team", body: "Which limit?" },
      { by: "pat", at: "2026-11-12T09:00:00Z", ref: "owner-ask:q-limit" },
    );
    const step = id.replace(/^manual:/, "");
    const out: string[] = [];
    const err: string[] = [];
    const code = await todoDone(
      root,
      step,
      { by: "pat" },
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      { now: () => new Date("2026-11-12T10:00:00Z"), sync: {} },
    );
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual([
      `Recorded step ${step}.`,
      "The step is marked done, but the send couldn't be put on record: catalog/curated/ownerquestion is not a folder",
    ]);
    expect((await fileStepStore(root).get(step))?.state).toBe("done");
    expect(synced).toEqual([step]);
  });
});
