import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReplayRuntime } from "@maycombhq/ai";
import {
  ManualGitHost,
  createAdapters,
  fileStepStore,
  recordStep,
  type Adapters,
  type StepStore,
} from "@maycombhq/adapters";
import { archiveChange, changeStore, handoff, syncHandoff } from "@maycombhq/changes";
import { loadOrgPack } from "@maycombhq/core";
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

const REPO = "forge/forge-metarepo";

/** runtime.yaml with every outside system manual: Atticus with no integrations at all. */
const RUNTIME = `schemaVersion: 1
assistants: { allowed: [copilot, claude-code], default: copilot }
modes: { allowed: [hand-off, headless-claude-code], default: hand-off }
adapters:
  workTracker: { type: manual, settings: { idPattern: "\\\\d+" } }
  serviceDesk: { type: manual }
  gitHost: { type: manual, settings: { metarepo: ${REPO} } }
  wiki: { type: manual }
  notify: { type: manual }
  design: { type: manual }
`;

/** Do the open steps of one kind on a change, as the person would, with these values. */
async function doSteps(
  store: StepStore,
  action: string,
  by: string,
  values: (id: string) => Record<string, unknown>,
): Promise<string[]> {
  const open = await store.list({ change: CHANGE, action, state: "open" });
  for (const s of open) await recordStep(store, s.id, { by, at: NOW, values: values(s.id) });
  return open.map((s) => s.id);
}

let prNumber = 100;

/** A hand-off through the manual Git host: the person opens the PR, reports reviews, merges. */
async function walkPhase(
  root: string,
  a: Adapters,
  store: StepStore,
  o: { by: string; approvers: string[]; at: string },
): Promise<string> {
  const gitHost = a.gitHost!;
  const h = await handoff(root, CHANGE, {
    gitHost,
    by: o.by,
    approval: approval(o.by, o.at),
    now: o.at,
  });
  expect(h.pr.url).toMatch(/^manual:\/\/git-host\/forge\/forge-metarepo\/pull\/\d+$/);
  const before = await syncHandoff(root, CHANGE, {
    gitHost,
    approval: approval(o.approvers[0]!, o.at),
    now: o.at,
  });
  expect(before.merged).toBe(false);
  expect(before.reasons.map((r) => r.code)).toContain("approval-missing");

  const n = ++prNumber;
  expect(
    await doSteps(store, "open-pull-request", o.by, () => ({
      url: `https://git.example.com/${REPO}/pull/${n}`,
      number: n,
    })),
  ).toHaveLength(1);
  await doSteps(store, "report-pull-request", o.by, () => ({
    approvers: o.approvers.join(", "),
    checksPassing: "yes",
  }));
  // Approvals are checked on what was recorded; then merging is a step for a person.
  const ready = await syncHandoff(root, CHANGE, {
    gitHost,
    approval: approval(o.approvers[0]!, o.at),
    now: o.at,
  });
  expect(ready.merged).toBe(false);
  expect(ready.reasons).toEqual([
    expect.objectContaining({
      code: "host-refused",
      message: expect.stringContaining("a person merges PR"),
    }),
  ]);
  expect(await doSteps(store, "merge-pull-request", o.approvers[0]!, () => ({}))).toHaveLength(1);
  const merged = await syncHandoff(root, CHANGE, {
    gitHost,
    approval: approval(o.approvers[0]!, o.at),
    now: o.at,
  });
  expect(merged.merged).toBe(true);
  expect((await gitHost.getPullRequest(REPO, h.pr.number)).url).toBe(
    `https://git.example.com/${REPO}/pull/${n}`,
  );
  return merged.state;
}

