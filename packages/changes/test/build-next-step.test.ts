import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changeReport, changeStore, newChange } from "../src/index.js";
import { FEATURE_OWNERS, forgeMetarepo } from "./helpers.js";

/**
 * Seventh UX walk (finding 13): a change in build whose tasks are still open was "Ready to raise
 * "Raise PR"". What comes next says the tasks first; once every task is ticked it is ready.
 */

const ID = "add-transfer-limit";

async function inBuild(tasks: string) {
  const root = await forgeMetarepo();
  await newChange(root, {
    title: "Add transfer limit",
    type: "feature",
    by: "pat",
    owners: FEATURE_OWNERS,
    systems: ["portal", "ledger"],
    now: "2026-10-19T09:00:00Z",
  });
  const store = changeStore(root);
  const c = await store.read(ID);
  await store.write({
    ...c,
    state: "build",
    history: [...c.history, { from: "define", to: "build", at: "2026-10-19T11:00:00Z", by: "ari" }],
  });
  const dir = join(root, "openspec/changes", ID);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "tasks.md"), tasks);
  return root;
}

const TASKS = (a: string, b: string) =>
  `# Tasks\n\n## forge-ledger\n\n- [${a}] 1.1 Add the entry step\n- [${b}] 1.2 Add the lookup step\n`;

describe("what comes next for a change in build", () => {
  it("says the open tasks before the hand-off, never ready while one is open", async () => {
    const r = await changeReport(await inBuild(TASKS("x", " ")), ID);
    expect(r.blockers).toEqual([]);
    expect(r.nextStep).toBe(
      'Finish the build work (1 of 2 tasks ticked in tasks.md), then raise "Raise PR".',
    );
  });

  it("is ready to raise once every task is ticked", async () => {
    const r = await changeReport(await inBuild(TASKS("x", "x")), ID);
    expect(r.nextStep).toBe('Ready to raise "Raise PR".');
  });
});
