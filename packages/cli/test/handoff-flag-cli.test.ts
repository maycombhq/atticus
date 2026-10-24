import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { main } from "../src/main.js";

/**
 * `atticus <step> --handoff` (ADR 0086): the hand-off runtime, and only what Copilot needs
 * printed. The assistant's part is played by the test writing the result file.
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

/** The printed block: prompt, result file, and the two finishing commands. */
function block(out: string[]) {
  expect(out).toHaveLength(5);
  const prompt = /^Prompt: (\.runs\/[^/]+\/(run-[0-9a-z-]+)\/prompt\.md)$/.exec(out[0]!);
  expect(prompt, out[0]).not.toBeNull();
  const runId = prompt![2]!;
  const result = /^Result file: (.+)$/.exec(out[1]!)![1]!;
  expect(out[2]).toBe("When the result file is written, run:");
  return { prompt: prompt![1]!, runId, result, done: out[3]!.trim(), resume: out[4]!.trim() };
}

/** Run a printed `atticus ...` line through main, as the assistant would in a terminal. */
const argvOf = (line: string) =>
  [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!).slice(1);

describe("atticus scan survey --handoff", () => {
  it("prints the prompt, the result file and the finishing commands; done and resume write the settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-handoff-flag-"));
    await cp(join(FIXTURES, "scan-settings/metarepo"), root, { recursive: true });
    await rm(join(root, "org-pack", "scan"), { recursive: true, force: true });
    await cp(join(FIXTURES, "scan-settings/repos"), join(root, "workspace"), { recursive: true });

    const first = await run(["scan", "survey", "forge-notes", "--handoff", "--root", root]);
    expect(first.err).toEqual([]);
    expect(first.code).toBe(0);
    const b = block(first.out);
    expect(b.prompt).toBe(`.runs/survey-forge-notes/${b.runId}/prompt.md`);
    expect(b.result).toBe(`.runs/survey-forge-notes/${b.runId}/scan-settings.yaml`);
    expect(b.done).toBe(`atticus handoff done ${b.runId} --root "${root}"`);
    expect(b.resume).toBe(
      `atticus scan survey forge-notes --root "${root}" --handoff --resume ${b.runId}`,
    );
    // The prompt is HandoffRuntime's own, ending with the completion command.
    const prompt = await readFile(join(root, b.prompt), "utf8");
    expect(prompt).toContain(`Write the result to ${b.result}.`);
    expect(prompt.trimEnd().endsWith(`atticus handoff done ${b.runId}`)).toBe(true);

    // Resuming before the result is written says the run is still waiting, and how to finish.
    const early = await run(argvOf(b.resume));
    expect(early.out[0]).toBe(`Run ${b.runId} is still waiting for its result file.`);

    await writeFile(
      join(root, b.result),
      `schemaVersion: 1
repo: forge-notes
exclude:
  - { path: "docs/**", why: a generated playground, at: "docs/playground.js:1" }
prefixes:
  - paths: ["src/main/java/**"]
    prefix: /notes-api
    why: server.servlet.context-path
    at: "src/main/resources/application.properties:3"
    value: /notes-api
`,
    );
    const done = await run(argvOf(b.done));
    expect(done.code, done.err.join("\n")).toBe(0);
    const resumed = await run(argvOf(b.resume));
    expect(resumed.code, resumed.err.join("\n")).toBe(0);
    expect(resumed.out[0]).toBe(
      "Wrote org-pack/scan/forge-notes.yaml: 1 folder left out, 1 prefix.",
    );
    expect(await readFile(join(root, "org-pack/scan/forge-notes.yaml"), "utf8")).toContain(
      "prefix: /notes-api",
    );
  });

  it("prints the step's own output when it hands nothing off", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-handoff-flag-"));
    await cp(join(FIXTURES, "scan-settings/metarepo"), root, { recursive: true });
    await cp(join(FIXTURES, "scan-settings/repos"), join(root, "workspace"), { recursive: true });
    const r = await run(["scan", "survey", "forge-notes", "--handoff", "--root", root]);
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err[0]).toMatch(/already has scan settings/);
  });
});

