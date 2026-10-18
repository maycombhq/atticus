import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  AdapterError,
  ManualGitHost,
  ManualNotifier,
  ManualServiceDesk,
  ManualWiki,
  ManualWorkTracker,
  MockServiceDesk,
  StepError,
  allManual,
  checkValue,
  createAdapters,
  exportStep,
  fileStepStore,
  memoryStepStore,
  mergeBlockers,
  recordStep,
  type ServiceDesk,
} from "../src/index.js";

const A = (by = "pat", at = "2026-10-20T09:00:00Z", ref = "test") => ({ by, at, ref });
const now = () => "2026-10-20T09:00:00Z";

describe("manual steps: the store", () => {
  it("creates a step once per key, with unique readable ids", async () => {
    const store = memoryStepStore();
    const base = {
      system: "notify" as const,
      action: "send-notification",
      title: "Send it",
      where: "Messages",
      createdBy: "pat",
    };
    const a = await store.create({ ...base, slug: "Message to #forge", key: "k1" });
    const again = await store.create({ ...base, slug: "Message to #forge", key: "k1" });
    const b = await store.create({ ...base, slug: "Message to #forge", key: "k2" });
    expect([a.id, again.id, b.id]).toEqual([
      "message-to-forge",
      "message-to-forge",
      "message-to-forge-2",
    ]);
    expect((await store.list()).length).toBe(2);
  });

  it("writes canonical YAML in the change folder, or steps/ when no change owns it", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-steps-"));
    const store = fileStepStore(root);
    const s = await store.create({
      slug: "open-pr",
      key: "git-host|pr|x",
      system: "git-host",
      action: "open-pull-request",
      change: "add-transfer-limit",
      title: "Open a pull request",
      where: "Git host",
      createdBy: "pat",
      createdAt: "2026-10-20T09:00:00Z",
      result: [{ name: "url", label: "Pull request link", format: "url" }],
    });
    const text = await readFile(
      join(root, "openspec/changes/add-transfer-limit/steps/open-pr.yaml"),
      "utf8",
    );
    expect(text).toBe(`schemaVersion: 1
id: open-pr
change: add-transfer-limit
system: git-host
action: open-pull-request
state: open
title: Open a pull request
where: Git host
key: git-host|pr|x
createdAt: 2026-10-20T09:00:00Z
createdBy: pat
dependsOn: []
fields: []
inputs: {}
instructions: []
result:
  - name: url
    label: Pull request link
    format: url
    required: true
runs: []
`);
    await store.create({
      slug: "open-pr",
      key: "other",
      system: "notify",
      action: "send-notification",
      title: "Send",
      where: "Messages",
      createdBy: "pat",
      createdAt: "2026-10-20T10:00:00Z",
    });
    expect((await store.list()).map((x) => x.id)).toEqual(["open-pr", "open-pr-2"]);
    expect(
      parse(await readFile(join(root, "steps/open-pr-2.yaml"), "utf8")).change,
    ).toBeUndefined();
    expect((await store.get(s.id))?.title).toBe("Open a pull request");
  });

  it("checks recorded values by format and refuses what isn't asked for", async () => {
    const f = (format: string, extra = {}) =>
      ({ name: "v", label: "Value", format, required: true, ...extra }) as never;
    expect(checkValue(f("url"), "https://git.example.com/forge/x/pull/7")).toEqual({
      ok: true,
      value: "https://git.example.com/forge/x/pull/7",
    });
    expect(checkValue(f("url"), "pull 7")).toEqual({
      ok: false,
      problem: "Value: pull 7 isn't a link",
    });
    expect(checkValue(f("integer"), "7")).toEqual({ ok: true, value: 7 });
    expect(checkValue(f("yes-no"), "Yes")).toEqual({ ok: true, value: true });
    expect(checkValue(f("handles"), "@tia, avery")).toEqual({ ok: true, value: ["tia", "avery"] });
    expect(checkValue(f("pattern", { pattern: "SR-\\d{4}" }), "SR-12")).toMatchObject({
      ok: false,
    });
    expect(checkValue(f("choice", { choices: ["done", "rejected"] }), "done")).toEqual({
      ok: true,
      value: "done",
    });
    expect(checkValue(f("date"), "21/10/2026")).toMatchObject({ ok: false });

    const store = memoryStepStore();
    const first = await store.create({
      slug: "first",
      key: "1",
      system: "work-tracker",
      action: "create-work-item",
      title: "Create",
      where: "Tracker",
      createdBy: "pat",
      result: [{ name: "id", label: "Work item id", format: "pattern", pattern: "\\d+" }],
    });
    const second = await store.create({
      slug: "second",
      key: "2",
      system: "work-tracker",
      action: "link-work-items",
      title: "Link",
      where: "Tracker",
      createdBy: "pat",
      dependsOn: [first.id],
    });
    await expect(recordStep(store, second.id, { by: "pat" })).rejects.toMatchObject({
      code: "refused",
      message: "Do step first first: step second depends on it.",
    });
    const bad = await recordStep(store, first.id, {
      by: "pat",
      values: { id: "abc", url: "x" },
    }).catch((e) => e);
    expect(bad).toBeInstanceOf(StepError);
    expect((bad as StepError).problems).toEqual([
      "url isn't asked for here (record id)",
      "Work item id: abc doesn't look right (expected \\d+)",
    ]);
    const done = await recordStep(store, first.id, {
      by: "@pat",
      at: now(),
      values: { id: "4711" },
    });
    expect(done.recorded).toMatchObject({ by: "pat", values: { id: "4711" }, via: "person" });
    await expect(
      recordStep(store, first.id, { by: "pat", values: { id: "1" } }),
    ).rejects.toMatchObject({
      code: "refused",
    });
    await expect(recordStep(store, second.id, { by: "pat", skip: true })).rejects.toMatchObject({
      code: "invalid",
    });
    expect(
      (await recordStep(store, second.id, { by: "pat", skip: true, note: "linked already" })).state,
    ).toBe("skipped");
  });
});

