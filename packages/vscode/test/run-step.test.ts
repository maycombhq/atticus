import { describe, expect, it } from "vitest";
import type { Catalog } from "../src/commands";
import { checkRunStep, runEndMessage, runProgressMessage } from "../src/run-step";
import type { StepEnd } from "../src/runner";

/**
 * ADR 0106: Run with Copilot from the app in a VS Code panel. The page sends
 * `{ type: "run-step", id, args }`; the extension runs only the catalogue's AI steps, and refuses
 * any argument that starts with "-".
 */

const catalog: Catalog = {
  areas: [{ id: "repos", title: "Repos" }],
  commands: [
    {
      id: "scan survey",
      words: ["scan", "survey"],
      usage: "atticus scan survey <repo>",
      summary: "Your assistant reads the repo and drafts its scan settings",
      args: [{ name: "repo", kind: "repo", optional: false, many: false }],
      flags: [{ name: "--attempts", value: "3", required: false }],
      area: "repos",
      runs: "ai",
    },
    {
      id: "spec draft",
      words: ["spec", "draft"],
      usage: "atticus spec draft <repo>",
      summary: "Your assistant writes the repo's flows",
      args: [{ name: "repo", kind: "repo", optional: false, many: false }],
      flags: [],
      area: "repos",
      runs: "ai",
    },
    {
      id: "knowledge scan",
      words: ["knowledge", "scan"],
      usage: "atticus knowledge scan [--source s]",
      summary: "Your assistant reads the snapshots",
      args: [],
      flags: [],
      area: "repos",
      runs: "ai",
    },
    {
      id: "spec check",
      words: ["spec", "check"],
      usage: "atticus spec check <repo> [--json]",
      summary: "Check the repo's flows",
      args: [{ name: "repo", kind: "repo", optional: false, many: false }],
      flags: [],
      area: "repos",
      runs: "local",
    },
    {
      id: "change publish",
      words: ["change", "publish"],
      usage: "atticus change publish <change> [--approve]",
      summary: "Open the change's PRs",
      args: [{ name: "change", kind: "change", optional: false, many: false }],
      flags: [{ name: "--approve", required: false }],
      area: "repos",
      runs: "shared",
      approve: "--approve",
    },
  ],
};

const msg = (args: unknown, id: unknown = 7) => ({ type: "run-step", id, args });

describe("a step started from the app in a panel (ADR 0106)", () => {
  it("leaves other messages alone", () => {
    expect(checkRunStep({ type: "api", id: 1 }, catalog)).toBeUndefined();
    expect(checkRunStep("run-step", catalog)).toBeUndefined();
    expect(checkRunStep(null, catalog)).toBeUndefined();
  });

  it("accepts an AI step of the catalogue with its arguments", () => {
    expect(checkRunStep(msg(["scan", "survey", "forge-ledger"]), catalog)).toEqual({
      ok: true,
      id: 7,
      command: "scan survey",
      args: ["scan", "survey", "forge-ledger"],
    });
    expect(checkRunStep(msg(["knowledge", "scan"], "r1"), catalog)).toMatchObject({
      ok: true,
      id: "r1",
    });
  });

  it("runs spec draft as the sidebar does, with its check after", () => {
    expect(checkRunStep(msg(["spec", "draft", "forge-ledger"]), catalog)).toMatchObject({
      ok: true,
      spec: "forge-ledger",
    });
  });

  it("refuses a command that isn't an AI step", () => {
    for (const args of [
      ["spec", "check", "forge-ledger"],
      ["change", "publish", "add-transfer-limit"],
      ["no", "such"],
    ]) {
      const r = checkRunStep(msg(args), catalog);
      expect(r?.ok, args.join(" ")).toBe(false);
      if (r && !r.ok) expect(r.reason).toMatch(/only runs the AI steps/);
    }
  });

  it("refuses any argument that starts with a dash", () => {
    for (const args of [
      ["scan", "survey", "--attempts", "9"],
      ["scan", "survey", "-x"],
      ["scan", "survey", "forge-ledger", "--root", "/elsewhere"],
    ]) {
      const r = checkRunStep(msg(args), catalog);
      expect(r).toMatchObject({ ok: false, id: 7 });
      if (r && !r.ok) expect(r.reason).toMatch(/starts with "-"/);
    }
  });

  it("refuses a step without what it needs, or with words that aren't text", () => {
    const missing = checkRunStep(msg(["scan", "survey"]), catalog);
    expect(missing).toMatchObject({ ok: false });
    if (missing && !missing.ok) expect(missing.reason).toMatch(/needs repo/);
    expect(checkRunStep(msg("scan survey forge-ledger"), catalog)).toMatchObject({ ok: false });
    expect(checkRunStep(msg(["scan", "survey", 5]), catalog)).toMatchObject({ ok: false });
    expect(checkRunStep(msg(["scan", "survey", "a\nb"]), catalog)).toMatchObject({ ok: false });
    expect(checkRunStep(msg(["scan", "survey", "x"], { no: 1 }), catalog)).toMatchObject({
      ok: false,
      id: undefined,
    });
  });

  it("posts progress and the end in the agreed shapes", () => {
    expect(runProgressMessage(7, "Round 1: Atticus handed off run run-1.")).toEqual({
      type: "run-progress",
      id: 7,
      line: "Round 1: Atticus handed off run run-1.",
    });
    const end: StepEnd = {
      state: "done",
      rounds: 1,
      exitCode: 0,
      messages: ["Wrote org-pack/scan/forge-ledger.yaml"],
      errors: [],
      questions: [],
      files: { runId: "run-20261023053215-0002", prompt: "p.md", answer: "a.yaml" },
    };
    expect(runEndMessage(7, end)).toEqual({
      type: "run-end",
      id: 7,
      state: "done",
      lines: [
        "The step is done after 1 answer from the model.",
        "Wrote org-pack/scan/forge-ledger.yaml",
      ],
      runId: "run-20261023053215-0002",
    });
    const noModel: StepEnd = {
      state: "no-model",
      runId: "run-9",
      promptFile: "p.md",
      resultFile: "a.yaml",
      resumeCommand: "atticus scan survey forge-ledger --resume run-9",
    };
    expect(runEndMessage(7, noModel)).toMatchObject({ state: "no-model", runId: "run-9" });
    expect(runEndMessage(7, undefined)).toEqual({
      type: "run-end",
      id: 7,
      state: "not-started",
      lines: ["The step didn't start: open a metarepo, and check that atticus runs."],
    });
  });
});
