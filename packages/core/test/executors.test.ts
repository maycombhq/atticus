import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ExecutorConfig,
  ExecutorsFile,
  ManualStep,
  Procedure,
  RunRequest,
  RunResult,
  executorJsonSchemas,
  loadOrgPack,
  orgPackJsonSchemas,
  secretKeys,
} from "../src/index.js";

const msgs = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? [] : r.error!.issues.map((i) => i.message);

const step = {
  schemaVersion: 1,
  id: "snow-firewall-rule-1",
  change: "add-transfer-limit",
  system: "service-desk",
  action: "submit-request",
  key: "service-desk|firewall-rule|gw-northwind-v2",
  title: "Raise a Network firewall rule request for gw-northwind-v2",
  where: 'Service desk: "Network firewall rule" request',
  fields: [{ name: "Source app", value: "gw-northwind-v2" }],
  result: [
    {
      name: "requestNumber",
      label: "Request number",
      format: "pattern",
      pattern: "^SR-\\d{4}$",
    },
  ],
  createdAt: "2026-10-20T09:00:00Z",
  createdBy: "dana",
};

describe("C4 manual steps", () => {
  it("accepts an open step and fills defaults", () => {
    const s = ManualStep.parse(step);
    expect(s.state).toBe("open");
    expect(s.runs).toEqual([]);
    expect(s.inputs).toEqual({});
  });

  it("needs who and when once done, every required value, and a reason to skip", () => {
    expect(msgs(ManualStep.safeParse({ ...step, state: "done" }))).toContain(
      "a done step records who and when",
    );
    expect(
      msgs(
        ManualStep.safeParse({
          ...step,
          state: "done",
          recorded: { at: "2026-10-21T09:00:00Z", by: "dana", values: {} },
        }),
      ),
    ).toContain("Request number is required");
    expect(
      msgs(
        ManualStep.safeParse({
          ...step,
          state: "skipped",
          recorded: { at: "2026-10-21T09:00:00Z", by: "dana" },
        }),
      ),
    ).toContain("say why it was skipped");
  });

  it("refuses a pattern field without a valid pattern and credentials in inputs", () => {
    expect(
      msgs(
        ManualStep.safeParse({
          ...step,
          result: [{ name: "id", label: "Id", format: "pattern", pattern: "(" }],
        }),
      ),
    ).toContain("not a valid pattern");
    expect(msgs(ManualStep.safeParse({ ...step, inputs: { auth: { apiToken: "x" } } }))).toEqual([
      "auth.apiToken looks like a credential; executors never get or give credentials",
    ]);
  });
});

describe("C4 executor protocol", () => {
  it("needs a url for http and a command for command and mcp", () => {
    expect(msgs(ExecutorConfig.safeParse({ name: "desk-bot", transport: "http" }))).toEqual([
      "an http executor needs its url",
    ]);
    expect(msgs(ExecutorConfig.safeParse({ name: "desk-bot", transport: "mcp" }))).toEqual([
      "a mcp executor needs its command",
    ]);
    expect(
      ExecutorsFile.parse({
        schemaVersion: 1,
        executors: [{ name: "desk-bot", transport: "command", command: "node" }],
      }).executors[0],
    ).toMatchObject({ args: [], fillOnly: false, timeoutMs: 120_000 });
  });

  it("never carries credentials in a run request or a result", () => {
    const req = {
      schemaVersion: 1,
      type: "run",
      runId: "run-1",
      procedure: "firewall-rule",
      step: "fill-request",
      inputs: { sourceApp: "gw-northwind-v2", password: "hunter2" },
      idempotencyKey: "0123456789abcdef",
    };
    expect(msgs(RunRequest.safeParse(req))).toEqual([
      "password looks like a credential; executors never get or give credentials",
    ]);
    expect(
      msgs(
        RunResult.safeParse({
          type: "result",
          runId: "run-1",
          status: "done",
          outputs: { sessionId: "abc" },
        }),
      ),
    ).toEqual(["sessionId looks like a credential; executors never get or give credentials"]);
    expect(secretKeys({ a: [{ privateKey: 1 }], b: 2 })).toEqual(["a[0].privateKey"]);
  });

  it("publishes JSON Schema for steps, executors and messages, and procedures with C6", () => {
    expect(Object.keys(executorJsonSchemas())).toEqual([
      "ManualStep",
      "ExecutorsFile",
      "RunRequest",
      "RunProgress",
      "RunResult",
      "PingResponse",
      "IdempotencyAnswer",
    ]);
    expect(orgPackJsonSchemas()).toHaveProperty("Procedure");
  });
});

const procedure = `schemaVersion: 1
id: firewall-rule
name: Raise a network firewall rule
system: service-desk
template: firewall-rule
steps:
  - id: fill-request
    name: Fill in and submit the request
    kind: submit-request
    writes: true
    inputs:
      type: object
      required: [sourceApp]
      properties: { sourceApp: { type: string } }
    outputs:
      type: object
      properties: { requestNumber: { type: string } }
source: inputs/wiki/snow-firewall-request.md
`;

describe("C6 procedures", () => {
  it("load from process/procedures with the allowlist off by default, and name real templates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-procedures-"));
    await mkdir(join(dir, "process/procedures"), { recursive: true });
    await writeFile(join(dir, "process/procedures/firewall-rule.yaml"), procedure);
    await writeFile(
      join(dir, "process/procedures/broken.yaml"),
      procedure.replace("id: firewall-rule\n", "id: broken\n").replace("    writes: true\n", ""),
    );
    const pack = await loadOrgPack(dir);
    expect(pack.procedures.map((p) => p.id)).toEqual(["firewall-rule"]);
    expect(pack.procedures[0]!.executors).toEqual({ allowed: [], remoteHosts: [] });
    expect(pack.procedures[0]!.status).toBe("draft");
    expect(pack.problems).toEqual([
      expect.objectContaining({ file: "process/procedures/broken.yaml", path: "steps.0.writes" }),
      {
        file: "process/procedures/firewall-rule.yaml",
        path: "template",
        message: "no template firewall-rule",
      },
    ]);
  });

  it("refuse duplicate step ids and outputs that aren't an object", () => {
    const base = {
      schemaVersion: 1,
      id: "p",
      name: "P",
      system: "service-desk",
      source: "x",
      steps: [
        { id: "a", name: "A", kind: "submit-request", writes: true },
        { id: "a", name: "B", kind: "submit-request", writes: true, outputs: { type: "string" } },
      ],
    };
    expect(msgs(Procedure.safeParse(base))).toEqual([
      "a step's inputs and outputs are an object",
      "duplicate a",
    ]);
  });
});
