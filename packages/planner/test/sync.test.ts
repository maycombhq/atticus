import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ReplayRuntime } from "@maycombhq/ai";
import {
  ManualServiceDesk,
  ManualWorkTracker,
  MockServiceDesk,
  MockWorkTracker,
  fileStepStore,
  recordStep,
} from "@maycombhq/adapters";
import { planStories, snowDraft, submitRequests, syncWorkItems } from "../src/index.js";
import {
  CHANGE,
  FORGE_CHANGE,
  NOW,
  approval,
  changeDir,
  forgeChangeRoot,
  read,
} from "./helpers.js";

async function planned() {
  const root = await forgeChangeRoot();
  const runtime = await ReplayRuntime.fromDir(join(FORGE_CHANGE, "recordings"), {
    now: () => new Date(NOW),
  });
  await planStories(root, CHANGE, { runtime, now: new Date(NOW) });
  await snowDraft(root, CHANGE);
  return root;
}

describe("work-tracker sync", () => {
  it("shows a dry-run diff, writes with an approval per write, and creates nothing twice", async () => {
    const root = await planned();
    const wt = new MockWorkTracker();
    const dry = await syncWorkItems(root, CHANGE, { workTracker: wt, dryRun: true });
    expect(dry.writes.map((w) => `${w.action} ${w.key}`)).toEqual([
      "create feature",
      "create story:s1-daily-transfer-limit",
      "create story:s2-remaining-limit",
      "create story:s3-northwind-pay-velocity-checks",
      "create story:s4-audit-events",
      "create story:s5-limit-change",
      "create task:1.1",
      "create task:1.2",
      "create task:1.3",
      "create task:1.4",
      "create task:2.1",
      "create task:2.2",
      "create task:2.3",
      "create task:3.1",
      "create task:3.2",
    ]);
    expect(wt.journal).toEqual([]);

    // Only the feature and the first story are approved this time.
    const some = await syncWorkItems(root, CHANGE, {
      workTracker: wt,
      approve: (w) =>
        ["feature", "story:s1-daily-transfer-limit"].includes(w.key)
          ? approval("bao", NOW, w.key)
          : undefined,
      now: NOW,
    });
    expect(some.done).toEqual([
      { key: "feature", action: "create", id: "1000" },
      { key: "story:s1-daily-transfer-limit", action: "create", id: "1001" },
    ]);
    expect(some.skipped.length).toBe(13);
    expect(wt.journal.map((j) => [j.method, j.approval?.ref])).toEqual([
      ["createItem", "feature"],
      ["createItem", "story:s1-daily-transfer-limit"],
    ]);
    const story = await wt.getItem("1001");
    expect(story).toMatchObject({
      type: "story",
      title: "Refuse transfers over the daily limit",
      parent: "1000",
      description:
        "As a Portal customer I want transfers that would take me over my daily limit refused so that a stolen login can't drain my account in one day.",
    });
    expect(story.acceptanceCriteria.split("\n")).toHaveLength(2);

    const all = await syncWorkItems(root, CHANGE, {
      workTracker: wt,
      approve: (w) => approval("bao", NOW, w.key),
      now: NOW,
    });
    expect(all.done.length).toBe(13);
    expect((await wt.getItem(all.done.find((d) => d.key === "task:1.3")!.id)).parent).toBe(
      all.done.find((d) => d.key === "story:s3-northwind-pay-velocity-checks")!.id,
    );
    const again = await syncWorkItems(root, CHANGE, {
      workTracker: wt,
      approve: (w) => approval("bao", NOW, w.key),
      now: NOW,
    });
    expect(again.writes.every((w) => w.action === "unchanged")).toBe(true);
    expect(again.done).toEqual([]);
    const sync = parse(await read(join(changeDir(root), "sync.yaml")));
    expect(sync.workItems.length).toBe(15);

    // A reworded story is an update; a dropped one is reported, never deleted.
    const p = join(changeDir(root), "stories/s4-audit-events.md");
    const { writeFile, rm } = await import("node:fs/promises");
    await writeFile(
      p,
      (await read(p)).replace(
        "# Send refused transfers to Audit",
        "# Send every refused transfer to Audit",
      ),
    );
    await rm(join(changeDir(root), "stories/s5-limit-change.md"));
    const diff = await syncWorkItems(root, CHANGE, { workTracker: wt, dryRun: true });
    expect(
      diff.writes.filter((w) => w.action !== "unchanged").map((w) => `${w.action} ${w.key}`),
    ).toEqual([
      "update story:s4-audit-events",
      // Its story is gone, so the task moves up under the feature.
      "update task:1.4",
      "orphaned story:s5-limit-change",
    ]);
  });

  it("works through a manual work tracker: steps with provisional ids, resolved once recorded", async () => {
    const root = await planned();
    const store = fileStepStore(root);
    const wt = new ManualWorkTracker({ store, change: CHANGE, now: () => NOW });
    const r = await syncWorkItems(root, CHANGE, {
      workTracker: wt,
      approve: (w) =>
        w.key === "feature" || w.key.startsWith("story:s1")
          ? approval("bao", NOW, w.key)
          : undefined,
      now: NOW,
    });
    expect(r.done.map((d) => d.id)).toEqual([
      "manual:create-feature-add-a-daily-transfer-limit",
      "manual:create-story-refuse-transfers-over-the-daily-limit",
    ]);
    const story = (await store.get("create-story-refuse-transfers-over-the-daily-limit"))!;
    expect(story.change).toBe(CHANGE);
    expect(story.dependsOn).toEqual(["create-feature-add-a-daily-transfer-limit"]);
    await recordStep(store, "create-feature-add-a-daily-transfer-limit", {
      by: "bao",
      values: { id: "4711" },
    });
    await syncWorkItems(root, CHANGE, { workTracker: wt, dryRun: true });
    const sync = parse(await read(join(changeDir(root), "sync.yaml")));
    expect(sync.workItems.find((e: { key: string }) => e.key === "feature").id).toBe(
      "manual:create-feature-add-a-daily-transfer-limit",
    );
    // A real run resolves the provisional id it stored, and children name the real parent.
    const next = await syncWorkItems(root, CHANGE, {
      workTracker: wt,
      approve: (w) => (w.key.startsWith("story:s2") ? approval("bao", NOW, w.key) : undefined),
      now: NOW,
    });
    const after = parse(await read(join(changeDir(root), "sync.yaml")));
    expect(after.workItems.find((e: { key: string }) => e.key === "feature").id).toBe("4711");
    const s2 = (await store.get(next.done[0]!.id.slice("manual:".length)))!;
    expect(s2.fields.find((f) => f.name === "Parent")?.value).toBe("4711");
    expect(s2.dependsOn).toEqual([]);
  });
});

