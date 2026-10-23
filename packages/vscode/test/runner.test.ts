import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliRunner } from "../src/cli";
import { describeEnd } from "../src/describe";
import { runSpec, runStep, type StepEnd } from "../src/runner";
import { ModelRefused, type Cancel, type StepModel } from "../src/types";

/**
 * The runner's loop (ADR 0090) against the real `atticus` command line in a temp metarepo, with
 * a fake model in place of vscode.lm: it returns canned answers and records the prompts.
 */

const HERE = __dirname;
const FIXTURES = join(HERE, "../../../fixtures");
const BIN = join(HERE, "../../cli/dist/bin.js");

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

const QUESTION = `${SETTINGS}questions:
  - question: Is the playground under docs part of the product?
    options:
      - { label: "Yes", means: "the playground ships", changes: "docs/** is scanned" }
      - { label: "No", means: "it is only a demo", changes: "docs/** stays left out" }
    evidence: ["docs/playground.js:1"]
    scope: repo
`;

/** A cancellation token the test can trip. */
function cancelSource() {
  const listeners: (() => unknown)[] = [];
  const token: Cancel & { cancel(): void } = {
    isCancellationRequested: false,
    onCancellationRequested(l) {
      listeners.push(l);
      return { dispose: () => undefined };
    },
    cancel() {
      (this as { isCancellationRequested: boolean }).isCancellationRequested = true;
      for (const l of listeners) l();
    },
  };
  return token;
}

/** The fake model: canned answers in order, the prompts it was sent. */
class FakeModel implements StepModel {
  readonly name = "Fake model";
  readonly prompts: string[][] = [];
  constructor(
    private readonly answers: (string | ((token: Cancel) => AsyncIterable<string>))[],
    readonly maxInputTokens = 200_000,
    private readonly refuse = false,
  ) {}
  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / 4);
  }
  async send(messages: string[], token: Cancel): Promise<AsyncIterable<string>> {
    if (this.refuse) throw new ModelRefused("The person said no.");
    this.prompts.push(messages);
    const a = this.answers.shift();
    if (a === undefined) throw new Error("no more canned answers");
    if (typeof a !== "string") return a(token);
    return (async function* () {
      // Streamed in two parts, as a real model sends it.
      yield a.slice(0, 20);
      yield a.slice(20);
    })();
  }
}

async function metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-vscode-"));
  await cp(join(FIXTURES, "scan-settings/metarepo"), root, { recursive: true });
  await rm(join(root, "org-pack", "scan"), { recursive: true, force: true });
  await cp(join(FIXTURES, "scan-settings/repos"), join(root, "workspace"), { recursive: true });
  return root;
}

function deps(root: string, model: StepModel | undefined) {
  const log: string[] = [];
  const progress: string[] = [];
  const cli = cliRunner({
    atticusPath: BIN,
    nodePath: process.execPath,
    cwd: root,
    log: (l) => log.push(l),
  });
  return {
    log,
    progress,
    d: { root, cli, model: async () => model, progress: (p: string) => progress.push(p) },
  };
}

const SURVEY = ["scan", "survey", "forge-notes"];