describe("atticus spec draft --handoff", () => {
  const SPECS = join(FIXTURES, "specs");
  const ANSWER = readFileSync(join(SPECS, "answers", "forge-orders.yaml"), "utf8");

  async function setup() {
    const base = await mkdtemp(join(tmpdir(), "atticus-handoff-spec-"));
    const root = join(base, "meta");
    const repo = join(base, "forge-orders");
    await cp(join(SPECS, "repos", "forge-orders"), repo, { recursive: true });
    for (const r of parse(await readFile(join(SPECS, "catalog.yaml"), "utf8")) as unknown[]) {
      const p = parseRecord(r);
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      const file = join(root, "catalog", "generated", recordPath(p.record));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, serializeRecord(p.record));
    }
    await mkdir(join(root, "org-pack"), { recursive: true });
    return { root, repo };
  }

  it("hands the spec off, then a bad result hands back a new prompt, and a good one writes the flows", async () => {
    const { root, repo } = await setup();
    const first = await run(["spec", "draft", repo, "--handoff", "--root", root]);
    expect(first.code, first.err.join("\n")).toBe(0);
    const b = block(first.out);
    expect(b.prompt).toBe(`.runs/spec-forge-orders/${b.runId}/prompt.md`);
    expect(b.resume).toBe(
      `atticus spec draft "${repo}" --root "${root}" --handoff --resume ${b.runId}`.replace(
        `"${repo}"`,
        /^[\w./:@=+-]+$/.test(repo) ? repo : `"${repo}"`,
      ),
    );

    // A result that isn't a spec: the check fails, and the step hands off a new attempt.
    await writeFile(join(root, b.result), "flows: not a list\n");
    await run(argvOf(b.done));
    const again = await run(argvOf(b.resume));
    expect(again.code, again.err.join("\n")).toBe(0);
    const b2 = block(again.out);
    expect(b2.runId).not.toBe(b.runId);

    await writeFile(join(root, b2.result), ANSWER);
    expect((await run(argvOf(b2.done))).code).toBe(0);
    const resumed = await run(argvOf(b2.resume));
    expect(resumed.code, resumed.err.join("\n")).toBe(0);
    expect(resumed.out[0]).toBe("Wrote 2 flows in specs/forge-orders/ (template default@1):");
  });
});

