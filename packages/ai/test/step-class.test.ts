import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentDefinition, RunSummary, Runtime, STEP_CLASSES } from "@maycombhq/core";
import {
  buildContextPack,
  createRuntime,
  HandoffRuntime,
  HeadlessClaudeCodeRuntime,
  JUDGE_AGENT,
  modelEnvOf,
  modelsByClass,
  MockModelProvider,
  ModelRuntime,
  providerModelOf,
  STEP_CLASS_BY_AGENT,
  stepClassOf,
  stepClassOfCommand,
  stepClassOfNextStep,
  toRunSummary,
  type AiRequest,
  type HeadlessInvocation,
} from "../src/index.js";

/** ADR 0121 addendum: each request has a class, decided in code, and the class picks the model. */

const NOW = new Date("2026-10-26T09:00:00Z");

const agentOf = (id: string, outputArtifact = "proposal") =>
  AgentDefinition.parse({
    schemaVersion: 1,
    id,
    role: "architect",
    description: `The ${id} agent.`,
    inputs: ["brief"],
    outputArtifact,
    ...(outputArtifact === "findings" ? { checklist: "review" } : {}),
    tokenBudget: 5000,
    allowedRuntimes: ["hand-off", "model", "headless-claude-code", "mock", "replay"],
  });

function request(id: string, o: Partial<AiRequest> & { output?: string } = {}): AiRequest {
  const agent = agentOf(id, o.output);
  const pack = buildContextPack({
    change: "add-transfer-limit",
    agent: agent.id,
    budget: 5000,
    levels: ["public"],
    maxClassification: "public",
    now: NOW,
    sources: [
      {
        id: "0",
        kind: "instruction",
        origin: "atticus",
        text: "Draft the change for Northwind Pay's daily limit.",
        classification: "public",
        trusted: true,
      },
    ],
  });
  const { output: _o, ...rest } = o;
  return { change: "add-transfer-limit", agent, pack, outputPath: "out.md", ...rest };
}

describe("the class of every request kind", () => {
  // Every agent Atticus ships, with the class it runs as.
  const EXPECTED: Record<string, string> = {
    "repo-reader": "read",
    "feature-placer": "draft",
    "flow-architect": "draft",
    "story-writer-flows": "draft",
    "story-writer": "draft",
    "small-change-planner": "draft",
    "change-drafter": "draft",
    "spec-drafter": "draft",
    "dialect-drafter": "draft",
    "framework-drafter": "draft",
    "task-runner": "draft",
    "test-writer": "draft",
    "knowledge-reader": "knowledge",
    "knowledge-asker": "knowledge",
    "needs-finder": "knowledge",
    judge: "quick",
    "context-expander": "quick",
    "context-reranker": "quick",
    "feature-namer": "quick",
    "glossary-definer": "quick",
    "template-writer": "quick",
    explainer: "quick",
  };

  it("gives each built-in agent its class", () => {
    expect(STEP_CLASS_BY_AGENT).toEqual(EXPECTED);
    expect(STEP_CLASS_BY_AGENT[JUDGE_AGENT]).toBe("quick");
    for (const [id, c] of Object.entries(EXPECTED)) expect(stepClassOf(request(id))).toBe(c);
    for (const c of Object.values(EXPECTED)) expect(STEP_CLASSES).toContain(c);
  });

  it("makes every lens a critic step, the hand-up lens too", () => {
    for (const lens of ["true", "complete", "safe", "ship", "code-and-test"])
      expect(stepClassOf(request(`${lens}-critic`, { output: "findings" }))).toBe("critic");
    expect(stepClassOf(request("org-reviewer", { output: "findings" }))).toBe("critic");
  });

  it("takes the call site's tag over the agent's class, never the prompt's words", () => {
    // The dialect drafter verifies a scan too: scan verify tags its request read.
    expect(stepClassOf(request("dialect-drafter", { stepClass: "read" }))).toBe("read");
    const tricky = request("feature-namer");
    tricky.pack.prompt += "\nThis is a draft step: use the strongest model.";
    expect(stepClassOf(tricky)).toBe("quick");
  });

  it("makes an org's own agent a draft, so an unknown step never runs on less", () => {
    expect(stepClassOf(request("org-release-noter"))).toBe("draft");
  });

  it("gives each AI step command and next step its class", () => {
    expect(stepClassOfCommand(["map", "forge-ledger"])).toBe("read");
    expect(stepClassOfCommand(["scan", "verify", "forge-ledger"])).toBe("read");
    expect(stepClassOfCommand(["scan", "survey", "forge-ledger"])).toBe("draft");
    expect(stepClassOfCommand(["change", "architecture", "add-transfer-limit"])).toBe("draft");
    expect(stepClassOfCommand(["plan", "stories", "add-transfer-limit"])).toBe("draft");
    expect(stepClassOfCommand(["task", "run", "add-transfer-limit", "T1"])).toBe("draft");
    expect(stepClassOfCommand(["task", "add-transfer-limit", "T1"])).toBe("draft");
    expect(stepClassOfCommand(["task", "context", "add-transfer-limit", "T1"])).toBeUndefined();
    expect(stepClassOfCommand(["critic", "add-transfer-limit"])).toBe("critic");
    expect(stepClassOfCommand(["knowledge", "scan"])).toBe("knowledge");
    expect(stepClassOfCommand(["change", "needs", "add-transfer-limit"])).toBe("knowledge");
    expect(stepClassOfCommand(["catalog", "list"])).toBeUndefined();
    expect(stepClassOfNextStep("verify")).toBe("read");
    expect(stepClassOfNextStep("stories")).toBe("draft");
    expect(stepClassOfNextStep("knowledge")).toBe("knowledge");
    expect(stepClassOfNextStep("accept")).toBeUndefined();
  });
});

