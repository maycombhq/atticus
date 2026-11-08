import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockGitHost } from "@maycombhq/adapters";
import { HandoffRuntime, MockRuntime } from "@maycombhq/ai";
import {
  assistantFiles,
  driftCommand,
  isTaskRun,
  runDone,
  runtimeForCli,
  specHandDown,
  specHandUp,
  taskHandoff,
  taskRun,
} from "../src/run-commands.js";
import { CHANGE, git, SPECKIT, speckitRoot, worktree } from "./run-helpers.js";
import { notMetarepo } from "../src/metarepo-guard.js";

const T = 120_000;
const NOW = new Date("2026-10-21T09:00:00Z");
const now = () => NOW;
const FILE = "src/main/java/forge/ledger/TransferLimits.java";
const ok = async () => ({ exitCode: 0, stdout: "ok", stderr: "" });

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

describe("atticus task run", () => {
  it(
    "checks its arguments",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"], open: false });
      let c = capture();
      expect(await taskRun(root, CHANGE, undefined, { by: "dev" }, c.io)).toBe(2);
      c = capture();
      expect(await taskRun(root, CHANGE, "1.2", {}, c.io)).toBe(2);
      expect(c.err).toEqual([
        "Say who is running the task: set your Git user (git config user.name), or pass --by <you>.",
      ]);
      c = capture();
      expect(await taskRun(root, CHANGE, "1.2", { by: "dev", level: "ship-it" }, c.io)).toBe(2);
      expect(c.err).toEqual(["Unknown level ship-it. Use one of: plan, draft, pr."]);
      c = capture();
      expect(await taskRun(root, CHANGE, "1.2", { by: "dev", mode: "mock" }, c.io)).toBe(2);
      c = capture();
      expect(await taskRun(root, CHANGE, "1.2", { by: "dev" }, c.io, { git })).toBe(1);
      expect(c.err).toEqual([
        "forge-ledger has no worktree for add-transfer-limit yet. Open it first: atticus workspace open add-transfer-limit --repos forge-ledger",
      ]);
    },
    T,
  );

  it(
    "--mode replay reads the recordings folder named by ATTICUS_REPLAY_DIR, like every other command",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const recordings = await mkdtemp(join(tmpdir(), "atticus-replay-"));
      let c = capture();
      expect(
        await taskRun(root, CHANGE, "1.2", { by: "dev", level: "plan", mode: "replay" }, c.io, {
          git,
          now,
          env: {},
        }),
      ).toBe(1);
      expect(c.err).toEqual(["Replay mode needs a folder of recordings (ATTICUS_REPLAY_DIR)."]);
      // With the folder named, replay runs and says what is missing, not that it has no folder.
      c = capture();
      expect(
        await taskRun(root, CHANGE, "1.2", { by: "dev", level: "plan", mode: "replay" }, c.io, {
          git,
          now,
          env: { ATTICUS_REPLAY_DIR: recordings },
        }),
      ).toBe(1);
      expect(c.err).toEqual([]);
      expect(c.out.join("\n")).toMatch(/no recording for agent/);
      expect(c.out.join("\n")).not.toMatch(/needs a folder/);
      // ATTICUS_RUNTIME picks the mode when --mode is not given.
      c = capture();
      expect(
        await taskRun(root, CHANGE, "1.2", { by: "dev", level: "plan" }, c.io, {
          git,
          now,
          env: { ATTICUS_RUNTIME: "replay", ATTICUS_REPLAY_DIR: recordings },
        }),
      ).toBe(1);
      expect(c.out.join("\n")).toMatch(/no recording for agent/);
      c = capture();
      expect(
        await taskRun(root, CHANGE, "1.2", { by: "dev", level: "plan" }, c.io, {
          git,
          now,
          env: { ATTICUS_RUNTIME: "mock" },
        }),
      ).toBe(2);
    },
    T,
  );

  it(
    "drafts a task and opens its PR with --approve; hand-off mode waits for atticus handoff done",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const runtime = new MockRuntime(
        () => `Done.\n\n=== file: ${FILE}\nclass TransferLimits {}\n=== end file\n`,
        { now },
      );
      let c = capture();
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      expect(
        await taskRun(root, CHANGE, "1.2", { by: "dev", level: "pr", approve: true }, c.io, {
          runtime,
          git,
          now,
          commands: ok,
          gitHost: host,
        }),
      ).toBe(0);
      expect(c.out[0]).toBe(
        "Opened PR https://git.example.com/forge-ledger/pull/1 from task/add-transfer-limit/1.2 for review.",
      );

      c = capture();
      expect(
        await taskRun(root, CHANGE, "1.3", { by: "dev", level: "draft", mode: "hand-off" }, c.io, {
          git,
          now,
          commands: ok,
        }),
      ).toBe(0);
      const runId = /atticus handoff done (run-[0-9a-z-]+)$/.exec(c.out[0]!)![1]!;
      expect(await isTaskRun(root, runId)).toBe(true);
      const wt = join(root, "workspace/.worktrees", CHANGE, ".tasks/1.3/forge-ledger");
      await writeFile(join(wt, "src/main/java/forge/ledger/Velocity.java"), "class Velocity {}\n");
      await writeFile(
        join(root, "openspec/changes", CHANGE, "tasks/1.3/report.md"),
        "Added Velocity.\n",
      );
      c = capture();
      expect(await taskHandoff(root, runId, {}, c.io, { git, now, commands: ok })).toBe(0);
      expect(c.out[0]).toMatch(
        /^Task 1.3 is drafted on task\/add-transfer-limit\/1.3 and the build passes \(1 attempt\); committed [0-9a-f]{12}\.$/,
      );
    },
    T,
  );
});