describe("the step runner", { timeout: 120_000 }, () => {
  it("runs a step that passes after one answer", async () => {
    const root = await metarepo();
    const model = new FakeModel([SETTINGS]);
    const { d, log } = deps(root, model);
    const end = await runStep(SURVEY, d, cancelSource());
    expect(end.state, JSON.stringify(end)).toBe("done");
    expect(model.prompts).toHaveLength(1);
    // The prompt Atticus wrote is what the model got, after the extension's one line.
    expect(model.prompts[0]![0]).toMatch(/only the content of the result file/);
    expect(model.prompts[0]![1]).toMatch(/Write the result to \.runs\/survey-forge-notes\//);
    expect(await readFile(join(root, "org-pack/scan/forge-notes.yaml"), "utf8")).toContain(
      "prefix: /notes-api",
    );
    // Every command run is logged with its exit code: the step, handoff done, the resume.
    expect(log.filter((l) => l.startsWith("> atticus "))).toHaveLength(3);
    expect(log.some((l) => /^> atticus handoff done run-/.test(l))).toBe(true);
    expect(log.filter((l) => l === "exit 0")).toHaveLength(3);
    expect(describeEnd(end)[0]).toMatch(/^The step is done/);
    // ADR 0106: the last round's prompt and answer, for Open the prompt and Open the answer.
    expect(end.files?.runId).toMatch(/^run-/);
    expect(end.files?.prompt).toMatch(/^\.runs\/survey-forge-notes\/run-[^/]+\/prompt\.md$/);
    expect(existsSync(join(root, end.files!.prompt!))).toBe(true);
    expect(await readFile(join(root, end.files!.answer!), "utf8")).toBe(SETTINGS);
  });

  it("sends the step's new prompt when Atticus hands the answer back, and passes on the second", async () => {
    const root = await metarepo();
    const model = new FakeModel(["exclude: 5\n", SETTINGS]);
    const { d } = deps(root, model);
    const end = await runStep(SURVEY, d, cancelSource());
    expect(end.state, JSON.stringify(end)).toBe("done");
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]![1]).toMatch(/failed these checks/);
    if (end.state === "done") expect(end.rounds).toBe(2);
    // The files are the second round's: its prompt holds what the checks handed back.
    expect(await readFile(join(root, end.files!.prompt!), "utf8")).toMatch(/failed these checks/);
    expect(await readFile(join(root, end.files!.answer!), "utf8")).toBe(SETTINGS);
  });

  it("stops at a question for a person, and says what it is", async () => {
    const root = await metarepo();
    const { d } = deps(root, new FakeModel([QUESTION]));
    const end = await runStep(SURVEY, d, cancelSource());
    expect(end.state).toBe("question");
    if (end.state !== "question") return;
    expect(end.questions).toHaveLength(1);
    expect(end.questions[0]!.question).toBe("Is the playground under docs part of the product?");
    expect(end.questions[0]!.options.map((o) => o.label)).toEqual(["Yes", "No"]);
    const words = describeEnd(end).join("\n");
    expect(words).toMatch(/stopped for a person: 1 question/);
  });

  it("says plainly when the prompt is longer than the model takes, and sends nothing", async () => {
    const root = await metarepo();
    const model = new FakeModel([SETTINGS], 50);
    const { d } = deps(root, model);
    const end = await runStep(SURVEY, d, cancelSource());
    expect(end.state).toBe("too-long");
    expect(model.prompts).toHaveLength(0);
    if (end.state !== "too-long") return;
    expect(end.tokens).toBeGreaterThan(50);
    expect(end.max).toBe(50);
    expect(existsSync(join(root, end.resultFile))).toBe(false);
    expect(describeEnd(end).join("\n")).toMatch(/Nothing was cut and nothing was sent/);
  });

  it("stops when cancelled while the model answers, and writes nothing", async () => {
    const root = await metarepo();
    const source = cancelSource();
    const model = new FakeModel([
      (token) =>
        (async function* () {
          yield "schemaVersion: 1\n";
          source.cancel();
          if (!token.isCancellationRequested) throw new Error("token not tripped");
          yield "repo: forge-notes\n";
        })(),
    ]);
    const { d, log } = deps(root, model);
    const end = await runStep(SURVEY, d, source);
    expect(end.state).toBe("cancelled");
    if (end.state !== "cancelled") return;
    expect(end.resumeCommand).toMatch(/--resume run-/);
    expect(existsSync(join(root, end.resultFile!))).toBe(false);
    // Only the step itself ran: no handoff done, no resume.
    expect(log.filter((l) => l.startsWith("> atticus "))).toHaveLength(1);
  });

  it("stops when the person doesn't allow the model, and says how to go on", async () => {
    const root = await metarepo();
    const { d } = deps(root, new FakeModel([], 200_000, true));
    const end = await runStep(SURVEY, d, cancelSource());
    expect(end.state).toBe("no-consent");
    expect(describeEnd(end).join("\n")).toMatch(/didn't allow/);
  });

  it("stops with the step's message when the step doesn't start", async () => {
    const root = await metarepo();
    const { d } = deps(root, new FakeModel([]));
    const end: StepEnd = await runStep(["scan", "survey", "no-such-repo"], d, cancelSource());
    expect(end.state).toBe("failed");
    expect(describeEnd(end).join("\n")).toMatch(/isn't a cloned repo/);
  });

  it("says so when no model is there", async () => {
    const root = await metarepo();
    const { d } = deps(root, undefined);
    const end = await runStep(SURVEY, d, cancelSource());
    expect(end.state).toBe("no-model");
    // The prompt is written; no answer is, so there is none to open.
    expect(end.files?.prompt).toMatch(/prompt\.md$/);
    expect(end.files?.answer).toBeUndefined();
  });

  it("carries no files when the step never handed a prompt off", async () => {
    const root = await metarepo();
    const { d } = deps(root, new FakeModel([]));
    const end = await runStep(["scan", "survey", "no-such-repo"], d, cancelSource());
    expect(end.files).toBeUndefined();
  });
});

describe("runSpec", { timeout: 120_000 }, () => {
  it("runs the check after a draft that is done", async () => {
    const calls: string[][] = [];
    const end = await runSpec(
      "forge-orders",
      {
        root: "/meta",
        model: async () => undefined,
        cli: async (args) => {
          calls.push(args);
          if (args[0] === "spec" && args[1] === "draft")
            return {
              code: 0,
              stdout: JSON.stringify({
                state: "done",
                exitCode: 0,
                messages: ["Wrote 2 flows"],
                errors: [],
                questions: [],
              }),
              stderr: "",
              cancelled: false,
            };
          return { code: 0, stdout: "The spec passes.", stderr: "", cancelled: false };
        },
      },
      cancelSource(),
    );
    expect(end.state).toBe("done");
    expect(calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["spec draft", "spec check"]);
    if (end.state === "done") expect(end.messages).toContain("The spec passes.");
  });
});
