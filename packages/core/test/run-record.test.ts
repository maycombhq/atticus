import { describe, expect, it } from "vitest";
import {
  migrateRunSummary,
  readRunSummary,
  RUN_SCHEMA_VERSION,
  RunSummary,
  ToolDefinition,
} from "../src/index.js";

// ADR 0107 addendum: the run record gains the tools a run's model called, at version 2; a
// version 1 record is still read.
const V1 = {
  schemaVersion: 1,
  runId: "run-20261020-0001",
  change: "add-transfer-limit",
  agent: "task-runner",
  runtime: "mock",
  state: "validated",
  startedAt: "2026-10-20T13:00:00Z",
  contextManifestSha256: "1ddb00eac2aaf91a5ec5d9dfd220116be9f75aec6546a4a3a3b050ed89af2864",
  errors: [],
  attempt: 1,
};

describe("the run record, version 5", () => {
  it("reads a version 1 record as version 5 with no tools, retrieval, class or model", () => {
    expect(RUN_SCHEMA_VERSION).toBe(5);
    expect(RunSummary.safeParse(V1).success).toBe(false);
    const r = readRunSummary(V1);
    expect(r.success).toBe(true);
    expect(r.data?.schemaVersion).toBe(5);
    expect(r.data?.tools).toBeUndefined();
    expect(r.data?.retrieval).toBeUndefined();
    expect(r.data?.stepClass).toBeUndefined();
    expect(r.data?.model).toBeUndefined();
    // ADR 0116: a version 2 record reads with no retrieval.
    const v2 = readRunSummary({
      ...V1,
      schemaVersion: 2,
      tools: { offered: ["search"], calls: [] },
    });
    expect(v2.success).toBe(true);
    expect(v2.data?.schemaVersion).toBe(5);
    expect(v2.data?.retrieval).toBeUndefined();
    // ADR 0121 addendum: a version 3 record reads with no class and no model.
    const v3 = readRunSummary({ ...V1, schemaVersion: 3 });
    expect(v3.success).toBe(true);
    expect(v3.data?.schemaVersion).toBe(5);
    expect(v3.data?.stepClass).toBeUndefined();
    // ADR 0171: a version 4 record reads with no assistant program.
    const v4 = readRunSummary({ ...V1, schemaVersion: 4, stepClass: "read", model: "m" });
    expect(v4.success).toBe(true);
    expect(v4.data?.schemaVersion).toBe(5);
    expect(v4.data?.assistant).toBeUndefined();
    expect(migrateRunSummary("not a record")).toBe("not a record");
  });

  it("keeps the assistant program a copilot-acp run talked to, and its version (ADR 0171)", () => {
    const r = RunSummary.parse({
      ...V1,
      schemaVersion: 5,
      runtime: "copilot-acp",
      stepClass: "read",
      model: "gpt-mock",
      assistant: { name: "copilot-language-server", version: "1.390.0", protocolVersion: 1 },
    });
    expect(r.runtime).toBe("copilot-acp");
    expect(r.assistant?.version).toBe("1.390.0");
    expect(RunSummary.safeParse({ ...V1, schemaVersion: 5, assistant: { name: "" } }).success).toBe(
      false,
    );
    expect(
      RunSummary.safeParse({ ...V1, schemaVersion: 5, assistant: { name: "x", token: "t" } })
        .success,
    ).toBe(false);
  });

  it("keeps the step's class and the model that ran it (ADR 0121 addendum)", () => {
    const r = RunSummary.parse({
      ...V1,
      schemaVersion: 5,
      stepClass: "critic",
      model: "copilot/claude-sonnet-4.5",
    });
    expect(r.stepClass).toBe("critic");
    expect(r.model).toBe("copilot/claude-sonnet-4.5");
    expect(RunSummary.safeParse({ ...V1, schemaVersion: 5, stepClass: "big" }).success).toBe(false);
    expect(RunSummary.safeParse({ ...V1, schemaVersion: 5, model: "" }).success).toBe(false);
  });

  it("keeps every tool call, what it returned, and the cap that stopped them", () => {
    const r = RunSummary.parse({
      ...V1,
      schemaVersion: 5,
      tools: {
        offered: ["search", "show", "walk", "show_code"],
        calls: [
          {
            round: 1,
            id: "call-1",
            name: "show",
            input: { id: "forge-ledger" },
            output: "System forge-ledger ...",
            tokens: 6,
          },
          {
            round: 2,
            name: "show_code",
            input: { id: "nope" },
            output: "There is nothing called nope in the index.",
            tokens: 11,
            error: true,
          },
        ],
        stopped: "rounds",
      },
    });
    expect(r.tools?.calls).toHaveLength(2);
    expect(r.tools?.stopped).toBe("rounds");
  });

  it("keeps how the context was retrieved: the model's expansion and its order (ADR 0116)", () => {
    const r = RunSummary.parse({
      ...V1,
      schemaVersion: 5,
      retrieval: {
        expansion: {
          run: "run-20261020-0000",
          cached: false,
          terms: ["daily limit"],
          names: [
            { name: "Northwind Pay", id: "northwind-pay", quote: "pay through Northwind Pay" },
            { name: "Quillfeather Risk", quote: "scored by Quillfeather Risk" },
          ],
          dropped: [{ name: "Ledger", why: "no id ledgr in the index" }],
        },
        rerank: {
          cached: true,
          shown: 40,
          order: ["Column ledger-db.account.dailylimitamount"],
          dropped: ["System savings"],
          used: true,
        },
        meaning: "similar in meaning is off: retrieval.embeddings.model is off",
      },
    });
    expect(r.retrieval?.expansion?.names).toHaveLength(2);
    expect(r.retrieval?.rerank?.used).toBe(true);
  });

  it("names a tool in lower case with underscores", () => {
    const ok = { name: "show_code", description: "x", inputSchema: { type: "object" } };
    expect(ToolDefinition.safeParse(ok).success).toBe(true);
    expect(ToolDefinition.safeParse({ ...ok, name: "Show Code" }).success).toBe(false);
  });
});
