import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  actionFor,
  answerQuestion,
  argsOf,
  chatQuery,
  readNext,
  readOpenQuestions,
  STEP_COMMANDS,
} from "../src/atticus";
import { cliRunner, commandText, parseJson, resolveCommand, shimTarget } from "../src/cli";
import { block } from "../src/describe";
import { runStep } from "../src/runner";
import type { StepModel } from "../src/types";

/** The deterministic commands the extension reads, the command line it starts, and its words (ADR 0090). */

const FIXTURES = join(__dirname, "../../../fixtures");
const BIN = join(__dirname, "../../cli/dist/bin.js");

async function metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-vscode-"));
  await cp(join(FIXTURES, "scan-settings/metarepo"), root, { recursive: true });
  await rm(join(root, "org-pack", "scan"), { recursive: true, force: true });
  await cp(join(FIXTURES, "scan-settings/repos"), join(root, "workspace"), { recursive: true });
  return root;
}

const QUESTION = `schemaVersion: 1
repo: forge-notes
exclude: []
prefixes: []
questions:
  - question: Is the playground under docs part of the product?
    options:
      - { label: "Yes", means: "the playground ships", changes: "docs/** is scanned" }
      - { label: "No", means: "it is only a demo", changes: "docs/** stays left out" }
    evidence: ["docs/playground.js:1"]
    scope: repo
`;

const never = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

describe("atticus next and questions, through the real command line", { timeout: 120_000 }, () => {
  it("reads the next step, the open questions, and answers one", async () => {
    const root = await metarepo();
    const cli = cliRunner({ atticusPath: BIN, nodePath: process.execPath, cwd: root });
    const n = await readNext(cli, root);
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    // The fixture lists no clones in a manifest, so the first step is a sync, run as it is.
    expect(n.value.next?.step).toBe("sync");
    expect(actionFor(n.value.next!)).toEqual({ kind: "run", args: ["workspace", "sync"] });

    const model: StepModel = {
      name: "Fake",
      maxInputTokens: 200_000,
      countTokens: async (t) => t.length / 4,
      send: async () =>
        (async function* () {
          yield QUESTION;
        })(),
    };
    const end = await runStep(
      ["scan", "survey", "forge-notes"],
      { root, cli, model: async () => model },
      never,
    );
    expect(end.state).toBe("question");

    const q = await readOpenQuestions(cli, root);
    expect(q.ok && q.value.length).toBe(1);
    if (!q.ok) return;
    const a = await answerQuestion(cli, root, q.value[0]!.id, { option: 2 });
    expect(a.ok, a.lines.join("\n")).toBe(true);
    expect(a.lines.at(-1)).toBe("Next: atticus scan survey forge-notes --force");
    const after = await readOpenQuestions(cli, root);
    expect(after.ok && after.value).toEqual([]);
  });

  it("says why when the command line can't be started", async () => {
    const cli = cliRunner({
      atticusPath: join(tmpdir(), "no-such-atticus.js"),
      nodePath: process.execPath,
      cwd: tmpdir(),
    });
    const n = await readNext(cli, tmpdir());
    expect(n.ok).toBe(false);
  });
});

describe("what a next step becomes", { timeout: 120_000 }, () => {
  const step = (o: Partial<Parameters<typeof actionFor>[0]>) => ({
    step: "x",
    command: "atticus x",
    why: "",
    ...o,
  });
  it("runs AI steps, shows a person's steps, and runs the rest", () => {
    expect(
      actionFor(
        step({ step: "spec", command: "atticus spec draft forge-notes", repo: "forge-notes" }),
      ),
    ).toEqual({
      kind: "ai",
      args: ["spec", "draft", "forge-notes"],
      spec: "forge-notes",
    });
    expect(
      actionFor(step({ step: "knowledge", command: "atticus knowledge scan --source wiki" })),
    ).toEqual({
      kind: "ai",
      args: ["knowledge", "scan", "--source", "wiki"],
    });
    // ADR 0113: the fast path's one step runs with Copilot like the stages.
    expect(actionFor(step({ step: "small", command: "atticus change small fix-label" }))).toEqual({
      kind: "ai",
      args: ["change", "small", "fix-label"],
    });
    // The critic's AI lenses, one at a time; its stats and --resume aren't AI steps.
    expect(
      actionFor(step({ step: "critic", command: "atticus critic add-transfer-limit" })),
    ).toEqual({ kind: "ai", args: ["critic", "add-transfer-limit"] });
    expect(actionFor(step({ step: "critic", command: "atticus critic stats" }))).toEqual({
      kind: "run",
      args: ["critic", "stats"],
    });
    expect(
      actionFor(step({ step: "answer", command: "atticus questions list --state open" })),
    ).toEqual({ kind: "answer" });
    expect(
      actionFor(step({ step: "accept", command: "atticus scan verify a --accept", person: true }))
        .kind,
    ).toBe("person");
    expect(
      actionFor(step({ step: "discover", command: "atticus repos discover <folder>" })).kind,
    ).toBe("person");
    expect(actionFor(step({ step: "scan", command: "atticus scan" }))).toEqual({
      kind: "run",
      args: ["scan"],
    });
    // ADR 0124 §4: the batched read of a repo, one batch a hand-off; its estimate and the
    // rendered map only read.
    expect(actionFor(step({ step: "map", command: "atticus map forge-notes" }))).toEqual({
      kind: "ai",
      args: ["map", "forge-notes"],
    });
    for (const command of [
      "atticus map forge-notes --estimate",
      "atticus map render forge-notes",
      "atticus map --help",
    ])
      expect(actionFor(step({ step: "map", command })).kind, command).toBe("run");
    expect(argsOf('atticus change new "Add a fraud check" --type feature')).toEqual([
      "change",
      "new",
      "Add a fraud check",
      "--type",
      "feature",
    ]);
  });
});