describe("service-desk requests from snow.md", () => {
  it("refuses drafts with empty required fields and files each request once", async () => {
    const root = await planned();
    const desk = new MockServiceDesk();
    const first = await submitRequests(root, CHANGE, {
      serviceDesk: desk,
      approve: (w) => approval("dana", NOW, w.key),
      now: NOW,
    });
    expect(first.failed).toEqual([
      { key: "gateway-route|gw-northwind-v2", reason: "fill Target in snow.md first" },
      { key: "firewall-rule|gw-northwind-v2", reason: "fill Destination host in snow.md first" },
    ]);
    const p = join(changeDir(root), "snow.md");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      p,
      (await read(p))
        .replace("| Target |  |", "| Target | https://api.northwind.example |")
        .replace("| Destination host |  |", "| Destination host | api.northwind.example |"),
    );
    const second = await submitRequests(root, CHANGE, {
      serviceDesk: desk,
      approve: (w) => approval("dana", NOW, w.key),
      now: NOW,
    });
    expect(second.done).toEqual([
      { key: "gateway-route|gw-northwind-v2", action: "create", id: "SR-0001" },
      { key: "firewall-rule|gw-northwind-v2", action: "create", id: "SR-0002" },
    ]);
    expect((await desk.getRequest("SR-0002")).fields).toEqual({
      "Source app": "gw-northwind-v2",
      "Destination host": "api.northwind.example",
      Port: "443",
      Protocol: "HTTPS",
      "Business justification":
        "ledger-api calls northwind-pay POST /v2/velocity-checks through gw-northwind-v2 for change add-transfer-limit (Add a daily transfer limit).",
    });
    const third = await submitRequests(root, CHANGE, {
      serviceDesk: desk,
      approve: (w) => approval("dana", NOW, w.key),
      now: NOW,
    });
    expect(third.done).toEqual([]);
    expect(third.writes.map((w) => w.action)).toEqual(["unchanged", "unchanged"]);

    // Through a manual desk the request is a step with every field ready to copy.
    const root2 = await planned();
    await writeFile(join(changeDir(root2), "snow.md"), await read(p));
    const store = fileStepStore(root2);
    const manual = new ManualServiceDesk({ store, now: () => NOW });
    const m = await submitRequests(root2, CHANGE, {
      serviceDesk: manual,
      approve: (w) => approval("dana", NOW, w.key),
      now: NOW,
    });
    expect(m.done.map((d) => d.id)).toEqual([
      "manual:request-gateway-route",
      "manual:request-firewall-rule",
    ]);
    expect((await store.get("request-firewall-rule"))!.fields.map((f) => f.name)).toEqual([
      "Request type",
      "Source app",
      "Destination host",
      "Port",
      "Protocol",
      "Business justification",
    ]);
  });
});