describe("atticus task run --level pr without --approve", () => {
  it(
    "says what it would do and does nothing: the editors' dry run before Approve and run",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const c = capture();
      let ran = 0;
      expect(
        await taskRun(root, CHANGE, "1.2", { by: "dev", level: "pr" }, c.io, {
          git,
          now,
          commands: async () => {
            ran++;
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        }),
      ).toBe(0);
      expect(c.out.at(-1)).toBe(
        "Nothing was done: run it again with --approve to let it push and open the PR (the person's yes; an assistant never approves a push).",
      );
      expect(ran).toBe(0);
      expect(
        existsSync(join(root, "workspace/.worktrees", CHANGE, ".tasks/1.2/forge-ledger")),
      ).toBe(false);
    },
    T,
  );
});

describe("Done on a run whose task run needs a person", () => {
  it(
    "is refused with where to carry on, never marked done with nothing built",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      let c = capture();
      expect(
        await taskRun(root, CHANGE, "1.3", { by: "dev", level: "draft", mode: "hand-off" }, c.io, {
          git,
          now,
          commands: ok,
        }),
      ).toBe(0);
      const runId = /atticus handoff done (run-[0-9a-z-]+)$/.exec(c.out[0]!)![1]!;
      await writeFile(join(root, "openspec/changes", CHANGE, "tasks/1.3/report.md"), "Tried.\n");
      const failing = async () => ({ exitCode: 1, stdout: "", stderr: "broken" });
      for (let i = 0; i < 6 && (await isTaskRun(root, runId)); i++) {
        c = capture();
        await runDone(root, runId, { by: "pat" }, c.io, { git, now, commands: failing });
      }
      expect(await isTaskRun(root, runId)).toBe(false);
      c = capture();
      const code = await runDone(root, runId, { by: "pat" }, c.io, { git, now, commands: ok });
      expect(code).toBe(1);
      expect(c.err.join("\n")).toMatch(
        new RegExp(
          `^Run ${runId} is part of task 1.3's run, which needs a person now: carry on in workspace/.worktrees/`,
        ),
      );
      expect(c.out.join("\n")).not.toMatch(/is valid/);
    },
    T,
  );
});

describe("Done on a task run's run that no task run names", () => {
  it(
    "is refused, never checked as a bare artifact",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      let c = capture();
      await taskRun(root, CHANGE, "1.3", { by: "dev", level: "draft", mode: "hand-off" }, c.io, {
        git,
        now,
        commands: ok,
      });
      const runId = /atticus handoff done (run-[0-9a-z-]+)$/.exec(c.out[0]!)![1]!;
      await writeFile(join(root, "openspec/changes", CHANGE, "tasks/1.3/report.md"), "Did it.\n");
      // Its record is gone (written over by hand, or by an older Atticus's second run).
      await (
        await import("node:fs/promises")
      ).rm(join(root, "openspec/changes", CHANGE, "tasks/1.3/task-run.yaml"));
      c = capture();
      expect(await runDone(root, runId, { by: "pat" }, c.io, { git, now, commands: ok })).toBe(1);
      expect(c.err.join("\n")).toBe(
        `Run ${runId} was a task run's, and no task run waits on it now: run the task again (atticus task run <change> <task>).`,
      );
    },
    T,
  );
});

