import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { itemText } from "../src/filter";
import {
  answerFileOf,
  parseRuns,
  runChildren,
  runHash,
  runItems,
  type RunEntry,
} from "../src/runs-data";
import type { Paths } from "../src/sidebar-data";

/**
 * ADR 0106: the Model runs section, from `atticus runs --json`. Each run says its step or change,
 * agent, round, state, whether it was answered and how many problems were handed back; it opens
 * to its prompt, its answer and the app's Model runs screen.
 */

const ROOT = join("/", "meta");

const survey: RunEntry = {
  runId: "run-20261023053215-0002",
  change: "survey-forge-ledger",
  agent: "scan-surveyor",
  runtime: "hand-off",
  state: "validated",
  startedAt: "2026-10-23T05:32:15.120Z",
  finishedAt: "2026-10-23T05:32:40.000Z",
  output: "scan-settings.yaml",
  promptPath: ".runs/survey-forge-ledger/run-20261023053215-0002/prompt.md",
  attempt: 2,
  answered: true,
  handedBack: 3,
  promptTokens: 4120,
};

const needs: RunEntry = {
  runId: "run-20261023040247-0001",
  change: "add-transfer-limit",
  agent: "needs-finder",
  runtime: "hand-off",
  state: "waiting",
  startedAt: "2026-10-23T04:02:47.000Z",
  output: "change-needs.yaml",
  promptPath: ".runs/add-transfer-limit/run-20261023040247-0001/prompt.md",
  attempt: 1,
  answered: false,
  handedBack: 0,
};

const JSON_OUT = JSON.stringify({ runs: [survey, needs] }, null, 2);

const paths = (files: string[]): Paths => ({
  root: ROOT,
  codeRoot: () => undefined,
  catalogRel: "catalog",
  exists: (p) => files.includes(p),
});

describe("the Model runs section (ADR 0106)", () => {
  it("reads atticus runs --json", () => {
    expect(parseRuns(JSON_OUT)).toEqual([survey, needs]);
  });

  it("says why when what the command line printed isn't the list", () => {
    expect(() => parseRuns("Unknown command: runs")).toThrow(/atticus runs/);
    expect(() => parseRuns(JSON.stringify({ items: [] }))).toThrow(/atticus runs/);
  });

  it("lists each run newest first with its agent, round, state, answer and problems", () => {
    const rows = runItems([needs, survey]);
    expect(rows.map((r) => r.label)).toEqual(["survey-forge-ledger", "add-transfer-limit"]);
    expect(rows[0]!.description).toBe(
      "scan-surveyor · round 2 · validated · answered · 3 problems handed back",
    );
    expect(rows[1]!.description).toBe("needs-finder · round 1 · waiting · no answer yet");
    expect(rows[0]!.expand).toEqual({ kind: "run", run: survey });
    expect(rows[0]!.tooltip).toContain("run-20261023053215-0002");
    expect(rows[0]!.tooltip).toContain("4120 tokens");
    // A run that passed has a green tick; one waiting on a model has a clock.
    expect(rows[0]!.icon).toBe("pass");
    expect(rows[1]!.icon).toBe("clock");
  });

  it("is filtered by its step, agent, run id and state", () => {
    const text = itemText(runItems([survey])[0]!);
    for (const w of [
      "survey-forge-ledger",
      "scan-surveyor",
      "run-20261023053215-0002",
      "validated",
    ])
      expect(text).toContain(w);
  });

  it("finds the answer in the run's folder first, then the change's", () => {
    const inRun = join(
      ROOT,
      ".runs/survey-forge-ledger/run-20261023053215-0002/scan-settings.yaml",
    );
    expect(answerFileOf(survey, paths([inRun]))).toBe(inRun);
    const inChange = join(ROOT, "openspec/changes/survey-forge-ledger/scan-settings.yaml");
    expect(answerFileOf(survey, paths([inChange]))).toBe(inChange);
    expect(answerFileOf(survey, paths([]))).toBeUndefined();
    // An output path that leaves the change folder is never looked at.
    expect(answerFileOf({ ...survey, output: "../../org-pack/x.yaml" }, paths([]))).toBeUndefined();
  });

  it("opens to its prompt, its answer and the app's Model runs screen", () => {
    const prompt = join(ROOT, survey.promptPath);
    const answer = join(
      ROOT,
      ".runs/survey-forge-ledger/run-20261023053215-0002/scan-settings.yaml",
    );
    const rows = runChildren(survey, paths([prompt, answer]));
    expect(rows.map((r) => r.label)).toEqual([
      "Open the prompt",
      "Open the answer",
      "Open in the app",
    ]);
    expect(rows[0]!.open).toEqual({ kind: "file", path: prompt });
    expect(rows[1]!.open).toEqual({ kind: "file", path: answer });
    expect(rows[2]!.open).toEqual({ kind: "app", hash: "#/runs?run=run-20261023053215-0002" });
  });

  it("reads an answer kept in the run record, when no file holds it", () => {
    const rows = runChildren(survey, paths([join(ROOT, survey.promptPath)]));
    expect(rows[1]!.command).toEqual({
      command: "atticus.openRunAnswer",
      args: ["run-20261023053215-0002"],
    });
  });

  it("offers no answer before there is one", () => {
    const rows = runChildren(needs, paths([join(ROOT, needs.promptPath)]));
    expect(rows.map((r) => r.label)).toEqual(["Open the prompt", "Open in the app"]);
  });

  it("says so when the prompt file is gone", () => {
    const rows = runChildren(needs, paths([]));
    expect(rows[0]!.open?.kind).toBe("missing");
  });

  it("links to one run on the app's screen", () => {
    expect(runHash("run-20261023053215-0002")).toBe("#/runs?run=run-20261023053215-0002");
  });
});