describe("atticus <step> --handoff --json", () => {
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

  async function setup(withSettings = false) {
    const root = await mkdtemp(join(tmpdir(), "atticus-handoff-json-"));
    await cp(join(FIXTURES, "scan-settings/metarepo"), root, { recursive: true });
    if (!withSettings) await rm(join(root, "org-pack", "scan"), { recursive: true, force: true });
    await cp(join(FIXTURES, "scan-settings/repos"), join(root, "workspace"), { recursive: true });
    return root;
  }

  /** The one JSON object the command prints. */
  const json = (out: string[]) => JSON.parse(out.join("\n")) as Record<string, unknown>;

  it("prints the hand-off as one object, and the finished step's state once resumed", async () => {
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
    const h = json(first.out);
    expect(h.state).toBe("handoff");
    const runId = h.runId as string;
    expect(runId).toMatch(/^run-[0-9a-z-]+$/);
    expect(h.root).toBe(root);
    expect(h.promptFile).toBe(`.runs/survey-forge-notes/${runId}/prompt.md`);
    expect(h.resultFile).toBe(`.runs/survey-forge-notes/${runId}/scan-settings.yaml`);
    expect(h.doneCommand).toBe(`atticus handoff done ${runId} --root "${root}"`);
    expect(h.doneArgs).toEqual(["handoff", "done", runId, "--root", root]);
    expect(h.resumeCommand).toBe(
      `atticus scan survey forge-notes --root "${root}" --handoff --json --resume ${runId}`,
    );
    expect(h.resumeArgs).toEqual([
      "scan",
      "survey",
      "forge-notes",
      "--root",
      root,
      "--handoff",
      "--json",
      "--resume",
      runId,
    ]);
    expect(await readFile(join(root, h.promptFile as string), "utf8")).toContain(
      `Write the result to ${h.resultFile as string}.`,
    );

    // Resumed before the result is written: the same run, said to be still waiting.
    const early = json((await run(h.resumeArgs as string[])).out);
    expect(early).toMatchObject({ state: "handoff", runId, stillWaiting: true });

    await writeFile(join(root, h.resultFile as string), SETTINGS);
    expect((await run(h.doneArgs as string[])).code).toBe(0);
    const resumed = await run(h.resumeArgs as string[]);
    expect(resumed.code, resumed.err.join("\n")).toBe(0);
    const d = json(resumed.out);
    expect(d.state).toBe("done");
    expect(d.exitCode).toBe(0);
    expect((d.messages as string[])[0]).toBe(
      "Wrote org-pack/scan/forge-notes.yaml: 1 folder left out, 1 prefix.",
    );
    expect(d.questions).toEqual([]);
  });

  it("says question, with the question and its options, when the step raised one", async () => {
    const root = await setup();
    const h = json(
      (await run(["scan", "survey", "forge-notes", "--handoff", "--json", "--root", root])).out,
    );
    await writeFile(
      join(root, h.resultFile as string),
      `${SETTINGS}questions:
  - question: Is the playground under docs part of the product?
    options:
      - { label: "Yes", means: "the playground ships", changes: "docs/** is scanned" }
      - { label: "No", means: "it is only a demo", changes: "docs/** stays left out" }
    evidence: ["docs/playground.js:1"]
    scope: repo
`,
    );
    await run(h.doneArgs as string[]);
    const r = await run(h.resumeArgs as string[]);
    const q = json(r.out);
    expect(q.state).toBe("question");
    const questions = q.questions as { id: string; question: string; options: unknown[] }[];
    expect(questions).toHaveLength(1);
    expect(questions[0]!.id).toMatch(/^q-[0-9a-f]{12}$/);
    expect(questions[0]!.question).toBe("Is the playground under docs part of the product?");
    expect(questions[0]!.options).toHaveLength(2);
  });

  it("says stopped when the step ends without finishing, with its messages", async () => {
    const root = await setup(true);
    const r = await run(["scan", "survey", "forge-notes", "--handoff", "--json", "--root", root]);
    expect(r.code).toBe(1);
    const s = json(r.out);
    expect(s.state).toBe("stopped");
    expect(s.exitCode).toBe(1);
    expect((s.errors as string[])[0]).toMatch(/already has scan settings/);
  });

  it("says failed when the step can't run", async () => {
    const root = await setup();
    const r = await run(["scan", "survey", "no-such-repo", "--handoff", "--json", "--root", root]);
    expect(r.code).toBe(2);
    const f = json(r.out);
    expect(f.state).toBe("failed");
    expect((f.errors as string[])[0]).toMatch(/isn't a cloned repo/);
  });
});

describe("what a step reports as data (A4)", () => {
  it("gives a batched scan's pages left as pagesLeft, never read from its words", async () => {
    const { handoffStep } = await import("../src/handoff-flag.js");
    const root = await mkdtemp(join(tmpdir(), "atticus-facts-"));
    const out: string[] = [];
    const code = await handoffStep(
      root,
      ["knowledge", "scan", "--handoff", "--json"],
      { out: (l) => out.push(l), err: () => {} },
      async (_argv, io) => {
        io.out("Read 4 pages; the rest are for the next batch.");
        io.report?.({ pagesLeft: 3 });
        return 0;
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ state: "done", pagesLeft: 3 });
  });
});