describe("atticus task run's dry run", () => {
  it(
    "takes runtime.yaml's default level: a default pr without --approve is a dry run, not a refusal",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const rt = join(root, "org-pack/runtime.yaml");
      await writeFile(
        rt,
        (await readFile(rt, "utf8")).replace("  default: draft\n", "  default: draft-and-pr\n"),
      );
      const c = capture();
      expect(
        await taskRun(root, CHANGE, "1.2", { by: "dev", json: true }, c.io, { git, now }),
      ).toBe(0);
      expect(JSON.parse(c.out.join("\n"))).toMatchObject({
        dryRun: true,
        level: "pr",
        repo: "forge-ledger",
        branch: "task/add-transfer-limit/1.2",
      });
      expect(
        existsSync(join(root, "workspace/.worktrees", CHANGE, ".tasks/1.2/forge-ledger")),
      ).toBe(false);
    },
    T,
  );

  it(
    "makes the run's own checks first: a level past the repo's cap, a task that isn't there",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const rt = join(root, "org-pack/runtime.yaml");
      await writeFile(
        rt,
        (await readFile(rt, "utf8")).replace(
          "capPerRepo: { forge-gateway: plan-only,",
          "capPerRepo: { forge-ledger: draft, forge-gateway: plan-only,",
        ),
      );
      let c = capture();
      expect(
        await taskRun(root, CHANGE, "1.2", { by: "dev", level: "pr" }, c.io, { git, now }),
      ).toBe(1);
      expect(c.err.join("\n")).toMatch(/forge-ledger allows Run with AI up to draft/);
      c = capture();
      expect(
        await taskRun(root, CHANGE, "1.2", { by: "dev", dryRun: true }, c.io, { git, now }),
      ).toBe(0);
      expect(c.out.at(-1)).toBe("Nothing was done: this was a dry run.");
      // --dry-run at the pr level is only a dry run: nothing to approve.
      await writeFile(rt, (await readFile(rt, "utf8")).replace("forge-ledger: draft, ", ""));
      c = capture();
      expect(
        await taskRun(root, CHANGE, "1.2", { by: "dev", level: "pr", dryRun: true }, c.io, {
          git,
          now,
        }),
      ).toBe(0);
      expect(c.out.at(-1)).toBe("Nothing was done: this was a dry run.");
    },
    T,
  );
});

describe("Mark done in the app on a task run", () => {
  it(
    "builds and commits as atticus handoff done does, and pushes nothing",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      let c = capture();
      expect(
        await taskRun(root, CHANGE, "1.3", { by: "dev", level: "draft", mode: "hand-off" }, c.io, {
          git,
          now,
          commands: ok,
        }),
      ).toBe(0);
      const runId = /atticus handoff done (run-[0-9a-z-]+)$/.exec(c.out[0]!)![1]!;
      const wt = join(root, "workspace/.worktrees", CHANGE, ".tasks/1.3/forge-ledger");
      await writeFile(join(wt, "src/main/java/forge/ledger/Velocity.java"), "class Velocity {}\n");
      await writeFile(
        join(root, "openspec/changes", CHANGE, "tasks/1.3/report.md"),
        "Added Velocity.\n",
      );
      c = capture();
      expect(await runDone(root, runId, { by: "pat" }, c.io, { git, now, commands: ok })).toBe(0);
      expect(c.out[0]).toMatch(
        /^Task 1.3 is drafted on task\/add-transfer-limit\/1.3 and the build passes \(1 attempt\); committed [0-9a-f]{12}\.$/,
      );
    },
    T,
  );
});

