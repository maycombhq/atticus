import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareStep } from "../src/handoff-resume.js";

/**
 * App-only audit (runs): preparing an AI step again made a second run while the first still
 * waited, for ever (Model runs kept listing Round 1 as waiting). The older open run of the same
 * step, the one Atticus kept a resume for, is cancelled when the new one is prepared, saying why;
 * another step's waiting run, or a run with no resume kept (a lens of a batch), is left alone.
 */

const agent = {
  schemaVersion: 1,
  id: "small-change-planner",
  role: "architect",
  description: "Plans a small change.",
  inputs: ["brief"],
  outputArtifact: "stories",
  tokenBudget: 4000,
  allowedRuntimes: ["hand-off"],
};

async function run(root: string, id: string, at: string, change = "c1") {
  const dir = join(root, ".runs", change, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      runId: id,
      request: {
        change,
        agent,
        pack: {
          prompt: "# Task\n",
          manifest: {
            schemaVersion: 1,
            change,
            agent: agent.id,
            createdAt: at,
            budget: 4000,
            totalTokens: 900,
            sources: [],
            dropped: [],
            promptSha256: "0".repeat(64),
          },
        },
        outputPath: "small-answer.yaml",
        outputIn: "run",
      },
      runtime: "hand-off",
      state: "waiting",
      attempt: 1,
      startedAt: at,
      errors: [],
    }),
  );
  return id;
}

const state = async (root: string, id: string, change = "c1") =>
  JSON.parse(await readFile(join(root, ".runs", change, id, "run.json"), "utf8")) as {
    state: string;
    errors: string[];
  };

describe("an AI step prepared again (app-only audit)", () => {
  it("cancels the older waiting run of the same step, and leaves the others", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-supersede-"));
    let n = 0;
    const step = (change: string) => async (args: string[]) => {
      n++;
      const id = await run(root, `run-2026110909000${n}-0001`, `2026-11-09T09:00:0${n}Z`, change);
      return {
        code: 0,
        out: [
          JSON.stringify({ state: "handoff", runId: id, resumeArgs: [...args, "--resume", id] }),
        ],
        err: [],
      };
    };
    const first = await prepareStep(root, step("c1"), ["change", "small", "c1"]);
    const other = await prepareStep(root, step("c2"), ["change", "small", "c2"]);
    // A lens's run with no resume kept, in the same change.
    const lens = await run(root, "run-20261109085959-0001", "2026-11-09T08:59:59Z");
    const second = await prepareStep(root, step("c1"), ["change", "small", "c1"]);
    expect(second.prepared.runId).not.toBe(first.prepared.runId);
    const was = await state(root, first.prepared.runId!);
    expect(was.state).toBe("cancelled");
    expect(was.errors[0]).toBe(
      `Superseded by run ${second.prepared.runId}: the step was prepared again, so this run's answer is no longer read.`,
    );
    expect((await state(root, second.prepared.runId!)).state).toBe("waiting");
    expect((await state(root, other.prepared.runId!, "c2")).state).toBe("waiting");
    expect((await state(root, lens)).state).toBe("waiting");
    expect(second.prepared.lines.join("\n")).toContain(
      `Run ${first.prepared.runId} was waiting for the same step: it is cancelled.`,
    );
  });
});