describe("manual work tracker", () => {
  it("turns creates into steps, hands out provisional ids and resolves them once recorded", async () => {
    const store = memoryStepStore();
    const wt = new ManualWorkTracker({ store, change: "add-transfer-limit", now }, async () => [
      {
        id: "101",
        type: "story",
        title: "As a customer I can see my available balance",
        description: "",
        acceptanceCriteria: "",
        state: "Closed",
        tags: [],
        url: "",
      },
    ]);
    await expect(
      wt.createItem({ type: "feature", title: "x" }, undefined as never),
    ).rejects.toMatchObject({
      code: "not-approved",
    });
    const feature = await wt.createItem(
      {
        type: "feature",
        title: "Add a daily transfer limit",
        tags: ["atticus:add-transfer-limit:feature"],
      },
      A(),
    );
    expect(feature.id).toBe("manual:create-feature-add-a-daily-transfer-limit");
    const story = await wt.createItem(
      {
        type: "story",
        title: "Refuse transfers over the daily limit",
        acceptanceCriteria: "Given …, when …, then …",
        parent: feature.id,
      },
      A(),
    );
    const step = (await store.get(story.id.slice("manual:".length)))!;
    expect(step.dependsOn).toEqual(["create-feature-add-a-daily-transfer-limit"]);
    expect(step.fields.find((f) => f.name === "Parent")?.value).toBe(
      "the id you record for step create-feature-add-a-daily-transfer-limit",
    );
    expect(exportStep(step, "import")).toEqual({
      format: "work-item-csv",
      fileName: "create-story-refuse-transfers-over-the-daily-limit.csv",
      text:
        "Work Item Type,Title,Description,Acceptance Criteria,Parent,Tags,Assigned To\n" +
        'User Story,Refuse transfers over the daily limit,,"Given …, when …, then …",the id you record for step create-feature-add-a-daily-transfer-limit,,\n',
    });
    await recordStep(store, "create-feature-add-a-daily-transfer-limit", {
      by: "bao",
      values: { id: "4711", url: "https://work.example.com/items/4711" },
    });
    expect(await wt.resolveId(feature.id)).toBe("4711");
    expect((await wt.getItem("4711")).title).toBe("Add a daily transfer limit");
    expect((await wt.getItem("101")).state).toBe("Closed");
    expect((await wt.query({ type: "story" })).map((i) => i.id)).toEqual([story.id, "101"]);
    await expect(wt.getItem("999")).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("manual service desk", () => {
  it("raises requests as steps and asks a person where an open request is", async () => {
    const store = memoryStepStore();
    const desk = new ManualServiceDesk({ store, now });
    const draft = {
      templateId: "gateway-route",
      type: "Gateway proxy deployment",
      changeId: "add-transfer-limit",
      fields: { "Proxy name": "gw-northwind-v2", "Base path": "/northwind/v2", Target: "" },
    };
    await expect(desk.submitRequest(draft, A("dana"))).rejects.toMatchObject({ code: "invalid" });
    const r = await desk.submitRequest(
      { ...draft, fields: { ...draft.fields, Target: "https://api.northwind.example" } },
      A("dana"),
    );
    expect(r).toMatchObject({
      id: "manual:request-gateway-route",
      state: "draft",
      changeId: "add-transfer-limit",
    });
    const step = (await store.get("request-gateway-route"))!;
    expect(step.inputs).toEqual({
      template: "gateway-route",
      requestType: "Gateway proxy deployment",
      proxyName: "gw-northwind-v2",
      basePath: "/northwind/v2",
      target: "https://api.northwind.example",
    });
    expect(exportStep(step, "text").text)
      .toBe(`Step request-gateway-route: Raise a "Gateway proxy deployment" request in the service desk
Where: Service desk: "Gateway proxy deployment" request

Steps:
1. Open a new "Gateway proxy deployment" request and copy the fields below.
2. Submit it and record the request number here.

Fields:
Request type: Gateway proxy deployment
Proxy name: gw-northwind-v2
Base path: /northwind/v2
Target: https://api.northwind.example

Record back:
- Request number: atticus todo done request-gateway-route --result requestNumber=…
- Link to the request (optional): atticus todo done request-gateway-route --result url=…
`);
    await recordStep(store, step.id, {
      by: "dana",
      at: "2026-10-21T10:00:00Z",
      values: { requestNumber: "SR-0042" },
    });
    const open = await desk.getRequest("SR-0042");
    expect(open).toMatchObject({ id: "SR-0042", state: "submitted", openedAt: "2026-10-21" });
    const ask = (await store.list({ action: "report-request-state" }))[0]!;
    expect(ask.title).toBe("Report where request SR-0042 is in the service desk");
    await desk.getRequest("SR-0042");
    expect((await store.list({ action: "report-request-state" })).length).toBe(1);
    await recordStep(store, ask.id, {
      by: "dana",
      values: { state: "done", closedAt: "2026-10-30" },
    });
    expect(await desk.getRequest("SR-0042")).toMatchObject({
      state: "done",
      closedAt: "2026-10-30",
    });
    expect((await desk.listRequests({ changeId: "add-transfer-limit" })).map((x) => x.id)).toEqual([
      "SR-0042",
    ]);
  });
});

describe("manual Git host", () => {
  const REPO = "forge/forge-metarepo";
  const pr = {
    repo: REPO,
    head: "handoff/add-transfer-limit/plan",
    base: "main",
    title: "Add a daily transfer limit: Plan ready",
    body: "## Hand-off",
  };

  it("opens PRs as steps, asks for reviews, and makes merging a step after the checks", async () => {
    const store = memoryStepStore();
    const gh = new ManualGitHost({ store, now });
    await expect(gh.createPullRequest({ ...pr, head: "main" }, A())).rejects.toMatchObject({
      code: "invalid",
    });
    const p = await gh.createPullRequest(pr, A("bao"));
    expect(p).toMatchObject({
      number: 1,
      state: "draft",
      url: "manual://git-host/forge/forge-metarepo/pull/1",
    });
    await expect(gh.createPullRequest(pr, A("bao"))).rejects.toMatchObject({ code: "conflict" });
    const steps = await store.list({ change: "add-transfer-limit" });
    expect(steps.map((s) => [s.id, s.action, s.dependsOn])).toEqual([
      ["open-pr-handoff-add-transfer-limit-plan", "open-pull-request", []],
      ["report-pr-1", "report-pull-request", ["open-pr-handoff-add-transfer-limit-plan"]],
    ]);
    await recordStep(store, steps[0]!.id, {
      by: "bao",
      values: { url: "https://git.example.com/forge/forge-metarepo/pull/12", number: "12" },
    });
    const opened = await gh.getPullRequest(REPO, 1);
    expect(opened).toMatchObject({
      state: "open",
      url: "https://git.example.com/forge/forge-metarepo/pull/12",
    });
    expect(mergeBlockers(opened)).toEqual(["needs at least one approval"]);
    await expect(gh.merge(REPO, 1, A("tia"))).rejects.toMatchObject({ code: "conflict" });

    await recordStep(store, "report-pr-1", {
      by: "bao",
      values: { approvers: "tia", checksPassing: "yes" },
    });
    expect((await gh.getPullRequest(REPO, 1)).reviews).toEqual([{ by: "tia", state: "approved" }]);
    const refused = await gh.merge(REPO, 1, A("tia")).catch((e: AdapterError) => e);
    expect(refused).toMatchObject({ code: "unavailable", retryable: false });
    expect((refused as Error).message).toBe(
      "git-host: a person merges PR 1 on the Git host: do step merge-pr-1 (atticus todo), then sync again",
    );
    await recordStep(store, "merge-pr-1", { by: "tia" });
    expect((await gh.getPullRequest(REPO, 1)).state).toBe("merged");
    expect((await gh.merge(REPO, 1, A("tia"))).state).toBe("merged");
  });

  it("asks for reviews again after a comment on an updated PR", async () => {
    const store = memoryStepStore();
    const gh = new ManualGitHost({ store, now });
    await gh.createPullRequest(pr, A("bao"));
    await recordStep(store, "open-pr-handoff-add-transfer-limit-plan", {
      by: "bao",
      values: { url: "https://git.example.com/x/pull/3", number: 3 },
    });
    await recordStep(store, "report-pr-1", {
      by: "bao",
      values: { changesRequestedBy: "tia", checksPassing: "yes" },
    });
    expect((await gh.getPullRequest(REPO, 1)).reviews).toEqual([
      { by: "tia", state: "changes-requested" },
    ]);
    await gh.comment(REPO, 1, "bao updated the hand-off for another review.", A("bao"));
    expect(
      (await store.list({ action: "report-pull-request", state: "open" })).map((s) => s.id),
    ).toEqual(["report-pr-1-2"]);
  });
});

describe("manual notifications and wiki", () => {
  it("accepts a standing approval for a message and reads wiki pages from an export folder", async () => {
    const store = memoryStepStore();
    const n = new ManualNotifier({ store, now });
    expect(
      await n.send(
        { channel: "#forge-ledger", title: "Plan ready", body: "Stories are ready to review." },
        { ...A(), scope: "standing" },
      ),
    ).toEqual({ id: "manual:message-forge-ledger" });

    const root = await mkdtemp(join(tmpdir(), "atticus-wiki-"));
    await mkdir(join(root, "inputs/wiki/how-to"), { recursive: true });
    await writeFile(
      join(root, "inputs/wiki/how-to/firewall.md"),
      "# How to request a firewall rule\n\nFields: …\n",
    );
    const wiki = new ManualWiki({ store, root });
    expect((await wiki.listPages("how-to")).map((p) => [p.id, p.title])).toEqual([
      ["how-to/firewall.md", "How to request a firewall rule"],
    ]);
    expect((await wiki.search("firewall")).length).toBe(1);
    await expect(wiki.getPage("nope.md")).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("createAdapters with manual adapters", () => {
  it("needs a step store for type manual and builds every manual adapter", () => {
    const runtime = { adapters: { serviceDesk: { type: "manual", settings: {} } } } as never;
    expect(() => createAdapters(runtime)).toThrow(AdapterError);
    const a = createAdapters(runtime, {}, { store: memoryStepStore() });
    expect(a.serviceDesk).toBeInstanceOf(ManualServiceDesk);
    expect(Object.keys(allManual({ store: memoryStepStore() }))).toEqual([
      "workTracker",
      "serviceDesk",
      "gitHost",
      "wiki",
      "notify",
      "design",
    ]);
  });

  it("falls back to manual when a live adapter has no credentials or can't be reached", async () => {
    const store = memoryStepStore();
    const events: string[] = [];
    const runtime = {
      adapters: {
        serviceDesk: { type: "servicenow", settings: {} },
        workTracker: { type: "azure-devops", settings: {} },
      },
    } as never;
    const live = new MockServiceDesk();
    const a = createAdapters(
      runtime,
      {
        serviceDesk: { servicenow: () => live },
        workTracker: {
          "azure-devops": () => {
            throw new AdapterError(
              "work-tracker",
              "unauthorized",
              "no credentials for azure-devops",
            );
          },
        },
      },
      { store, now, onFallback: (e) => events.push(`${e.kind}.${e.method}: ${e.code}`) },
    );
    expect(a.workTracker).toBeInstanceOf(ManualWorkTracker);
    await a.workTracker!.createItem({ type: "feature", title: "Limits" }, A());
    expect((await store.list())[0]!.reason).toBe(
      "the workTracker adapter couldn't start (unauthorized): work-tracker: no credentials for azure-devops",
    );

    const desk = a.serviceDesk as ServiceDesk;
    live.failNext("unavailable", "submitRequest");
    const r = await desk.submitRequest(
      {
        templateId: "firewall-rule",
        type: "Network firewall rule",
        changeId: "c1",
        fields: { Port: 443 },
      },
      A("dana"),
    );
    expect(r.id).toBe("manual:request-firewall-rule");
    expect((await store.get("request-firewall-rule"))!.reason).toBe(
      "the serviceDesk adapter failed (unavailable): service-desk: injected unavailable on submitRequest",
    );
    // A live answer that isn't about reaching the system is passed through.
    await expect(desk.getRequest("SR-9999")).rejects.toMatchObject({ code: "not-found" });
    expect(events).toEqual([
      "workTracker.connect: unauthorized",
      "serviceDesk.submitRequest: unavailable",
    ]);
  });
});