describe("the forge change from Plan to Release with every outside system manual", () => {
  it("plans, syncs work items and requests as steps, and walks every hand-off by recorded results", async () => {
    const root = await forgeChangeRoot();
    await writeFile(join(root, "org-pack/runtime.yaml"), RUNTIME);
    const pack = await loadOrgPack(join(root, "org-pack"));
    expect(pack.problems).toEqual([]);
    const store = fileStepStore(root);
    const a = createAdapters(
      pack.runtime,
      {},
      { store, root, change: CHANGE, procedures: pack.procedures, now: () => NOW },
    );
    expect(a.gitHost).toBeInstanceOf(ManualGitHost);

    // ---- Plan: stories, tasks and drafts from the approved design.
    const runtime = await ReplayRuntime.fromDir(join(FORGE_CHANGE, "recordings"), {
      now: () => new Date(NOW),
    });
    await planStories(root, CHANGE, { runtime, now: new Date(NOW) });
    await snowDraft(root, CHANGE);
    const snow = join(changeDir(root), "snow.md");
    await writeFile(
      snow,
      (await read(snow))
        .replace("| Target |  |", "| Target | https://api.northwind.example |")
        .replace("| Destination host |  |", "| Destination host | api.northwind.example |"),
    );

    // Work items and service-desk requests become steps; the person records ids and numbers.
    const items = await syncWorkItems(root, CHANGE, {
      workTracker: a.workTracker!,
      approve: (w) => approval("bao", NOW, w.key),
      now: NOW,
    });
    expect(items.done.length).toBe(15);
    expect(items.done.every((d) => d.id.startsWith("manual:"))).toBe(true);
    let next = 4700;
    const created = await doSteps(store, "create-work-item", "bao", () => ({ id: String(++next) }));
    expect(created).toHaveLength(15);
    const requests = await submitRequests(root, CHANGE, {
      serviceDesk: a.serviceDesk!,
      approve: (w) => approval("dana", NOW, w.key),
      now: NOW,
    });
    expect(requests.done.map((d) => d.id)).toEqual([
      "manual:request-gateway-route",
      "manual:request-firewall-rule",
    ]);
    let sr = 40;
    await doSteps(store, "submit-request", "dana", () => ({ requestNumber: `SR-00${++sr}` }));
    await syncWorkItems(root, CHANGE, {
      workTracker: a.workTracker!,
      approve: () => undefined,
      now: NOW,
    });
    await submitRequests(root, CHANGE, {
      serviceDesk: a.serviceDesk!,
      approve: () => undefined,
      now: NOW,
    });
    const sync = await read(join(changeDir(root), "sync.yaml"));
    expect(sync).not.toContain("manual:");
    // The desk's progress is asked of a person.
    await a.serviceDesk!.getRequest("SR-0041");
    expect(
      await doSteps(store, "report-request-state", "dana", () => ({
        state: "done",
        closedAt: "2026-10-27",
      })),
    ).toEqual(["state-sr-0041"]);
    expect((await a.serviceDesk!.getRequest("SR-0041")).state).toBe("done");
    await a.notify!.send(
      {
        channel: "#forge-ledger",
        title: "Plan ready",
        body: "Stories and tasks for add-transfer-limit are ready.",
      },
      approval("bao", NOW, "notify"),
    );
    await doSteps(store, "send-notification", "bao", () => ({}));

    // ---- Plan → Build → QA → Release-ready → Released, every PR by hand.
    expect(
      await walkPhase(root, a, store, {
        by: "bao",
        approvers: ["tia"],
        at: "2026-10-20T10:00:00Z",
      }),
    ).toBe("build");
    expect(
      await walkPhase(root, a, store, {
        by: "dev",
        approvers: ["dee"],
        at: "2026-10-21T10:00:00Z",
      }),
    ).toBe("qa");
    expect(
      await walkPhase(root, a, store, {
        by: "quinn",
        approvers: ["quinn"],
        at: "2026-10-22T10:00:00Z",
      }),
    ).toBe("release-ready");
    expect(
      await walkPhase(root, a, store, {
        by: "tia",
        approvers: ["dana", "sam", "avery"],
        at: "2026-10-23T10:00:00Z",
      }),
    ).toBe("released");
    await archiveChange(root, CHANGE, { by: "dana", now: "2026-10-23T12:00:00Z" });

    const change = await changeStore(root).read(CHANGE);
    expect(change.state).toBe("archived");
    expect(change.history.map((h) => h.to)).toEqual([
      "define",
      "design",
      "plan",
      "build",
      "qa",
      "release-ready",
      "released",
      "archived",
    ]);
    expect(
      change.handoffs
        .filter((h) => h.state === "merged")
        .map((h) => [h.phase, h.approvals.map((x) => x.by)]),
    ).toEqual([
      ["define", ["pat"]],
      ["design", ["avery"]],
      ["plan", ["tia"]],
      ["build", ["dee"]],
      ["qa", ["quinn"]],
      ["release", ["avery", "dana", "sam"]],
    ]);
    // Every step is closed, lives in the change folder, and every write step carries its approval.
    const steps = await store.list({ change: CHANGE });
    expect(steps.filter((s) => s.state === "open").map((s) => s.id)).toEqual([]);
    const asks = new Set(["report-pull-request", "report-request-state"]);
    expect(steps.filter((s) => !asks.has(s.action) && !s.approval).map((s) => s.id)).toEqual([]);
    expect((await readdir(join(changeDir(root), "steps"))).length).toBe(steps.length);
  }, 120_000);
});
