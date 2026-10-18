import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Runtime } from "@maycombhq/core";
import {
  AdapterError,
  createAdapters,
  mergeBlockers,
  MockDesignTool,
  MockGitHost,
  MockNotifier,
  MockServiceDesk,
  MockWiki,
  MockWorkTracker,
  requireApproval,
} from "../src/index.js";

const TICKETS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/forge/inputs/tickets",
);
const ok = { by: "tom", at: "2026-10-18T05:00:00Z", ref: "handoff/add-transfer-limit/plan" };

describe("approvals", () => {
  it("refuses a write without a person's approval", () => {
    expect(() => requireApproval("x", undefined)).toThrow(/needs a person's approval/);
    expect(() => requireApproval("x", { by: "", at: ok.at, ref: "r" })).toThrow(AdapterError);
    expect(requireApproval("x", ok).scope).toBe("once");
  });

  it("allows standing approvals only where the adapter says so", () => {
    expect(() => requireApproval("x", { ...ok, scope: "standing" })).toThrow(/standing approval/);
    expect(requireApproval("x", { ...ok, scope: "standing" }, { allowStanding: true }).scope).toBe(
      "standing",
    );
  });
});

describe("work tracker mock", () => {
  const tracker = () =>
    MockWorkTracker.fromExport(JSON.parse(readFileSync(join(TICKETS, "ado-stories.json"), "utf8")));

  it("loads the fixture export and queries it", async () => {
    const t = tracker();
    expect((await t.getItem("102")).acceptanceCriteria).toBe("");
    expect((await t.query({ type: "story", text: "balance" })).map((i) => i.id)).toEqual(["101"]);
    await expect(t.getItem("999")).rejects.toMatchObject({ code: "not-found", retryable: false });
  });

  it("creates, updates and links items only with approval, and journals what it sent", async () => {
    const t = tracker();
    await expect(
      t.createItem({ type: "story", title: "x" }, undefined as never),
    ).rejects.toMatchObject({ code: "not-approved" });
    const story = await t.createItem(
      { type: "story", title: "Daily transfer limit", parent: "101", tags: ["atticus"] },
      ok,
    );
    expect(story).toMatchObject({ id: "1000", state: "New", parent: "101" });
    expect((await t.updateItem(story.id, { state: "Active" }, ok)).state).toBe("Active");
    await t.link(story.id, "102", "blocks", ok);
    expect(t.journal.filter((j) => j.approval).map((j) => j.method)).toEqual([
      "createItem",
      "updateItem",
      "link",
    ]);
    expect(t.journal.find((j) => j.method === "createItem")!.approval!.ref).toBe(ok.ref);
  });

  it("fails an injected call once, with retryable set for outages", async () => {
    const t = tracker();
    t.failNext("unavailable", "query");
    await expect(t.query({})).rejects.toMatchObject({ code: "unavailable", retryable: true });
    expect(await t.query({})).toHaveLength(2);
  });
});

describe("service desk mock", () => {
  const desk = () =>
    MockServiceDesk.fromExport(
      JSON.parse(readFileSync(join(TICKETS, "closed-service-requests.json"), "utf8")),
    );

  it("loads closed requests for lead-time history", async () => {
    const done = await desk().listRequests({ state: "done", type: "network-firewall-rule" });
    expect(done.map((r) => [r.id, r.openedAt, r.closedAt])).toEqual([
      ["SR-0001", "2026-03-02", "2026-03-16"],
      ["SR-0002", "2026-04-06", "2026-04-17"],
    ]);
  });

  it("submits a request only with approval and complete fields", async () => {
    const d = desk();
    const draft = {
      templateId: "firewall-rule",
      type: "network-firewall-rule",
      changeId: "add-transfer-limit",
      fields: { source: "ledger-api", port: 443 },
    };
    await expect(d.submitRequest(draft, { ...ok, scope: "standing" })).rejects.toMatchObject({
      code: "not-approved",
    });
    await expect(d.submitRequest({ ...draft, fields: { source: "" } }, ok)).rejects.toMatchObject({
      code: "invalid",
    });
    const r = await d.submitRequest(draft, ok);
    expect(r).toMatchObject({ id: "SR-0004", state: "submitted", changeId: "add-transfer-limit" });
    d.setState(r.id, "done", "2026-10-28");
    expect((await d.listRequests({ changeId: "add-transfer-limit" }))[0]!.state).toBe("done");
  });
});

describe("git host mock", () => {
  const host = () =>
    new MockGitHost([
      { repo: "forge/metarepo" },
      { repo: "forge/forge-ledger", defaultBranch: "main", protectedBranches: ["main", "release"] },
    ]);

  it("opens a PR from a change branch and refuses protected branches as the source", async () => {
    const h = host();
    const pr = await h.createPullRequest(
      {
        repo: "forge/forge-ledger",
        head: "change/add-transfer-limit",
        base: "main",
        title: "Limit",
        body: "b",
      },
      ok,
    );
    expect(pr).toMatchObject({ number: 1, state: "open" });
    await expect(
      h.createPullRequest(
        { repo: "forge/forge-ledger", head: "release", base: "main", title: "t", body: "b" },
        ok,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      h.createPullRequest(
        {
          repo: "forge/forge-ledger",
          head: "change/add-transfer-limit",
          base: "main",
          title: "t",
          body: "b",
        },
        ok,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("merges a hand-off PR only after code owners approve and checks pass", async () => {
    const h = host();
    const pr = await h.createPullRequest(
      {
        repo: "forge/metarepo",
        head: "handoff/add-transfer-limit/design",
        base: "main",
        title: "Design",
        body: "b",
      },
      ok,
    );
    h.requireReviewers("forge/metarepo", pr.number, ["architect-a", "architect-b"]);
    h.setChecks("forge/metarepo", pr.number, [{ name: "atticus-gates", status: "pending" }]);
    await expect(h.merge("forge/metarepo", pr.number, ok)).rejects.toThrow(
      /needs approval from architect-a or architect-b; checks not passing: atticus-gates pending/,
    );

    h.review("forge/metarepo", pr.number, "architect-b", "approved");
    h.setChecks("forge/metarepo", pr.number, [{ name: "atticus-gates", status: "passed" }]);
    expect((await h.merge("forge/metarepo", pr.number, ok)).state).toBe("merged");
  });

  it("lists every reason a PR can't merge", () => {
    const base = {
      repo: "r",
      number: 1,
      url: "u",
      title: "t",
      body: "b",
      head: "h",
      base: "main",
      reviews: [],
      checks: [],
      requiredReviewers: [],
    };
    expect(mergeBlockers({ ...base, state: "draft" })).toEqual([
      "the PR is a draft",
      "needs at least one approval",
    ]);
    expect(
      mergeBlockers({
        ...base,
        state: "open",
        reviews: [
          { by: "a", state: "approved" },
          { by: "b", state: "changes-requested" },
        ],
      }),
    ).toEqual(["changes are requested"]);
    // A later approval from the same reviewer replaces their earlier request for changes.
    expect(
      mergeBlockers({
        ...base,
        state: "open",
        reviews: [
          { by: "b", state: "changes-requested" },
          { by: "b", state: "approved" },
        ],
      }),
    ).toEqual([]);
  });
});

describe("read-only adapters and notifications", () => {
  it("the wiki mock has no write methods and searches page text", async () => {
    const w = new MockWiki([
      {
        id: "p1",
        space: "forge",
        title: "Integration patterns",
        body: "S.GW.VND requires the gateway",
        version: 3,
        updatedAt: "2026-09-01T00:00:00Z",
        url: "https://wiki.example.com/p1",
      },
    ]);
    expect((await w.search("gateway")).map((p) => p.id)).toEqual(["p1"]);
    expect("body" in (await w.listPages("forge"))[0]!).toBe(false);
    expect(
      Object.getOwnPropertyNames(MockWiki.prototype).filter((m) =>
        /create|update|delete|put|post/i.test(m),
      ),
    ).toEqual([]);
  });

  it("the design mock renders frames as PNG", async () => {
    const d = new MockDesignTool([
      {
        key: "f1",
        name: "Portal",
        pages: [{ id: "p", name: "Balance", frames: [{ id: "fr1", name: "Balance card" }] }],
      },
    ]);
    const png = await d.renderFrame("f1", "fr1");
    expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
    await expect(d.renderFrame("f1", "nope")).rejects.toMatchObject({ code: "not-found" });
  });

  it("notifications accept a standing approval and check the channel", async () => {
    const n = new MockNotifier(["forge-delivery"]);
    await n.send(
      {
        channel: "forge-delivery",
        title: "Commitment overdue",
        body: "Gateway route request is 2 days late",
      },
      { ...ok, scope: "standing" },
    );
    await expect(n.send({ channel: "random", title: "t", body: "b" }, ok)).rejects.toMatchObject({
      code: "invalid",
    });
    expect(n.sent).toHaveLength(1);
  });
});

describe("createAdapters", () => {
  const runtime = (adapters: object) =>
    Runtime.parse({
      schemaVersion: 1,
      assistants: { allowed: ["copilot"], default: "copilot" },
      adapters,
    });

  it("builds mocks from runtime.yaml and leaves unconfigured adapters out", () => {
    const a = createAdapters(runtime({ workTracker: { type: "mock" }, gitHost: { type: "mock" } }));
    expect(a.workTracker).toBeInstanceOf(MockWorkTracker);
    expect(a.gitHost).toBeInstanceOf(MockGitHost);
    expect(a.serviceDesk).toBeUndefined();
  });

  it("uses an installed factory and names what's missing otherwise", () => {
    const fake = new MockWorkTracker();
    const a = createAdapters(
      runtime({ workTracker: { type: "jira", settings: { project: "FORGE" } } }),
      { workTracker: { jira: (s) => (s.project === "FORGE" ? fake : new MockWorkTracker()) } },
    );
    expect(a.workTracker).toBe(fake);
    expect(() => createAdapters(runtime({ serviceDesk: { type: "servicenow" } }))).toThrow(
      /no servicenow adapter is installed/,
    );
  });
});
