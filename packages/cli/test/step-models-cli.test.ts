import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readRunSummary } from "@maycombhq/core";
import { stepClassOfNextStep, toRunSummary, type Run } from "@maycombhq/ai";
import { main } from "../src/main.js";

/**
 * ADR 0121 addendum: each hand-off says its kind of step and the organisation's model for it,
 * the plain hand-off names the model to pick, `handoff done --model` keeps the model that wrote
 * it, and `atticus runs` and `atticus next --json` say it. Invented Forge data, no network.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

const run = async (args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    args,
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    { quiet: true },
  );
  return { code, out, err };
};

const SETTINGS = `schemaVersion: 1
repo: forge-notes
exclude:
  - { path: "docs/**", why: a generated playground, at: "docs/playground.js:1" }
prefixes:
  - paths: ["src/main/java/**"]
    prefix: /notes-api
    why: server.servlet.context-path
    at: "src/main/resources/application.properties:3"
    value: /notes-api
`;

const RUNTIME = [
  "schemaVersion: 2",
  "assistants: { allowed: [copilot], default: copilot }",
  "models:",
  "  draft: copilot/claude-opus-4.5",
  "  critic: copilot/claude-sonnet-4.5",
  "",
].join("\n");

async function setup(runtime = RUNTIME) {
  const root = await mkdtemp(join(tmpdir(), "atticus-step-models-"));
  await cp(join(FIXTURES, "scan-settings/metarepo"), root, { recursive: true });
  await rm(join(root, "org-pack", "scan"), { recursive: true, force: true });
  await cp(join(FIXTURES, "scan-settings/repos"), join(root, "workspace"), { recursive: true });
  await writeFile(join(root, "org-pack", "runtime.yaml"), runtime);
  return root;
}

describe("a hand-off's kind of step and its model", () => {
  it("says the run's kind and runtime.yaml's model for it, and keeps the model that answered", async () => {
    const root = await setup();
    const first = await run([
      "scan",
      "survey",
      "forge-notes",
      "--handoff",
      "--json",
      "--root",
      root,
    ]);
    expect(first.code, first.err.join("\n")).toBe(0);
    const h = JSON.parse(first.out.join("\n")) as Record<string, unknown>;
    expect(h).toMatchObject({
      state: "handoff",
      stepClass: "draft",
      orgModel: "copilot/claude-opus-4.5",
    });
    await writeFile(join(root, h.resultFile as string), SETTINGS);
    const done = await run([...(h.doneArgs as string[]), "--model", "copilot/claude-opus-4.5"]);
    expect(done.code, done.err.join("\n")).toBe(0);
    const runJson = JSON.parse(
      await readFile(join(root, ".runs/survey-forge-notes", h.runId as string, "run.json"), "utf8"),
    ) as Run;
    expect(runJson).toMatchObject({ stepClass: "draft", model: "copilot/claude-opus-4.5" });
    const summary = readRunSummary(toRunSummary(runJson));
    expect(summary.success).toBe(true);
    expect(summary.data).toMatchObject({ stepClass: "draft", model: "copilot/claude-opus-4.5" });

    // atticus runs, its JSON and its words.
    const list = await run(["runs", "--json", "--root", root]);
    const runs = (JSON.parse(list.out.join("\n")) as { runs: Record<string, unknown>[] }).runs;
    expect(runs[0]).toMatchObject({ stepClass: "draft", model: "copilot/claude-opus-4.5" });
    const words = await run(["runs", "--root", root]);
    expect(words.out[0]).toContain("draft step on copilot/claude-opus-4.5");
    const show = await run(["runs", "show", h.runId as string, "--root", root]);
    expect(show.out).toContain(
      "Model: copilot/claude-opus-4.5, for a draft step (the kind of step picks the model).",
    );
  });

  it("names the model the run expects in the plain hand-off, the person's setting first", async () => {
    const root = await setup();
    const plain = await run(["scan", "survey", "forge-notes", "--handoff", "--root", root]);
    expect(plain.code, plain.err.join("\n")).toBe(0);
    expect(plain.out).toContain(
      "Model: this is a draft step, which runs on copilot/claude-opus-4.5 (runtime.yaml models.draft). Pick it in your assistant's model picker before you send the prompt.",
    );
    const { expectedModel, expectedLine } = await import("../src/handoff-flag.js");
    const runId = /\/(run-[0-9a-z-]+)\//.exec(plain.out[0]!)![1]!;
    const r = JSON.parse(
      await readFile(join(root, ".runs/survey-forge-notes", runId, "run.json"), "utf8"),
    ) as Run;
    const mine = await expectedModel(root, r, { ATTICUS_MODEL_DRAFT: "copilot/gpt-5-mini" });
    expect(mine).toEqual({ stepClass: "draft", model: "copilot/gpt-5-mini", from: "setting" });
    expect(expectedLine(mine!)).toContain("(your setting)");
    // Nothing named for the kind: no line, the assistant's own model as before.
    await writeFile(
      join(root, "org-pack", "runtime.yaml"),
      "schemaVersion: 2\nassistants: { allowed: [copilot], default: copilot }\n",
    );
    expect(await expectedModel(root, r, {})).toBeUndefined();
  });

  it("gives each AI step's kind and runtime.yaml's models in atticus next --json", async () => {
    const root = await setup();
    const n = await run(["next", "--json", "--root", root]);
    expect(n.code, n.err.join("\n")).toBe(0);
    type Step = { step: string; person?: boolean; stepClass?: string };
    const j = JSON.parse(n.out.join("\n")) as {
      next: Step;
      steps: Step[];
      orgModels?: Record<string, string>;
    };
    expect(j.orgModels).toEqual({
      draft: "copilot/claude-opus-4.5",
      critic: "copilot/claude-sonnet-4.5",
    });
    // Each AI step has its kind; a step that runs no AI (cloning the repos) and a person's
    // step have none.
    for (const s of j.steps)
      expect(s.stepClass, s.step).toBe(s.person ? undefined : stepClassOfNextStep(s.step));
    expect(j.next.step).toBe("sync");
    expect(j.next.stepClass).toBeUndefined();
    expect(stepClassOfNextStep("survey")).toBe("draft");
  });
});
