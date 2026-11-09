import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventHub, Signal, type ServerContext } from "@maycombhq/server";
import { answerComplete, dueRuns, startAutoDone } from "../src/handoff-autodone.js";
import { keepResume } from "../src/handoff-resume.js";

/**
 * ADR 0189: the answer arrives by itself. The server checks a waiting hand-off's answer once its
 * file is complete, as Done does, never on a half-written file and never twice.
 */

const CHANGE = "add-gift-note";

async function metarepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), "atticus-autodone-"));
}

async function run(
  root: string,
  id: string,
  o: {
    agent?: string;
    state?: string;
    output?: string;
    batch?: string;
    parts?: { name: string; runId: string }[];
  } = {},
) {
  const dir = join(root, ".runs", CHANGE, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      runId: id,
      request: {
        change: CHANGE,
        agent: { id: o.agent ?? "feature-placer" },
        pack: { prompt: "p" },
        outputPath: o.output ?? "feature-answer.yaml",
        outputIn: "run",
      },
      runtime: "hand-off",
      state: o.state ?? "waiting",
      attempt: 1,
      startedAt: "2026-11-09T09:00:00Z",
      errors: [],
      ...(o.batch ? { batch: o.batch } : {}),
      ...(o.parts ? { parts: o.parts } : {}),
    }),
  );
  return dir;
}

const old = async (file: string) => {
  const t = new Date(Date.now() - 60_000);
  await utimes(file, t, t);
};

describe("an answer is complete", () => {
  it("when YAML parses, a change draft has its proposal, a batch every part, and anything else isn't empty", () => {
    const r = (outputPath: string, parts?: { name: string; runId: string }[]) =>
      ({ run: { request: { outputPath }, ...(parts ? { parts } : {}) } }) as never;
    expect(answerComplete(r("feature-answer.yaml"), "summary: ok\nflows: []\n")).toBe(true);
    expect(answerComplete(r("feature-answer.yaml"), "summary: [half")).toBe(false);
    expect(answerComplete(r("feature-answer.yaml"), "")).toBe(false);
    expect(answerComplete(r("change-draft.md"), "# Proposal\n")).toBe(false);
    expect(answerComplete(r("change-draft.md"), "=== proposal.md\n# Proposal\n")).toBe(true);
    const parts = [
      { name: "true", runId: "run-1" },
      { name: "complete", runId: "run-2" },
    ];
    expect(answerComplete(r("answers.md", parts), "=== true\nfindings: []\n")).toBe(false);
    expect(
      answerComplete(
        r("answers.md", parts),
        "=== true\nfindings: []\n=== complete\nfindings: []\n",
      ),
    ).toBe(true);
  });
});

describe("the runs to check", () => {
  it("only a stage's or the critic's waiting answer, once it has settled, and once per text", async () => {
    const root = await metarepo();
    const a = await run(root, "run-20261109090000-0001");
    const b = await run(root, "run-20261109090000-0002", { agent: "task-runner" });
    const c = await run(root, "run-20261109090000-0003", { agent: "true-critic", batch: "run-x" });
    for (const d of [a, b, c]) await writeFile(join(d, "feature-answer.yaml"), "summary: ok\n");
    const tried = new Map<string, string>();
    // Just written: it may still be half done, so not yet (and the scan comes back later).
    const fresh = await dueRuns(root, { stableMs: 3000, now: Date.now(), tried });
    expect(fresh).toEqual({ due: [], later: true });
    for (const d of [a, b, c]) await old(join(d, "feature-answer.yaml"));
    // The stage's run is due; a task run's Done and a lens asked in a batch are not the app's.
    expect((await dueRuns(root, { stableMs: 3000, now: Date.now(), tried })).due).toEqual([
      "run-20261109090000-0001",
    ]);
    // Never twice on the same text.
    expect((await dueRuns(root, { stableMs: 3000, now: Date.now(), tried })).due).toEqual([]);
    // A changed file is looked at again.
    await writeFile(join(a, "feature-answer.yaml"), "summary: fixed\n");
    await old(join(a, "feature-answer.yaml"));
    expect((await dueRuns(root, { stableMs: 3000, now: Date.now(), tried })).due).toEqual([
      "run-20261109090000-0001",
    ]);
  });

  it("a half-written YAML file waits; a failed run waits for its file to change; a run the command line checked is only resumed", async () => {
    const root = await metarepo();
    const a = await run(root, "run-20261109090000-0001");
    await writeFile(join(a, "feature-answer.yaml"), "summary: [half");
    await old(join(a, "feature-answer.yaml"));
    const tried = new Map<string, string>();
    expect((await dueRuns(root, { stableMs: 10, now: Date.now(), tried })).due).toEqual([]);
    const f = await run(root, "run-20261109090000-0002", { state: "failed" });
    await writeFile(join(f, "feature-answer.yaml"), "summary: was wrong\n");
    await old(join(f, "feature-answer.yaml"));
    expect((await dueRuns(root, { stableMs: 10, now: Date.now(), tried })).due).toEqual([]);
    await writeFile(join(f, "feature-answer.yaml"), "summary: fixed now\n");
    await old(join(f, "feature-answer.yaml"));
    expect((await dueRuns(root, { stableMs: 10, now: Date.now(), tried })).due).toEqual([
      "run-20261109090000-0002",
    ]);
    await run(root, "run-20261109090000-0003", { state: "validated" });
    await keepResume(root, CHANGE, "run-20261109090000-0003", [
      "change",
      "feature",
      CHANGE,
      "--resume",
      "run-20261109090000-0003",
    ]);
    expect((await dueRuns(root, { stableMs: 10, now: Date.now(), tried })).due).toEqual([
      "run-20261109090000-0003",
    ]);
    expect((await dueRuns(root, { stableMs: 10, now: Date.now(), tried })).due).toEqual([]);
  });
});

describe("the server checks the answer by itself", () => {
  it("after a file event, once the answer settled, with the same check as Done, once", async () => {
    const root = await metarepo();
    const events = new EventHub();
    const closers = new Set<() => void>();
    const ctx = {
      root,
      events,
      runLogs: new Signal(),
      onClose: closers,
    } as unknown as ServerContext;
    const checked: string[] = [];
    startAutoDone(ctx, async (id) => void checked.push(id), { stableMs: 40 });
    const a = await run(root, "run-20261109090000-0001");
    await writeFile(join(a, "feature-answer.yaml"), "summary: ok\n");
    events.publish({ type: "file.changed", path: `.runs/${CHANGE}` });
    await new Promise((r) => setTimeout(r, 400));
    expect(checked).toEqual(["run-20261109090000-0001"]);
    events.publish({ type: "file.changed", path: `.runs/${CHANGE}` });
    await new Promise((r) => setTimeout(r, 300));
    expect(checked).toEqual(["run-20261109090000-0001"]);
    for (const f of closers) f();
  });

  it("is off for a test's own context and when asked", async () => {
    const root = await metarepo();
    const events = new EventHub();
    const checked: string[] = [];
    startAutoDone(
      { root, events } as unknown as ServerContext,
      async (id) => void checked.push(id),
    );
    startAutoDone(
      { root, events, runLogs: new Signal() } as unknown as ServerContext,
      async (id) => void checked.push(id),
      { off: true },
    );
    const a = await run(root, "run-20261109090000-0001");
    await writeFile(join(a, "feature-answer.yaml"), "summary: ok\n");
    await old(join(a, "feature-answer.yaml"));
    events.publish({ type: "file.changed", path: "." });
    await new Promise((r) => setTimeout(r, 200));
    expect(checked).toEqual([]);
  });
});