describe("atticus spec hand-down, hand-up and drift", () => {
  it(
    "hands a task down, hands it up after its PR, and reports drift",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      let c = capture();
      expect(await specHandDown(root, CHANGE, "1.2", {}, c.io, { git })).toBe(0);
      expect(c.out[0]).toBe(
        "Handed task 1.2 down to forge-ledger as the Spec Kit feature specs/1.2, in workspace/.worktrees/add-transfer-limit/forge-ledger.",
      );
      expect(c.out).toContain("  wrote specs/1.2/plan.md");
      expect(c.out.at(-1)).toMatch(
        /^Committed [0-9a-f]{12} on change\/add-transfer-limit; nothing was pushed\.$/,
      );

      c = capture();
      expect(await driftCommand(root, CHANGE, {}, c.io, { now })).toBe(0);
      expect(c.out).toEqual([
        "Compared the design of add-transfer-limit with 1 repo plan and the code.",
        "No drift.",
      ]);

      await cp(
        join(SPECKIT, "drift/forge-ledger/specs/1.2"),
        join(worktree(root, "forge-ledger"), "specs/1.2"),
        { recursive: true },
      );
      c = capture();
      expect(await driftCommand(root, CHANGE, {}, c.io, { now })).toBe(1);
      expect(c.out).toContain(
        "  [blocking] specs/1.2/data-model.md in forge-ledger makes account.daily_limit numeric(12,2); data.md says numeric(18,2). (review/drift/1/plan-contradicts-design-ledger-db.account.daily-limit.yaml)",
      );
      expect(c.out.at(-1)).toBe(
        "6 open findings on the drift gate, round 1. A blocking one stops the PR until the design is amended or the plan is fixed.",
      );
      c = capture();
      expect(await driftCommand(root, CHANGE, { json: true }, c.io, { now })).toBe(1);
      expect(JSON.parse(c.out.join("\n"))).toMatchObject({
        change: CHANGE,
        round: 1,
        unchanged: true,
      });

      c = capture();
      expect(await specHandUp(root, CHANGE, "1.2", { by: "dev", pr: 7 }, c.io)).toBe(2);
      c = capture();
      expect(
        await specHandUp(
          root,
          CHANGE,
          "1.2",
          { by: "dev", pr: 7, prUrl: "https://git.example.com/forge/forge-ledger/pull/7" },
          c.io,
          { git, now, runtime: new MockRuntime(() => "findings: []", { now }) },
        ),
      ).toBe(1);
      expect(c.out[0]).toBe(
        "Task 1.2 is handed up from PR https://git.example.com/forge/forge-ledger/pull/7 and marked done in tasks.md.",
      );
      expect(c.out).toContain("  The complete lens raised 0 findings.");
      expect(c.out.at(-1)).toBe("  Drift: 6 findings.");
    },
    T,
  );
});

describe("atticus spec hand-up with a manual Git host", () => {
  it(
    "builds the Git host with the metarepo's step store instead of failing",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const rt = join(root, "org-pack/runtime.yaml");
      await writeFile(
        rt,
        (await readFile(rt, "utf8")).replace(
          "gitHost: { type: mock }",
          "gitHost: { type: manual }",
        ),
      );
      expect(await specHandDown(root, CHANGE, "1.2", {}, capture().io, { git })).toBe(0);
      const c = capture();
      // No --pr: the PR is looked up on the Git host, which here is the manual one.
      const code = await specHandUp(root, CHANGE, "1.2", { by: "dev" }, c.io, {
        git,
        now,
        runtime: new MockRuntime(() => "findings: []", { now }),
      });
      expect(c.err.join("\n")).not.toMatch(/manual adapter writes steps/);
      expect(code).not.toBe(2);
    },
    T,
  );
});

describe("atticus assistant-files outside a metarepo (WP3.4)", () => {
  it("says the folder isn't a metarepo and how to make one, as atticus next does, and writes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-not-meta-"));
    const c = capture();
    expect(await assistantFiles(dir, { check: true }, c.io)).toBe(2);
    expect(c.err.join("\n")).toBe(notMetarepo(dir));
    expect(c.out).toEqual([]);
  });
});

describe("atticus assistant-files", () => {
  it(
    "writes the metarepo's files, passes its own smoke checks, and --check says when they are stale",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"], open: false });
      let c = capture();
      expect(await assistantFiles(root, { check: true }, c.io)).toBe(1);
      expect(c.out.at(-1)).toBe(
        "Assistant files for the metarepo are out of date; run atticus assistant-files.",
      );
      c = capture();
      expect(await assistantFiles(root, {}, c.io)).toBe(0);
      expect(c.err).toEqual([]);
      expect(c.out.at(-1)).toBe("Wrote assistant files for the metarepo from the org pack.");
      c = capture();
      expect(await assistantFiles(root, { check: true }, c.io)).toBe(0);
      expect(c.out).toEqual(["Assistant files for the metarepo are up to date."]);
      await writeFile(
        join(root, ".claude/commands/atticus-ask.md"),
        (await readFile(join(root, ".claude/commands/atticus-ask.md"), "utf8")) + "edit\n",
      );
      c = capture();
      expect(await assistantFiles(root, {}, c.io)).toBe(1);
      expect(c.out).toContain(
        "  kept (edited by hand; --force replaces it): .claude/commands/atticus-ask.md",
      );
      expect(c.err).toEqual([".claude/commands/atticus-ask.md: was edited after it was generated"]);
      c = capture();
      expect(await assistantFiles(root, { change: CHANGE }, c.io)).toBe(2);
    },
    T,
  );
});

describe("runtimeForCli", () => {
  it(
    "gives the hand-off runtime for the Forge pack, and model mode with its mock provider",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"], open: false });
      const r = await runtimeForCli(root, { env: {} });
      expect(r.mode).toBe("hand-off");
      expect(r.runtime).toBeInstanceOf(HandoffRuntime);
      expect((await runtimeForCli(root, { mode: "model", env: {} })).runtime.kind).toBe("model");
    },
    T,
  );
});
