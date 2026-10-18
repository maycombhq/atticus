import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ManualServiceDesk, fileStepStore, type StepStore } from "@maycombhq/adapters";
import { loadOrgPack, type ExecutorConfig, type ManualStep } from "@maycombhq/core";
import {
  REFERENCE_EXECUTOR,
  executorsCheck,
  inputsSha256,
  loadExecutors,
  runStep,
  type RunStepResult,
} from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = "2026-10-21T09:00:00Z";
const LATER = "2026-10-21T10:00:00Z";
const node = process.execPath;

let http: ChildProcess;
let httpUrl = "";

beforeAll(async () => {
  http = spawn(node, [REFERENCE_EXECUTOR, "--transport", "http", "--port", "0"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  httpUrl = await new Promise<string>((resolve) => {
    http.stdout!.setEncoding("utf8");
    http.stdout!.on("data", (d: string) => {
      const m = /listening (\d+)/.exec(d);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
  });
});
afterAll(() => {
  http?.kill();
});

/** A metarepo with the procedure and a manual firewall-rule step created by the manual desk. */
async function setup(): Promise<{
  root: string;
  store: StepStore;
  step: ManualStep;
  state: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "atticus-executors-"));
  await cp(join(HERE, "fixtures/org-pack"), join(root, "org-pack"), { recursive: true });
  const pack = await loadOrgPack(join(root, "org-pack"));
  expect(pack.problems).toEqual([]);
  await mkdir(join(root, "openspec/changes/add-transfer-limit"), { recursive: true });
  const store = fileStepStore(root);
  const desk = new ManualServiceDesk({ store, procedures: pack.procedures, now: () => NOW });
  await desk.submitRequest(
    {
      templateId: "firewall-rule",
      type: "Network firewall rule",
      changeId: "add-transfer-limit",
      fields: {
        "Source app": "gw-northwind-v2",
        "Destination host": "api.northwind.example",
        Port: "443",
        Protocol: "HTTPS",
      },
    },
    { by: "dana", at: NOW, ref: "snow" },
  );
  const step = (await store.get("request-firewall-rule"))!;
  return { root, store, step, state: join(root, "executor-state.json") };
}

const configs = (state: string, extra: string[] = []): ExecutorConfig[] => [
  {
    name: "ref-http",
    transport: "http",
    url: httpUrl,
    args: [],
    procedures: [],
    stepKinds: [],
    fillOnly: true,
    timeoutMs: 10_000,
    tools: {},
  },
  {
    name: "ref-command",
    transport: "command",
    command: node,
    args: [REFERENCE_EXECUTOR, "--transport", "command", "--state", state, ...extra],
    procedures: [],
    stepKinds: [],
    fillOnly: true,
    timeoutMs: 10_000,
    tools: {},
  },
  {
    name: "ref-mcp",
    transport: "mcp",
    command: node,
    args: [REFERENCE_EXECUTOR, "--transport", "mcp", "--state", state, ...extra],
    procedures: ["firewall-rule"],
    stepKinds: [],
    fillOnly: false,
    timeoutMs: 10_000,
    tools: {},
  },
];

const approve = (step: ManualStep, by = "dana", at = NOW) => ({
  by,
  at,
  ref: step.id,
  inputsSha256: inputsSha256(step.inputs),
});

describe("executors over all three transports", () => {
  for (const name of ["ref-http", "ref-command", "ref-mcp"]) {
    it(`${name}: runs an approved write, checks the outputs and records them for the approver`, async () => {
      const { root, store, step, state } = await setup();
      expect(step).toMatchObject({ procedure: "firewall-rule", procedureStep: "submit-request" });
      const progress: string[] = [];
      const r: RunStepResult = await runStep(root, step.id, {
        executor: name,
        approval: approve(step),
        store,
        executors: configs(state),
        now: () => LATER,
        onProgress: (p) => progress.push(p.message),
      });
      expect(r.status).toBe("done");
      expect(r.fallback).toBe(false);
      expect(r.outputs?.requestNumber).toMatch(/^SR-\d{4}$/);
      expect(progress).toEqual(["Opening the form", "Filling in the fields"]);
      const closed = (await store.get(step.id))!;
      expect(closed.state).toBe("done");
      expect(closed.recorded).toMatchObject({
        by: "dana",
        via: "executor",
        executor: name,
        values: { requestNumber: r.outputs!.requestNumber },
        evidence: [
          { kind: "page", ref: `reference://requests/${String(r.outputs!.requestNumber)}` },
        ],
      });
      expect(closed.runs).toEqual([
        expect.objectContaining({
          executor: name,
          status: "done",
          mode: "submit",
          approval: approve(step),
        }),
      ]);
    });
  }

  it("fills without submitting when asked, and leaves the step to the person", async () => {
    const { root, store, step, state } = await setup();
    const r = await runStep(root, step.id, {
      executor: "ref-command",
      approval: approve(step),
      fillOnly: true,
      store,
      executors: configs(state),
      now: () => LATER,
    });
    expect(r).toMatchObject({ status: "needs-person", fallback: true });
    expect(r.message).toBe(
      "ref-command stopped and a person finishes step request-firewall-rule: The form is filled in but not submitted; check it and submit it yourself.",
    );
    expect((await store.get(step.id))!.state).toBe("open");
    await expect(
      runStep(root, step.id, {
        executor: "ref-mcp",
        approval: approve(step),
        fillOnly: true,
        store,
        executors: configs(state),
      }),
    ).rejects.toMatchObject({
      code: "refused",
      message: "ref-mcp can't fill a form without submitting it.",
    });
  });

  it("falls back to the manual step on failure or timeout, and never retries without a new approval", async () => {
    const { root, store, step, state } = await setup();
    const failing = configs(state, ["--behaviour", "fail"]);
    const r = await runStep(root, step.id, {
      executor: "ref-command",
      approval: approve(step),
      store,
      executors: failing,
      now: () => LATER,
    });
    expect(r).toMatchObject({ status: "failed", fallback: true });
    expect(r.message).toContain("The step stays open: do it yourself, or approve a new run.");
    // The executor says the key was never used, so the same approval may try again.
    const again = await runStep(root, step.id, {
      executor: "ref-command",
      approval: approve(step),
      store,
      executors: failing,
      now: () => LATER,
    });
    expect(again.status).toBe("failed");

    const slow: ExecutorConfig[] = configs(state, ["--behaviour", "slow"]).map((c) => ({
      ...c,
      timeoutMs: 300,
    }));
    const t = await runStep(root, step.id, {
      executor: "ref-mcp",
      approval: approve(step, "dana", LATER),
      store,
      executors: slow,
      now: () => LATER,
    });
    expect(t).toMatchObject({ status: "timed-out", fallback: true });

    // A key the executor did use: only a newer approval may run it again.
    const used = JSON.parse(await readFile(state, "utf8").catch(() => '{"used":[],"runs":[]}'));
    used.used.push((await store.get(step.id))!.runs.at(-1)!.idempotencyKey);
    await writeFile(state, JSON.stringify(used));
    await expect(
      runStep(root, step.id, {
        executor: "ref-command",
        approval: approve(step, "dana", LATER),
        store,
        executors: configs(state),
      }),
    ).rejects.toMatchObject({ code: "refused" });
    const ok = await runStep(root, step.id, {
      executor: "ref-command",
      approval: approve(step, "dana", "2026-10-21T11:00:00Z"),
      store,
      executors: configs(state),
      now: () => "2026-10-21T11:00:00Z",
    });
    expect(ok.status).toBe("done");
    expect((await store.get(step.id))!.runs.map((x) => x.status)).toEqual([
      "failed",
      "failed",
      "timed-out",
      "done",
    ]);
  });

  it("refuses what the safety rules forbid, before calling anything", async () => {
    const { root, store, step, state } = await setup();
    const all = configs(state);
    const refused = (o: Parameters<typeof runStep>[2]) =>
      runStep(root, step.id, { store, executors: all, ...o });
    await expect(refused({ executor: "ref-command" })).rejects.toMatchObject({
      message: `Step request-firewall-rule writes to service-desk: approve this run with its exact inputs (sha-256 ${inputsSha256(step.inputs)}).`,
    });
    await expect(
      refused({
        executor: "ref-command",
        approval: { ...approve(step), inputsSha256: "0".repeat(64) },
      }),
    ).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("The approval doesn't cover these inputs"),
    });
    await expect(refused({ executor: "ref-other", approval: approve(step) })).rejects.toMatchObject(
      {
        message:
          "Executors are off unless the org pack allows them: process/procedures/firewall-rule.yaml doesn't list ref-other under executors.allowed.",
      },
    );
    const remote: ExecutorConfig = {
      ...all[0]!,
      name: "ref-broken",
      url: "https://automation.example.com",
    };
    await expect(
      refused({ executor: "ref-broken", approval: approve(step), executors: [remote] }),
    ).rejects.toMatchObject({
      message:
        "ref-broken is at automation.example.com, not on this machine; the org pack doesn't allow that host for firewall-rule.",
    });
    expect(JSON.parse(await readFile(state, "utf8").catch(() => '{"runs":[]}')).runs).toEqual([]);
    expect((await store.get(step.id))!.runs).toEqual([]);
  });

  it("rejects outputs that don't fit the step, and passes no credentials to a started program", async () => {
    const { root, store, step, state } = await setup();
    const bad = await runStep(root, step.id, {
      executor: "ref-command",
      approval: approve(step),
      store,
      executors: configs(state, ["--behaviour", "bad-output"]),
    });
    expect(bad.status).toBe("failed");
    expect(bad.message).toContain("outputs don't fit the step");
    process.env.ATTICUS_TEST_API_TOKEN = "must-not-leak";
    try {
      const env = await runStep(root, step.id, {
        executor: "ref-command",
        approval: approve(step, "dana", LATER),
        store,
        executors: configs(state, ["--behaviour", "env"]),
      });
      expect(env.status).toBe("done");
      expect(env.outputs?.leakedEnv).toBe(0);
    } finally {
      delete process.env.ATTICUS_TEST_API_TOKEN;
    }
  });
});

