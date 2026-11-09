import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changeStore, newChange } from "../src/index.js";
import { forgeMetarepo } from "./helpers.js";

/**
 * Review round 46 (storage): one change.yaml cut short (or with a merge's conflict markers) is
 * one change the list can't read, not a list that fails: the app's changes, findings and record
 * pages stay up, and the bad file is named.
 */
describe("a change.yaml that doesn't read", () => {
  it("is skipped by list(), and listWithProblems() names it", async () => {
    const root = await forgeMetarepo();
    await newChange(root, {
      title: "Add transfer limit",
      type: "feature",
      by: "pat",
      now: "2026-11-08T09:00:00Z",
    });
    const bad = join(root, "openspec/changes/forge-add-refunds");
    await mkdir(bad, { recursive: true });
    await writeFile(join(bad, "change.yaml"), "id: forge-add-refunds\ntitle: [Add refu");
    const store = changeStore(root);
    expect((await store.list()).map((c) => c.id)).toEqual(["add-transfer-limit"]);
    const r = await store.listWithProblems();
    expect(r.changes.map((c) => c.id)).toEqual(["add-transfer-limit"]);
    expect(r.problems).toEqual([
      { file: join(bad, "change.yaml"), message: expect.stringMatching(/invalid YAML/) },
    ]);
    // Reading that one change still says what is wrong with it.
    await expect(store.read("forge-add-refunds")).rejects.toThrow(/invalid YAML/);
  });
});
