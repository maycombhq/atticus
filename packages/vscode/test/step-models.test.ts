import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runStep, type ModelWanted } from "../src/runner";
import {
  choicesFor,
  chooseStepModel,
  modelEnv,
  orgModelsFrom,
  plannedModel,
  stepClassOfArgs,
  usesConfigured,
  type ModelSettings,
  type SelectModels,
} from "../src/step-models";
import type { Cancel, Cli, CliResult, StepModel } from "../src/types";
import { WORDS } from "../src/words";

/**
 * ADR 0121 addendum: a model per kind of step in VS Code. VS Code's language model API is mocked:
 * `offered` is what the admin left on, and every selector asked is kept.
 */

interface Fake {
  vendor: string;
  family: string;
  name: string;
}

function lm(offered: Fake[]) {
  const asked: { vendor: string; family?: string }[] = [];
  const select: SelectModels<Fake> = async (s) => {
    asked.push(s);
    return offered.filter((m) => m.vendor === s.vendor && (!s.family || m.family === s.family));
  };
  return { select, asked };
}

const OPUS = { vendor: "copilot", family: "claude-opus-4.5", name: "Claude Opus 4.5" };
const SONNET = { vendor: "copilot", family: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" };
const HAIKU = { vendor: "copilot", family: "claude-haiku-4.5", name: "Claude Haiku 4.5" };
const MINI = { vendor: "copilot", family: "gpt-5-mini", name: "GPT-5 mini" };

const none: ModelSettings = { perClass: {}, model: "" };

describe("the order a kind of step's model is chosen in", () => {
  it("takes the person's setting for the kind, then runtime.yaml's, then atticus.model", async () => {
    const s: ModelSettings = {
      perClass: { critic: "copilot/claude-sonnet-4.5" },
      model: "copilot/gpt-5-mini",
    };
    const { select } = lm([OPUS, SONNET, HAIKU, MINI]);
    const org = "copilot/claude-haiku-4.5";
    expect(choicesFor("critic", s, org).map((c) => c.from)).toEqual([
      "class-setting",
      "runtime.yaml",
      "model-setting",
    ]);
    expect(await chooseStepModel("critic", s, { select, orgModel: org })).toEqual({
      model: SONNET,
      from: "class-setting",
      notes: [],
    });
    expect(await chooseStepModel("quick", s, { select, orgModel: org })).toMatchObject({
      model: HAIKU,
      from: "runtime.yaml",
    });
    expect(await chooseStepModel("draft", s, { select })).toMatchObject({
      model: MINI,
      from: "model-setting",
    });
  });

  it("falls back to the chat's model, then Copilot's first, when nothing is set", async () => {
    const { select, asked } = lm([MINI, OPUS]);
    expect(await chooseStepModel("draft", none, { select, chatModel: SONNET })).toEqual({
      model: SONNET,
      from: "chat",
      notes: [],
    });
    expect(asked).toEqual([]);
    expect(await chooseStepModel("draft", none, { select })).toMatchObject({
      model: MINI,
      from: "copilot",
    });
    expect(asked).toEqual([{ vendor: "copilot" }]);
  });

  it("reads a bare family as Copilot's", async () => {
    const { select, asked } = lm([HAIKU]);
    const r = await chooseStepModel("quick", none, { select, orgModel: "claude-haiku-4.5" });
    expect(r.model).toBe(HAIKU);
    expect(asked[0]).toEqual({ vendor: "copilot", family: "claude-haiku-4.5" });
  });
});

describe("a model VS Code doesn't offer", () => {
  it("is passed over for the next choice, and the step says so", async () => {
    // The admin turned Opus off: runtime.yaml's draft model isn't offered.
    const { select } = lm([SONNET, MINI]);
    const r = await chooseStepModel(
      "draft",
      { perClass: {}, model: "copilot/claude-sonnet-4.5" },
      { select, orgModel: "copilot/claude-opus-4.5" },
    );
    expect(r.model).toBe(SONNET);
    expect(r.from).toBe("model-setting");
    expect(r.notes).toEqual([
      WORDS.modelNotOffered("copilot/claude-opus-4.5", "runtime.yaml's models.draft"),
      WORDS.modelInstead("draft", "your setting atticus.model"),
    ]);
  });

  it("never picks a model nobody chose: with nothing left, the step has no model and says why", async () => {
    const { select, asked } = lm([{ vendor: "other", family: "x", name: "X" }]);
    const r = await chooseStepModel(
      "critic",
      { perClass: { critic: "copilot/claude-sonnet-4.5" }, model: "" },
      { select },
    );
    expect(r.model).toBeUndefined();
    expect(r.notes).toEqual([
      WORDS.modelNotOffered("copilot/claude-sonnet-4.5", "atticus.models.critic"),
      WORDS.modelNoneLeft,
    ]);
    // Only the person's choice and Copilot's own were asked for: never another vendor's.
    expect(asked).toEqual([
      { vendor: "copilot", family: "claude-sonnet-4.5" },
      { vendor: "copilot" },
    ]);
  });

  it("passes over `atticus` for one request of a step handed to VS Code's model", async () => {
    const { select } = lm([MINI]);
    const s: ModelSettings = { perClass: { critic: "atticus" }, model: "" };
    expect(await chooseStepModel("critic", s, { select })).toEqual({
      notes: [],
      configured: true,
      from: "class-setting",
    });
    const r = await chooseStepModel("critic", s, { select, handOff: true });
    expect(r.model).toBe(MINI);
    expect(r.notes[0]).toBe(WORDS.modelConfiguredPassedOver("atticus.models.critic"));
  });
});

describe("what decides a whole step", () => {
  it("knows each AI step command's own kind", () => {
    expect(stepClassOfArgs(["map", "forge-ledger"])).toBe("read");
    expect(stepClassOfArgs(["scan", "verify", "forge-ledger"])).toBe("read");
    expect(stepClassOfArgs(["change", "feature", "add-transfer-limit"])).toBe("draft");
    expect(stepClassOfArgs(["critic", "add-transfer-limit"])).toBe("critic");
    expect(stepClassOfArgs(["knowledge", "ask", "limits"])).toBe("knowledge");
    expect(stepClassOfArgs(["questions", "list"])).toBeUndefined();
  });

  it("runs in model mode when the kind's first choice is atticus", () => {
    expect(usesConfigured("read", { perClass: { read: "atticus" }, model: "" })).toBe(true);
    expect(usesConfigured("draft", { perClass: { read: "atticus" }, model: "" })).toBe(false);
    // runtime.yaml's model for the kind comes before atticus.model.
    expect(usesConfigured("draft", { perClass: {}, model: "atticus" }, "copilot/x")).toBe(false);
    expect(usesConfigured("draft", { perClass: {}, model: "atticus" })).toBe(true);
  });

  it("says the model a kind will run on, before VS Code is asked", () => {
    expect(plannedModel("draft", none)).toBe(WORDS.modelChatOrCopilot);
    expect(plannedModel("draft", none, "copilot/claude-opus-4.5")).toBe("copilot/claude-opus-4.5");
    expect(plannedModel("quick", { perClass: { quick: "atticus" }, model: "" })).toBe(
      WORDS.modelConfigured,
    );
  });

  it("reads runtime.yaml's models, and passes the person's to the command line", () => {
    const yaml = [
      "schemaVersion: 2",
      "models:",
      "  allowed: []",
      "  draft: copilot/claude-opus-4.5 # the strongest",
      '  critic: "copilot/claude-sonnet-4.5"',
      "  huge: nope",
      "",
    ].join("\n");
    expect(orgModelsFrom(yaml)).toEqual({
      draft: "copilot/claude-opus-4.5",
      critic: "copilot/claude-sonnet-4.5",
    });
    expect(orgModelsFrom(undefined)).toEqual({});
    expect(orgModelsFrom("- not a map")).toEqual({});
    expect(
      modelEnv({ perClass: { read: "claude-opus-5-5", quick: "atticus", draft: " " }, model: "" }),
    ).toEqual({ ATTICUS_MODEL_READ: "claude-opus-5-5" });
  });
});

/** A fake command line: each call's argv, and canned answers to --handoff --json and done. */
function fakeCli(answers: object[]) {
  const calls: string[][] = [];
  const cli: Cli = async (args): Promise<CliResult> => {
    calls.push(args);
    if (args[0] === "handoff") return { code: 0, stdout: "Checked.", stderr: "", cancelled: false };
    const a = answers.shift() ?? { state: "done", exitCode: 0, messages: [] };
    return { code: 0, stdout: JSON.stringify(a), stderr: "", cancelled: false };
  };
  return { cli, calls };
}

const token: Cancel = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

function model(id: string, answer: string): StepModel & { sent: number } {
  return {
    name: id,
    id,
    maxInputTokens: 100_000,
    sent: 0,
    countTokens: async (t: string) => Math.ceil(t.length / 4),
    async send() {
      this.sent++;
      return (async function* () {
        yield answer;
      })();
    },
  };
}

describe("the runner, a model per kind of step", () => {
  it("answers the draft on the draft's model and the lens on the critic's, and records each", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-steps-"));
    await writeFile(join(root, "prompt.md"), "Draft it.", "utf8");
    const round = (runId: string, extra: object) => ({
      state: "handoff",
      runId,
      promptFile: "prompt.md",
      resultFile: `${runId}.md`,
      doneArgs: ["handoff", "done", runId],
      resumeArgs: ["change", "feature", "add-transfer-limit", "--resume", runId],
      ...extra,
    });
    const { cli, calls } = fakeCli([
      round("run-1", { stepClass: "draft", orgModel: "copilot/claude-opus-4.5" }),
      round("run-2", { stepClass: "critic", lens: "safe" }),
      round("run-3", { stepClass: "critic", lens: "true" }),
    ]);
    const opus = model("copilot/claude-opus-4.5", "the draft");
    const sonnet = model("copilot/claude-sonnet-4.5", "findings: []");
    const wanted: ModelWanted[] = [];
    const end = await runStep(
      ["change", "feature", "add-transfer-limit"],
      {
        root,
        cli,
        model: async (w) => {
          wanted.push(w ?? {});
          return w?.stepClass === "critic" ? sonnet : opus;
        },
      },
      token,
    );
    expect(end.state).toBe("done");
    expect([opus.sent, sonnet.sent]).toEqual([1, 2]);
    // The step's own kind first (to size its prompts), then each kind with runtime.yaml's
    // choice, once: the second lens reuses the critic's model.
    expect(wanted).toEqual([
      { stepClass: "draft" },
      { stepClass: "draft", orgModel: "copilot/claude-opus-4.5" },
      { stepClass: "critic" },
    ]);
    const dones = calls.filter((c) => c[0] === "handoff");
    expect(dones).toEqual([
      ["handoff", "done", "run-1", "--model", "copilot/claude-opus-4.5"],
      ["handoff", "done", "run-2", "--model", "copilot/claude-sonnet-4.5"],
      ["handoff", "done", "run-3", "--model", "copilot/claude-sonnet-4.5"],
    ]);
  });

  it("keeps the one model, and no --model, with a command line that says no kind", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-steps-"));
    await writeFile(join(root, "prompt.md"), "Draft it.", "utf8");
    const { cli, calls } = fakeCli([
      {
        state: "handoff",
        runId: "run-1",
        promptFile: "prompt.md",
        resultFile: "r.md",
        doneArgs: ["handoff", "done", "run-1"],
        resumeArgs: ["scan", "survey", "forge-notes", "--resume", "run-1"],
      },
    ]);
    const one = model("copilot/gpt-5-mini", "x");
    const end = await runStep(
      ["scan", "survey", "forge-notes"],
      { root, cli, model: async () => one },
      token,
    );
    expect(end.state).toBe("done");
    expect(calls.find((c) => c[0] === "handoff")).toEqual(["handoff", "done", "run-1"]);
  });
});
