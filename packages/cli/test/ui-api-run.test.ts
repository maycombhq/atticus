import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { ManualGitHost, fileStepStore } from "@maycombhq/adapters";
import { REFERENCE_EXECUTOR } from "@maycombhq/executors";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiRoutes } from "../src/ui-api.js";
import { uiRunRoutes } from "../src/ui-api-run.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const CHANGE = join(HERE, "../../../fixtures/forge-change/openspec/changes/add-transfer-limit");
const RED = join(HERE, "../../ai/test/fixtures/red-team");
const ID = "add-transfer-limit";
const NOW = "2026-10-21T09:00:00Z";
const T = 120_000;

/** A gateway-route procedure the reference executor may run (ADR 0033). */
const PROCEDURE = `schemaVersion: 1
id: gateway-route
name: Raise a gateway proxy deployment request
system: service-desk
template: gateway-route
steps:
  - id: submit-request
    name: Fill in and submit the request
    kind: submit-request
    writes: true
    inputs: { type: object, required: [proxyName] }
    outputs: { type: object, required: [requestNumber] }
executors: { allowed: [ref] }
source: inputs/wiki/snow-gateway-request.md
status: active
`;

const executors = [
  {
    name: "ref",
    transport: "command" as const,
    command: process.execPath,
    args: [REFERENCE_EXECUTOR, "--transport", "command"],
    procedures: [],
    stepKinds: [],
    fillOnly: true,
    timeoutMs: 10_000,
    tools: {},
  },
];

/** Forge's org pack and expected catalog, the M3 exit change at plan, and a hidden instruction in inputs. */
async function forgeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-ui-run-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await mkdir(join(root, "org-pack/process/procedures"), { recursive: true });
  await writeFile(join(root, "org-pack/process/procedures/gateway-route.yaml"), PROCEDURE);
  for (const r of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(String(r.id));
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(CHANGE, join(root, "openspec/changes", ID), { recursive: true });
  await mkdir(join(root, "inputs/wiki"), { recursive: true });
  await cp(join(RED, "markdown/wiki-hidden-comment.md"), join(root, "inputs/wiki/runbook.md"));
  // A hand-off PR the Git host couldn't open: a step for a person, with a step after it.
  await new ManualGitHost({ store: fileStepStore(root), now: () => NOW }).createPullRequest(
    {
      repo: "forge/forge-metarepo",
      head: "handoff/add-transfer-limit/plan",
      base: "main",
      title: "Plan ready",
      body: "Hand-off",
    },
    { by: "bao", at: NOW, ref: "hand-off" },
  );
  return root;
}

let root: string;
let srv: RunningServer;

