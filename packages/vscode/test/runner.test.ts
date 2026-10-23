import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliRunner } from "../src/cli";
import { describeEnd } from "../src/describe";
import { runSpec, runStep, type StepEnd } from "../src/runner";
import {
  ModelRefused,
  type Cancel,
  type ChatTurnMessage,
  type ModelTool,
  type ModelTurn,
  type StepModel,
} from "../src/types";

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
  readonly name: string = "Fake model";
  readonly prompts: string[][] = [];
  constructor(
    private readonly answers: (string | ((token: Cancel) => AsyncIterable<string>))[],
    readonly maxInputTokens = 200_000,
    private readonly refuse = false,
    /** Characters a token, as this model's tokenizer counts them. */
    private readonly charsPerToken = 4,
  ) {}
  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / this.charsPerToken);
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

/** A fake model that calls tools: canned turns in order, every request it was sent. */
class ToolModel extends FakeModel {
  override readonly name: string = "Fake tool model";
  readonly requests: { messages: ChatTurnMessage[]; tools: ModelTool[] }[] = [];
  constructor(private readonly turns: ModelTurn[]) {
    super([]);
  }
  async chat(messages: ChatTurnMessage[], tools: ModelTool[]): Promise<ModelTurn> {
    this.requests.push({ messages: structuredClone(messages), tools });
    const t = this.turns.shift();
    if (!t) throw new Error("no more canned turns");
    return t;
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

  it("says before anything is sent when the step can't fit the model's limit (ADR 0112)", async () => {
    const root = await metarepo();
    const model = new FakeModel([SETTINGS], 1500);
    const { d } = deps(root, model);
    const end = await runStep(SURVEY, d, cancelSource());
    expect(model.prompts).toHaveLength(0);
    expect(end).toMatchObject({ state: "failed" });
    if (end.state !== "failed") return;
    expect(end.errors[0]).toMatch(
      /^atticus scan survey forge-notes can't fit its smallest useful prompt in the model: it needs about \d+ tokens \(its instructions\), and a model of 1500 tokens leaves 725 for the prompt\./,
    );
  });

  it("still checks the model's own count, and sends nothing when it is over (the last check)", async () => {
    const root = await metarepo();
    // A tokenizer far denser than the step's count (one character a token).
    const model = new FakeModel([SETTINGS], 4000, false, 1);
    const { d } = deps(root, model);
    const end = await runStep(SURVEY, d, cancelSource());
    expect(end.state).toBe("too-long");
    expect(model.prompts).toHaveLength(0);
    if (end.state !== "too-long") return;
    expect(end.tokens).toBeGreaterThan(4000);
    expect(end.max).toBe(4000);
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

  // ADR 0107 addendum: Copilot's model may ask for more through the language model API's tools;
  // each call runs as atticus context call, and the run's record keeps it.
  it("runs the model's tool calls through atticus and keeps them in the run's record", async () => {
    const root = await metarepo();
    const model = new ToolModel([
      { text: "", calls: [{ id: "c1", name: "search", input: { text: "notes api" } }] },
      { text: "", calls: [{ id: "c2", name: "show", input: { id: "no-such-record" } }] },
      { text: SETTINGS, calls: [] },
    ]);
    const { d, progress } = deps(root, model);
    const end = await runStep(SURVEY, d, cancelSource());
    expect(end.state, JSON.stringify(end)).toBe("done");
    expect(model.requests).toHaveLength(3);
    expect(model.requests[0]!.tools.map((t) => t.name)).toEqual([
      "search",
      "show",
      "walk",
      "show_code",
      // ADR 0118: the model's code search, offered to Copilot's model through vscode.lm too.
      "grep",
      "files",
      "outline",
    ]);
    // The second request carried the first call's result back as a tool result, wrapped as data.
    const back = model.requests[1]!.messages.at(-1)!;
    expect(back.role).toBe("tool");
    if (back.role === "tool") expect(back.results[0]!.text).toMatch(/^<atticus-data /);
    expect(progress.some((p) => /Round 1 of tools: Fake tool model asked for search/.test(p))).toBe(
      true,
    );
    const run = JSON.parse(
      await readFile(join(root, end.files!.prompt!.replace(/prompt\.md$/, "run.json")), "utf8"),
    ) as {
      tools?: { offered: string[]; calls: { round: number; name: string; error?: boolean }[] };
    };
    expect(run.tools?.offered).toContain("show_code");
    expect(run.tools?.calls.map((c) => [c.round, c.name, c.error ?? false])).toEqual([
      [1, "search", false],
      [2, "show", true],
    ]);
  });

  it("stops offering tools at the rounds cap and asks for the answer", async () => {
    const root = await metarepo();
    const always = { text: "", calls: [{ id: "c", name: "search", input: { text: "x" } }] };
    const model = new ToolModel([
      always,
      always,
      always,
      always,
      always,
      always,
      { text: SETTINGS, calls: [] },
    ]);
    const { d } = deps(root, model);
    const end = await runStep(SURVEY, d, cancelSource());
    expect(end.state, JSON.stringify(end)).toBe("done");
    // Six rounds of calls, then the seventh request says no more.
    expect(model.requests).toHaveLength(7);
    const last = model.requests[6]!.messages.at(-1)!;
    expect(last.role === "user" && last.text).toMatch(/^No more tool calls/);
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

// ADR 0106: a knowledge scan too big for one prompt of the model is read in batches that fit.
describe("a knowledge scan in batches", () => {
  const never: Cancel = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} }),
  } as unknown as Cancel;
  it("passes the model's limit, and runs the next batch while pages are left (ADR 0106, 0112)", async () => {
    const calls: string[][] = [];
    let n = 0;
    const cli = async (argv: string[]) => {
      calls.push(argv);
      n++;
      const left =
        n === 1
          ? ["3 pages left to read: run atticus knowledge scan again for the next batch."]
          : [];
      return {
        code: 0,
        stdout: JSON.stringify({
          state: "done",
          exitCode: 0,
          messages: [`Read batch ${n}.`, ...left],
          errors: [],
          questions: [],
        }),
        stderr: "",
      };
    };
    const progress: string[] = [];
    const model = new FakeModel([], 12_078);
    const end = await runStep(
      ["knowledge", "scan", "--source", "forge-eng"],
      {
        root: tmpdir(),
        cli: cli as never,
        model: async () => model,
        progress: (p) => progress.push(p),
      },
      never,
    );
    // The scan sizes its batch from the limit itself (ADR 0112).
    expect(calls.map((c) => c.slice(0, 6))).toEqual([
      ["knowledge", "scan", "--source", "forge-eng", "--max-tokens", "12078"],
      ["knowledge", "scan", "--source", "forge-eng", "--max-tokens", "12078"],
    ]);
    expect(end).toMatchObject({ state: "done" });
    expect((end as { messages: string[] }).messages[0]).toBe(
      "Read the pages in 2 batches, each fitting Fake model (12078 tokens).",
    );
    expect(progress).toContain("3 pages left to read: batch 2.");
  });

  it("leaves a scan that is already batched as it is, and gives every step the model's limit (ADR 0112)", async () => {
    const calls: string[][] = [];
    const cli = async (argv: string[]) => {
      calls.push(argv);
      return {
        code: 0,
        stdout: JSON.stringify({
          state: "done",
          exitCode: 0,
          messages: [],
          errors: [],
          questions: [],
        }),
        stderr: "",
      };
    };
    const d = { root: tmpdir(), cli: cli as never, model: async () => new FakeModel([], 12_078) };
    await runStep(["knowledge", "scan", "--batch-tokens", "900"], d, never);
    await runStep(["scan", "survey", "forge-notes"], d, never);
    await runStep(["change", "needs", "add-fraud-check", "--max-tokens", "4000"], d, never);
    expect(calls.map((c) => c.slice(0, 8))).toEqual([
      [
        "knowledge",
        "scan",
        "--batch-tokens",
        "900",
        "--max-tokens",
        "12078",
        "--handoff",
        "--json",
      ],
      ["scan", "survey", "forge-notes", "--max-tokens", "12078", "--handoff", "--json", "--root"],
      // A limit already given stays.
      [
        "change",
        "needs",
        "add-fraud-check",
        "--max-tokens",
        "4000",
        "--handoff",
        "--json",
        "--root",
      ],
    ]);
  });

  it("says what a step said when its smallest prompt can't fit the model, before any is sent (ADR 0112)", async () => {
    const message =
      "atticus spec draft forge-orders can't fit its smallest useful prompt in the model: it needs about 9100 tokens (its instructions and 4-catalog), and a model of 12078 tokens leaves 8658 for the prompt. Use a model with a bigger limit (atticus.model in VS Code, or adapters.model in runtime.yaml).";
    const cli = async () => ({
      code: 2,
      stdout: JSON.stringify({
        state: "failed",
        exitCode: 2,
        messages: [],
        errors: [message],
        questions: [],
      }),
      stderr: "",
    });
    const model = new FakeModel([], 12_078);
    const end = await runStep(
      ["spec", "draft", "forge-orders"],
      { root: tmpdir(), cli: cli as never, model: async () => model },
      never,
    );
    expect(end).toMatchObject({ state: "failed", errors: [message] });
    expect(model.prompts).toEqual([]);
  });
});

// ADR 0115: a stage hands its draft off, then each of the critic's AI lenses that reviews it.
describe("a stage whose critic lenses are handed off too", () => {
  it("answers each lens in turn; a lens's first offer isn't a round of the step", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-vscode-lens-"));
    const runs = ["run-draft", "run-business", "run-architecture"];
    for (const r of runs) {
      await mkdir(join(root, ".runs/add-fraud-check", r), { recursive: true });
      await writeFile(join(root, ".runs/add-fraud-check", r, "prompt.md"), `The prompt of ${r}.`);
    }
    const handoff = (runId: string, lens?: string) => ({
      state: "handoff",
      runId,
      ...(lens ? { lens } : {}),
      promptFile: `.runs/add-fraud-check/${runId}/prompt.md`,
      resultFile: `.runs/add-fraud-check/${runId}/${lens ? `findings-${lens}.yaml` : "feature-answer.yaml"}`,
      doneArgs: ["handoff", "done", runId],
      resumeArgs: [
        "change",
        "feature",
        "add-fraud-check",
        "--handoff",
        "--json",
        "--resume",
        runId,
      ],
    });
    const steps = [
      handoff("run-draft"),
      handoff("run-business", "business"),
      handoff("run-architecture", "architecture"),
      {
        state: "done",
        exitCode: 0,
        messages: ["The feature stage is done."],
        errors: [],
        questions: [],
      },
    ];
    const calls: string[][] = [];
    const cli = async (argv: string[]) => {
      calls.push(argv);
      if (argv[0] === "handoff") return { code: 0, stdout: "", stderr: "", cancelled: false };
      return { code: 0, stdout: JSON.stringify(steps.shift()), stderr: "", cancelled: false };
    };
    const model = new FakeModel(["summary: placed\n", "findings: []\n", "findings: []\n"]);
    const progress: string[] = [];
    const end = await runStep(
      ["change", "feature", "add-fraud-check"],
      { root, cli, model: async () => model, maxRounds: 1, progress: (p) => progress.push(p) },
      cancelSource(),
    );
    expect(end.state, JSON.stringify(end)).toBe("done");
    expect(model.prompts.map((p) => p[1])).toEqual(runs.map((r) => `The prompt of ${r}.`));
    expect(
      await readFile(
        join(root, ".runs/add-fraud-check/run-business/findings-business.yaml"),
        "utf8",
      ),
    ).toBe("findings: []\n");
    expect(calls.filter((c) => c[0] === "handoff").map((c) => c[2])).toEqual(runs);
    expect(progress).toContain(
      "The critic's business lens: Atticus handed off run run-business, to review what the step wrote.",
    );
  });

  it("a lens offered again counts as a round, so a lens that never passes can't loop for ever", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-vscode-lens-"));
    await mkdir(join(root, ".runs/c/run-b"), { recursive: true });
    await writeFile(join(root, ".runs/c/run-b/prompt.md"), "The prompt.");
    const again = {
      state: "handoff",
      runId: "run-b",
      lens: "business",
      stillWaiting: true,
      promptFile: ".runs/c/run-b/prompt.md",
      resultFile: ".runs/c/run-b/findings-business.yaml",
      doneArgs: ["handoff", "done", "run-b"],
      resumeArgs: ["change", "feature", "c", "--handoff", "--json", "--resume", "run-b"],
    };
    const cli = async (argv: string[]) =>
      argv[0] === "handoff"
        ? { code: 1, stdout: "", stderr: "findings-business.yaml isn't YAML", cancelled: false }
        : { code: 0, stdout: JSON.stringify(again), stderr: "", cancelled: false };
    const model = new FakeModel(["x", "x", "x", "x"]);
    const end = await runStep(
      ["change", "feature", "c"],
      { root, cli, model: async () => model, maxRounds: 2 },
      cancelSource(),
    );
    expect(end.state).toBe("too-many-rounds");
  });
});