describe("starting atticus", { timeout: 120_000 }, () => {
  it("runs a .js with node, and a plain command as it is off Windows", () => {
    expect(
      resolveCommand({
        atticusPath: "/opt/atticus/bin.js",
        cwd: "/",
        nodePath: "node",
        platform: "linux",
      }),
    ).toMatchObject({
      file: "node",
      shell: false,
    });
    expect(resolveCommand({ atticusPath: "atticus", cwd: "/", platform: "linux" })).toEqual({
      file: "atticus",
      prefix: [],
      shell: false,
    });
  });

  it("reads the bin.js out of a Windows command shim, so no shell is needed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-shim-"));
    const js = join(dir, "node_modules", "@maycombhq", "cli", "dist", "bin.js");
    await mkdir(join(js, ".."), { recursive: true });
    await writeFile(js, "");
    await writeFile(
      join(dir, "atticus.cmd"),
      '@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@maycombhq\\cli\\dist\\bin.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\node_modules\\@maycombhq\\cli\\dist\\bin.js" %*\r\n)\r\n',
    );
    if (process.platform === "win32") {
      expect(shimTarget(join(dir, "atticus.cmd"))).toBe(js);
      expect(
        resolveCommand({
          atticusPath: "atticus",
          cwd: dir,
          platform: "win32",
          env: { PATH: dir, PATHEXT: ".EXE;.CMD" },
        }),
      ).toEqual({
        file: "node",
        prefix: [js],
        shell: false,
      });
    } else expect(shimTarget(join(dir, "missing.cmd"))).toBeUndefined();
  });

  it("quotes what it logs, and reads the one JSON object", () => {
    expect(commandText(["questions", "answer", "q-1", "--text", "only a demo"])).toBe(
      'atticus questions answer q-1 --text "only a demo"',
    );
    expect(parseJson<{ a: number }>('warning\n{ "a": 1 }\n')).toEqual({ a: 1 });
    expect(parseJson("no json")).toBeUndefined();
  });

  it("puts what Atticus printed in a fence nothing inside can close", () => {
    expect(block(["a ``` b"])).toBe("\n````text\na ``` b\n````\n");
  });
});

describe("the steps @atticus and the palette run (Phase D)", () => {
  it("reads a repo with map, and reviews a change with the critic", () => {
    expect(STEP_COMMANDS.map.args("forge-notes")).toEqual(["map", "forge-notes"]);
    expect(STEP_COMMANDS.map.target).toBe("repo");
    expect(STEP_COMMANDS.critic.args("add-note-tags")).toEqual(["critic", "add-note-tags"]);
    expect(STEP_COMMANDS.critic.target).toBe("change");
    // Each one is an AI step the runner takes, as atticus next would name it.
    for (const s of Object.values(STEP_COMMANDS))
      expect(
        actionFor({ step: "x", why: "", command: `atticus ${s.args("t").join(" ")}` }).kind,
      ).toBe("ai");
  });
});

describe("the chat command a next step runs as (Phase D)", () => {
  const step = (command: string, o: Record<string, string> = {}) => ({
    step: "x",
    why: "",
    command,
    ...o,
  });
  it("names the @atticus step for each step it runs with the editor's model", () => {
    expect(chatQuery(step("atticus map forge-notes"))).toBe("@atticus /map forge-notes");
    // ADR 0124: /verify checks the facts the assistant wrote; the old scan's check is /scanverify.
    expect(chatQuery(step("atticus verify forge-notes"))).toBe("@atticus /verify forge-notes");
    expect(chatQuery(step("atticus verify forge-notes --write"))).toBe(
      "@atticus /verify forge-notes --write",
    );
    expect(chatQuery(step("atticus scan verify forge-notes"))).toBe(
      "@atticus /scanverify forge-notes",
    );
    expect(chatQuery(step("atticus change feature add-note-tags"))).toBe(
      "@atticus /feature add-note-tags",
    );
    expect(chatQuery(step("atticus critic add-note-tags"))).toBe("@atticus /critic add-note-tags");
    expect(chatQuery(step("atticus questions list --state open", { step: "answer" }))).toBe(
      "@atticus /answer",
    );
    // A task starts in Copilot's agent mode with its context (ADR 0113).
    expect(
      chatQuery(
        step("atticus task run add-note-tags T2", { step: "task", change: "add-note-tags" }),
      ),
    ).toBe("@atticus /task add-note-tags T2");
  });

  it("names none for a step the chat doesn't run", () => {
    expect(chatQuery(step("atticus scan"))).toBeUndefined();
    expect(chatQuery(step("atticus critic stats"))).toBeUndefined();
  });
});