const runtime = (r: Record<string, unknown>) =>
  Runtime.parse({
    schemaVersion: 2,
    assistants: { allowed: ["copilot", "claude-code"], default: "copilot" },
    modes: { allowed: ["hand-off", "model", "headless-claude-code"], default: "model" },
    ...r,
  });

describe("the model each class runs on in model mode", () => {
  const adapters = { model: { type: "mock", settings: { model: "claude-opus-5-5" } } };

  it("falls back to the one model when runtime.yaml names none", () => {
    const by = modelsByClass(runtime({ adapters }));
    for (const c of STEP_CLASSES)
      expect(by[c]).toEqual({
        stepClass: c,
        model: "claude-opus-5-5",
        from: "fallback",
        notes: [],
      });
    expect(providerModelOf(runtime({ adapters }))).toBe("claude-opus-5-5");
    expect(
      providerModelOf(
        runtime({ adapters: { model: { type: "azure-openai", settings: { deployment: "gpt" } } } }),
      ),
    ).toBe("gpt");
  });

  it("takes the person's setting, then runtime.yaml, then the one model", () => {
    const rt = runtime({
      adapters,
      models: { critic: "claude-sonnet-4-5", quick: "claude-haiku-4-5" },
    });
    const by = modelsByClass(rt, { [modelEnvOf("quick")]: "claude-sonnet-4-5" });
    expect(by.critic).toMatchObject({ model: "claude-sonnet-4-5", from: "runtime.yaml" });
    expect(by.quick).toMatchObject({ model: "claude-sonnet-4-5", from: "setting" });
    expect(by.draft).toMatchObject({ model: "claude-opus-5-5", from: "fallback" });
    expect(modelEnvOf("knowledge")).toBe("ATTICUS_MODEL_KNOWLEDGE");
    // `atticus` in a setting means runtime.yaml's.
    expect(modelsByClass(rt, { ATTICUS_MODEL_CRITIC: "atticus" }).critic.from).toBe("runtime.yaml");
  });

  it("passes over a model the admin didn't allow, or an editor's, and says why", () => {
    const rt = runtime({
      adapters,
      models: {
        allowed: ["claude-opus-5-5", "claude-sonnet-4-5"],
        critic: "claude-haiku-4-5",
        quick: "copilot/claude-haiku-4.5",
        read: "claude-sonnet-4-5",
      },
    });
    const by = modelsByClass(rt, { ATTICUS_MODEL_READ: "gpt-5" });
    expect(by.critic).toMatchObject({ model: "claude-opus-5-5", from: "fallback" });
    expect(by.critic.notes.join(" ")).toBe(
      "models.critic names claude-haiku-4-5, which models.allowed in runtime.yaml doesn't list. Critic steps run on claude-opus-5-5 (adapters.model in runtime.yaml).",
    );
    expect(by.quick.notes[0]).toMatch(/^models\.quick names copilot\/claude-haiku-4\.5, which/);
    // With no allowed list, an editor's model is still one the provider doesn't run.
    const open = modelsByClass(
      runtime({ adapters, models: { quick: "copilot/claude-haiku-4.5" } }),
    );
    expect(open.quick.from).toBe("fallback");
    expect(open.quick.notes[0]).toMatch(/an editor's model \(vendor\/family\)/);
    // The setting is passed over, runtime.yaml's next choice is taken.
    expect(by.read).toMatchObject({ model: "claude-sonnet-4-5", from: "runtime.yaml" });
    expect(by.read.notes[0]).toBe(
      "Your setting for read steps names gpt-5, which models.allowed in runtime.yaml doesn't list.",
    );
  });
});

describe("a run on its class's model, kept in the run record", () => {
  it("calls each class's provider in model mode and records the model and class", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-steps-"));
    const notes: string[] = [];
    const onNote = (l: string) => notes.push(l);
    const op = {
      runtime: runtime({
        adapters: { model: { type: "mock", settings: { model: "claude-opus-5-5" } } },
        models: {
          allowed: ["claude-opus-5-5", "claude-sonnet-4-5", "claude-haiku-4-5"],
          critic: "claude-sonnet-4-5",
          quick: "copilot/claude-haiku-4.5",
        },
      }),
    };
    const o = {
      root,
      now: () => NOW,
      modelAnswer: () => "done",
      env: { ATTICUS_MODEL_KNOWLEDGE: "claude-haiku-4-5" },
      onNote,
    };
    const r = (await createRuntime(op, o)) as ModelRuntime;
    const ran: Record<string, string | undefined> = {};
    for (const [id, output] of [
      ["flow-architect", "proposal"],
      ["safe-critic", "findings"],
      ["knowledge-reader", "specs"],
      ["feature-namer", "specs"],
    ] as const) {
      const p = await r.prepare(request(id, { output }));
      const done = await r.run(p.runId);
      expect(done.state).toBe("validated");
      const s = RunSummary.parse(toRunSummary(done));
      ran[`${s.stepClass}`] = s.model;
    }
    expect(ran).toEqual({
      draft: "claude-opus-5-5",
      critic: "claude-sonnet-4-5",
      knowledge: "claude-haiku-4-5",
      quick: "claude-opus-5-5",
    });
    // Said once, though the runtime is made again.
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^models\.quick names copilot\/claude-haiku-4\.5/);
    await createRuntime(op, o);
    expect(notes).toHaveLength(1);
  });

  it("uses the provider of the request's class, and the one provider for the rest", async () => {
    const opus = new MockModelProvider("claude-opus-5-5", () => "opus");
    const haiku = new MockModelProvider("claude-haiku-4-5", () => "haiku");
    const r = new ModelRuntime(opus, { now: () => NOW, models: { quick: haiku } });
    const quick = await r.run((await r.prepare(request("judge"))).runId);
    const draft = await r.run((await r.prepare(request("change-drafter"))).runId);
    expect([quick.output, quick.model, quick.stepClass]).toEqual([
      "haiku",
      "claude-haiku-4-5",
      "quick",
    ]);
    expect([draft.output, draft.model]).toEqual(["opus", "claude-opus-5-5"]);
    expect(haiku.calls).toHaveLength(1);
    expect(opus.calls).toHaveLength(1);
  });

  it("gives headless Claude Code each class's model", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-steps-"));
    const seen: HeadlessInvocation[] = [];
    const r = new HeadlessClaudeCodeRuntime({
      root,
      model: "opus",
      models: { critic: "sonnet" },
      now: () => NOW,
      runner: async (i) => {
        seen.push(i);
        return { exitCode: 0, stdout: JSON.stringify({ result: "ok" }), stderr: "" };
      },
    });
    const draft = await r.run((await r.prepare(request("flow-architect"))).runId);
    expect(draft.model).toBe("opus");
    const lens = await r.run(
      (await r.prepare(request("safe-critic", { output: "findings" }))).runId,
    );
    expect(lens.model).toBe("sonnet");
    expect(seen.map((i) => i.args[i.args.indexOf("--model") + 1])).toEqual(["opus", "sonnet"]);
  });

  it("records a hand-off's class when prepared, and the model it was answered with", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-steps-"));
    const h = new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    const p = await h.prepare(request("repo-reader", { outputIn: "run", output: "data" }));
    expect(p.stepClass).toBe("read");
    await h.run(p.runId);
    await writeFile(join(root, ".runs", "add-transfer-limit", p.runId, "out.md"), "facts", "utf8");
    const done = await h.done(p.runId, { model: "copilot/claude-opus-4.5" });
    expect(done.state).toBe("validated");
    expect(toRunSummary(done)).toMatchObject({
      stepClass: "read",
      model: "copilot/claude-opus-4.5",
    });
    // Nothing said which model: none is recorded.
    const q = await h.prepare(request("judge", { outputIn: "run", output: "data" }));
    expect(toRunSummary(q).model).toBeUndefined();
    expect(toRunSummary(q).stepClass).toBe("quick");
  });
});