describe("atticus executors check", () => {
  it("pings each configured executor and lists what it covers and where the org pack allows it", async () => {
    const { root, state } = await setup();
    await mkdir(join(root, ".atticus"), { recursive: true });
    const { stringify } = await import("yaml");
    const list = [
      ...configs(state),
      { name: "ref-gone", transport: "command", command: join(root, "no-such-program"), args: [] },
    ];
    await writeFile(
      join(root, ".atticus/executors.yaml"),
      stringify({ schemaVersion: 1, executors: list }),
    );
    expect((await loadExecutors(root)).executors.map((e) => e.name)).toEqual([
      "ref-http",
      "ref-command",
      "ref-mcp",
      "ref-gone",
    ]);
    const r = await executorsCheck(root);
    expect(r.executors.map((e) => [e.name, e.reachable, e.covers, e.allowedFor])).toEqual([
      ["ref-http", true, ["submit-request"], ["firewall-rule"]],
      ["ref-command", true, ["submit-request"], ["firewall-rule"]],
      ["ref-mcp", true, ["firewall-rule", "firewall-rule_submit-request"], ["firewall-rule"]],
      ["ref-gone", false, [], []],
    ]);
    expect(r.executors[3]!.problem).toContain("can't be started");
    expect(r.missing).toEqual([{ procedure: "firewall-rule", executor: "ref-broken" }]);
  });
});