async function call(path: string, o: { method?: string; body?: unknown } = {}) {
  const r = await fetch(srv.url + path, {
    method: o.method ?? "GET",
    headers: {
      "X-Atticus-Token": srv.token,
      ...(o.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
  const text = await r.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: r.status, body: (text ? JSON.parse(text) : {}) as any };
}
const post = (path: string, body: unknown = {}) => call(path, { method: "POST", body });

beforeAll(async () => {
  root = await forgeRoot();
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    extend: (r, ctx) => {
      const deps = { now: NOW, todo: { executors, now: () => new Date(NOW) } };
      uiRunRoutes(uiRoutes(r, ctx, deps), ctx, deps);
    },
  });
}, T);
afterAll(() => srv?.close());

describe("service desk queue", () => {
  it("lists snow.md's drafts with what is missing, and refuses to file an incomplete one (422)", async () => {
    const q = await call("/api/service-desk");
    expect(q.status).toBe(200);
    expect(q.body.adapter).toMatchObject({ configured: "mock" });
    expect(q.body.requests).toHaveLength(1);
    expect(q.body.requests[0]).toMatchObject({
      change: ID,
      template: "gateway-route",
      requestType: "Gateway proxy deployment",
      state: "to-file",
      leadTimeDays: 5,
      approvers: ["gateway team"],
      missing: ["Target"],
    });
    expect(q.body.requests[0].fields).toContainEqual({
      name: "Proxy name",
      value: "gw-northwind-v2",
      required: true,
    });

    const early = await post(`/api/service-desk/${ID}/submit`);
    expect(early.status).toBe(422);
    expect(early.body.detail).toContain("fill Target in snow.md first");
    expect((await post("/api/service-desk/nope/submit")).status).toBe(404);
  });

  it("files a complete draft as a step for a person, and the queue shows it waiting", async () => {
    const file = join(root, "openspec/changes", ID, "snow.md");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace("| Target |  |", "| Target | ledger-api:8443 |"),
    );
    const filed = await post(`/api/service-desk/${ID}/submit`);
    expect(filed.status).toBe(200);
    expect(filed.body.lines.join("\n")).toMatch(/a step for a person \(request-gateway-route/);
    const q = await call("/api/service-desk");
    expect(q.body.requests[0]).toMatchObject({ state: "waiting", missing: [] });
    expect(q.body.requests[0].step).toMatch(/^request-gateway-route/);
  });

  it("won't redraft over a snow.md a person wrote unless told to (422, plan snow's words)", async () => {
    const r = await post(`/api/service-desk/${ID}/draft`, {});
    expect(r.status).toBe(422);
    expect(r.body.detail).toBe(
      `${ID} already has planning files a person wrote: snow.md. Re-run with --force to replace them.`,
    );
    expect((await post("/api/service-desk/nope/draft")).status).toBe(404);
  });
});

describe("to-do and manual steps", () => {
  it("lists open steps with their fields, where they come from, and the procedures", async () => {
    const t = await call("/api/todo");
    expect(t.status).toBe(200);
    const ids = t.body.steps.map((s: { id: string }) => s.id);
    expect(ids).toContain("open-pr-handoff-add-transfer-limit-plan");
    const desk = t.body.steps.find((s: { system: string }) => s.system === "service-desk");
    expect(desk).toMatchObject({
      change: ID,
      state: "open",
      procedure: "gateway-route",
      executors: ["ref"],
    });
    expect(desk.fields).toContainEqual({ name: "Target", value: "ledger-api:8443" });
    expect(desk.result.map((f: { name: string }) => f.name)).toEqual(["requestNumber", "url"]);
    const report = t.body.steps.find((s: { id: string }) => s.id === "report-pr-1");
    expect(report.waitsFor).toEqual(["open-pr-handoff-add-transfer-limit-plan"]);
    expect(t.body.sources.find((s: { system: string }) => s.system === "service-desk")).toEqual({
      system: "service-desk",
      configured: "mock",
      open: 1,
    });
    expect(t.body.procedures).toContainEqual(
      expect.objectContaining({ id: "gateway-route", allowed: ["ref"], configured: ["ref"] }),
    );
  });

  it("exports a step for copying", async () => {
    const step = (await call("/api/todo")).body.steps.find(
      (s: { system: string }) => s.system === "service-desk",
    );
    const csv = await call(`/api/todo/${step.id}/export?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.body.text.split("\n")).toContain("Target,ledger-api:8443");
    expect((await call(`/api/todo/${step.id}/export?format=pdf`)).status).toBe(400);
    expect((await call("/api/todo/nope/export")).status).toBe(404);
  });

  it("refuses a result that isn't valid (400) and a step that waits on another (422)", async () => {
    const bad = await post("/api/todo/open-pr-handoff-add-transfer-limit-plan/done", {
      values: { url: "nope", number: "7" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.detail).toContain("Pull request link: nope isn't a link");
    const early = await post("/api/todo/report-pr-1/done", { values: { checksPassing: "yes" } });
    expect(early.status).toBe(422);
    expect(early.body.detail).toBe(
      "Do step open-pr-handoff-add-transfer-limit-plan first: step report-pr-1 depends on it.",
    );
    expect((await post("/api/todo/report-pr-1/done", { skip: true })).status).toBe(400);
  });

  it("records a result as the signed-in person, and skips a step with a reason", async () => {
    const ok = await post("/api/todo/open-pr-handoff-add-transfer-limit-plan/done", {
      values: { url: "https://git.example.com/forge/forge-metarepo/pull/7", number: "7" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ state: "done", recorded: { by: "pat", at: NOW } });
    const skip = await post("/api/todo/report-pr-1/done", { skip: true, note: "Checked by hand" });
    expect(skip.status).toBe(200);
    expect(skip.body).toMatchObject({ state: "skipped", recorded: { note: "Checked by hand" } });
    const all = await call("/api/todo?all=1");
    expect(all.body.steps.map((s: { state: string }) => s.state)).toContain("done");
  });

  it("shows the exact inputs before a run, and runs only with an approval of exactly them", async () => {
    const step = (await call("/api/todo")).body.steps.find(
      (s: { system: string }) => s.system === "service-desk",
    );
    const preview = await call(`/api/todo/${step.id}/run?with=ref`);
    expect(preview.status).toBe(200);
    expect(preview.body.inputs).toMatchObject({ proxyName: "gw-northwind-v2" });
    expect(preview.body.inputsSha256).toMatch(/^[0-9a-f]{64}$/);
    const wrong = await post(`/api/todo/${step.id}/run`, {
      with: "ref",
      inputsSha256: "0".repeat(64),
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body.detail).toContain("The approval doesn't cover these inputs");
    const ran = await post(`/api/todo/${step.id}/run`, {
      with: "ref",
      inputsSha256: preview.body.inputsSha256,
    });
    expect(ran.status).toBe(200);
    expect(ran.body.step).toMatchObject({
      state: "done",
      recorded: { by: "pat", via: "executor", executor: "ref" },
    });
    expect(ran.body.lines.join("\n")).toContain("ref did step");
    expect((await post(`/api/todo/${step.id}/run`, {})).status).toBe(400);
  });
});

describe("release plan", () => {
  it("lists changes with the ones at release first", async () => {
    const l = await call("/api/release");
    expect(l.status).toBe(200);
    expect(l.body[0]).toMatchObject({ id: ID, state: "plan", atRelease: false });
  });

  it("shows a change's way to go-live: gates, requests, repos, rollout, archive gate, evidence", async () => {
    const d = await call(`/api/release/${ID}`);
    expect(d.status).toBe(200);
    expect(d.body.change).toMatchObject({ id: ID, title: "Add a daily transfer limit" });
    expect(typeof d.body.status.nextStep).toBe("string");
    // Go / no-go is the release hand-off PR (ADR 0073): no approver roles are listed.
    expect(d.body).not.toHaveProperty("releaseApprovers");
    expect(d.body.status).not.toHaveProperty("required");
    expect(d.body.requests).toMatchObject({ total: 1, filed: 1, toFile: 0 });
    expect(d.body.repos).toEqual([]);
    expect(d.body.rollout.heading).toBe("Rollout and rollback");
    expect(d.body.rollout.text.length).toBeGreaterThan(0);
    expect(d.body.archive.pass).toBe(false);
    expect(d.body.archive.blockers[0].code).toBe("wrong-state");
    expect(d.body.evidence).toContainEqual(expect.objectContaining({ path: "design.md" }));
    expect(Array.isArray(d.body.conflicts)).toBe(true);
    expect((await call("/api/release/nope")).status).toBe(404);
  });

  it("refuses to archive a change that isn't released, in the gate's words (422)", async () => {
    const r = await post(`/api/release/${ID}/archive`);
    expect(r.status).toBe(422);
    expect(r.body.detail).toMatch(/can't be archived yet/);
  });
});

describe("governance", () => {
  it("shows conformance, the rule layers, waivers and override rates", async () => {
    const g = await call("/api/governance");
    expect(g.status).toBe(200);
    expect(g.body.conformance.kind).toBe("org-pack");
    expect(g.body.conformance.summary.pass).toBeGreaterThan(0);
    expect(g.body.rules.constitution).toBeGreaterThan(0);
    expect(g.body.rules.org).toBeGreaterThan(0);
    expect(g.body.waivers).toEqual([]);
    expect(g.body.overrides).toMatchObject({ rules: [], suggestions: [] });
    expect(g.body).not.toHaveProperty("separation");
  });
});

describe("AI quality", () => {
  it(
    "has no runs at first, refuses live mode, and runs a mock eval",
    async () => {
      const before = await call("/api/evals");
      expect(before.status).toBe(200);
      expect(before.body).toMatchObject({ quality: null, runs: [] });
      const live = await post("/api/evals/run", { mode: "live" });
      expect(live.status).toBe(400);
      expect((await post("/api/evals/run", { mode: "mock", agents: ["nobody"] })).status).toBe(400);
      const ran = await post("/api/evals/run", { mode: "mock", agents: ["feature-namer"] });
      expect(ran.status).toBe(200);
      expect(ran.body.report.agents).toEqual([
        expect.objectContaining({ agent: "feature-namer", passRate: 1 }),
      ]);
      const after = await call("/api/evals");
      expect(after.body.quality.agents).toContainEqual(
        expect.objectContaining({ agent: "feature-namer", mode: "mock" }),
      );
      expect(after.body.runs).toHaveLength(1);
    },
    T,
  );

  it("lists documents the defences quarantined, with what to do", async () => {
    const d = await call("/api/evals/defences");
    expect(d.status).toBe(200);
    const f = d.body.files.find((x: { path: string }) => x.path === "inputs/wiki/runbook.md");
    expect(f).toMatchObject({
      risk: "high",
      action: "quarantined: left out of every AI step until a person cleans it",
    });
    expect(Array.isArray(d.body.items)).toBe(true);
  });
});

describe("learning", () => {
  it("lists lessons by role, and refuses to start one outside a sandbox (422)", async () => {
    const l = await call("/api/learning");
    expect(l.status).toBe(200);
    expect(l.body.sandbox).toBe(false);
    expect(l.body.lessons.length).toBeGreaterThan(0);
    expect(l.body.roles.find((r: { role: string }) => r.role === "developer")).toMatchObject({
      done: 0,
    });
    const start = await post("/api/learning/start", { lesson: "developer-find-your-way" });
    expect(start.status).toBe(422);
    expect(start.body.detail).toMatch(/isn't a practice sandbox/);
  });

  it("starts a lesson in a sandbox and checks steps, with a hint when one fails", async () => {
    await writeFile(join(root, ".atticus-sandbox.json"), JSON.stringify({ sandbox: 1 }));
    const start = await post("/api/learning/start", { lesson: "developer-find-your-way" });
    expect(start.status).toBe(200);
    const l = await call("/api/learning");
    expect(l.body).toMatchObject({ sandbox: true, current: { lesson: "developer-find-your-way" } });
    expect(l.body.current.step.id).toBe("scan");
    const scan = await post("/api/learning/check", {});
    expect(scan.status).toBe(200);
    expect(scan.body).toMatchObject({ pass: true, next: "callers" });
    const wrong = await post("/api/learning/check", { answer: "nobody" });
    expect(wrong.status).toBe(200);
    expect(wrong.body.pass).toBe(false);
    expect(typeof wrong.body.hint).toBe("string");
    const busy = join(root, "openspec");
    expect((await post("/api/learning/sandbox", { dir: busy })).status).toBe(422);
    expect((await post("/api/learning/sandbox", {})).status).toBe(400);
  });
});

describe("settings", () => {
  it("shows runtime modes, adapters, executors and the org pack, read-only", async () => {
    const s = await call("/api/settings");
    expect(s.status).toBe(200);
    expect(s.body.runtime.modes).toEqual({
      allowed: ["hand-off", "headless-claude-code"],
      default: "hand-off",
    });
    expect(s.body.adapters).toContainEqual({ kind: "serviceDesk", type: "mock", mode: "mock" });
    expect(s.body.adapters).toContainEqual({ kind: "wiki", type: null, mode: "not-set" });
    expect(s.body.executors.configured).toEqual([
      expect.objectContaining({ name: "ref", transport: "command", allowedFor: ["gateway-route"] }),
    ]);
    expect(s.body.orgPack.counts.procedures).toBe(1);
    expect(s.body.gates.map((g: { id: string }) => g.id)).toContain("release");
  });

  it("pings the configured executors on request", async () => {
    const c = await call("/api/settings/executors/check");
    expect(c.status).toBe(200);
    expect(c.body.executors[0]).toMatchObject({ name: "ref", reachable: true });
  });
});
