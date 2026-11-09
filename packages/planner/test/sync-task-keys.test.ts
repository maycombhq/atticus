import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockWorkTracker } from "@maycombhq/adapters";
import { syncWorkItems } from "../src/index.js";
import { CHANGE, NOW, approval, changeDir, forgeChangeRoot } from "./helpers.js";

/**
 * Review round 48 (tasks and Git host): task ids repeat across repo sections of tasks.md (each
 * repo's tasks start at 1.1), so a repeated id is keyed and tagged by its repo too. An id used
 * once keeps its key, so work items synced before still match.
 */

const tasks = (bff: boolean) =>
  [
    "# Tasks",
    "",
    "## forge-ledger",
    "",
    "- [ ] 1.1 Add V3__add_daily_limit.sql",
    "- [ ] 1.2 Check the limit in the transfer transaction, with tests",
    ...(bff
      ? ["", "## forge-portal-bff", "", "- [ ] 1.1 Expose the remaining limit, with tests"]
      : []),
    "",
  ].join("\n");

const yes = (w: { key: string }) => approval("bao", NOW, w.key);

describe("work-tracker sync: task keys (review round 48)", () => {
  it("keys and tags a task id repeated across repos by its repo, and a unique one as before", async () => {
    const root = await forgeChangeRoot();
    await writeFile(join(changeDir(root), "tasks.md"), tasks(true));
    const wt = new MockWorkTracker();
    const dry = await syncWorkItems(root, CHANGE, { workTracker: wt, dryRun: true });
    expect(dry.writes.filter((w) => w.type === "task").map((w) => `${w.action} ${w.key}`)).toEqual([
      "create task:forge-ledger/1.1",
      "create task:1.2",
      "create task:forge-portal-bff/1.1",
    ]);
    const r = await syncWorkItems(root, CHANGE, { workTracker: wt, approve: yes, now: NOW });
    const ids = (k: string) => r.done.find((d) => d.key === k)!.id;
    const a = await wt.getItem(ids("task:forge-ledger/1.1"));
    const b = await wt.getItem(ids("task:forge-portal-bff/1.1"));
    expect(a.id).not.toBe(b.id);
    expect(a.tags).toContain(`atticus:${CHANGE}:task:forge-ledger/1.1`);
    expect(b.tags).toContain(`atticus:${CHANGE}:task:forge-portal-bff/1.1`);
    expect((await wt.getItem(ids("task:1.2"))).tags).toContain(`atticus:${CHANGE}:task:1.2`);
  });

  it("moves a work item synced under the shared key to its repo's key, and retags it", async () => {
    const root = await forgeChangeRoot();
    await writeFile(join(changeDir(root), "tasks.md"), tasks(false));
    const wt = new MockWorkTracker();
    const first = await syncWorkItems(root, CHANGE, { workTracker: wt, approve: yes, now: NOW });
    const old = first.done.find((d) => d.key === "task:1.1")!.id;
    // The portal's tasks are added later, also starting at 1.1.
    await writeFile(join(changeDir(root), "tasks.md"), tasks(true));
    const dry = await syncWorkItems(root, CHANGE, { workTracker: wt, dryRun: true });
    expect(
      dry.writes
        .filter((w) => w.type === "task" && w.action !== "unchanged")
        .map((w) => `${w.action} ${w.key}${w.id ? ` ${w.id}` : ""}`),
    ).toEqual([`update task:forge-ledger/1.1 ${old}`, "create task:forge-portal-bff/1.1"]);
    const r = await syncWorkItems(root, CHANGE, { workTracker: wt, approve: yes, now: NOW });
    expect(r.done.find((d) => d.key === "task:forge-ledger/1.1")).toEqual({
      key: "task:forge-ledger/1.1",
      action: "update",
      id: old,
    });
    expect((await wt.getItem(old)).tags).toContain(`atticus:${CHANGE}:task:forge-ledger/1.1`);
    const again = await syncWorkItems(root, CHANGE, { workTracker: wt, dryRun: true });
    expect(again.writes.every((w) => w.action === "unchanged")).toBe(true);
  });
});
