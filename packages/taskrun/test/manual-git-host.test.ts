import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileStepStore } from "@maycombhq/adapters";
import { MockRuntime } from "@maycombhq/ai";
import { completeTaskHandoff, runTask } from "../src/index.js";
import { CHANGE, git, speckitRoot } from "./helpers.js";

const T = 120_000;
const NOW = new Date("2026-10-21T09:00:00Z");
const now = () => NOW;
const APPROVAL = { by: "dev", at: "2026-10-21T09:00:00Z", ref: "task 1.2 PR" };
const FILE = "src/main/java/forge/ledger/TransferLimits.java";
const ok = async () => ({ exitCode: 0, stdout: "BUILD OK", stderr: "" });

/** The Forge Spec Kit metarepo with the Git host all-manual (ADR 0032). */
async function manualRoot() {
  const r = await speckitRoot({ repos: ["forge-ledger"] });
  const rt = join(r.root, "org-pack/runtime.yaml");
  const text = await readFile(rt, "utf8");
  expect(text).toContain("gitHost: { type: mock }");
  await writeFile(rt, text.replace("gitHost: { type: mock }", "gitHost: { type: manual }"));
  return r;
}

describe("Run with AI: a manual Git host", () => {
  it(
    "pr level: the push happens and the PR becomes a step in the metarepo, not an error",
    async () => {
      const { root, remotes } = await manualRoot();
      const runtime = new MockRuntime(
        () => `Done.\n\n=== file: ${FILE}\nclass TransferLimits {}\n=== end file\n`,
        { now },
      );
      const r = await runTask(root, CHANGE, "1.2", {
        level: "pr",
        by: "dev",
        approval: APPROVAL,
        runtime,
        git,
        now,
        commands: ok,
      });
      expect(r.state).toBe("pr-open");
      expect(r.pr?.url).toBe("manual://git-host/forge-ledger/pull/1");
      expect(r.notes.join(" ")).not.toMatch(/manual adapter/);
      const steps = await fileStepStore(root).list({ system: "git-host" });
      expect(steps.map((s) => s.action)).toContain("open-pull-request");
      expect(steps.find((s) => s.action === "open-pull-request")?.inputs).toMatchObject({
        repo: "forge-ledger",
        head: "task/add-transfer-limit/1.2",
        base: "change/add-transfer-limit",
      });
      expect(remotes["forge-ledger"]).toBeDefined();
    },
    T,
  );

  it(
    "hand-off, pr level: atticus handoff done opens the PR as a step",
    async () => {
      const { root } = await manualRoot();
      const w = await runTask(root, CHANGE, "1.2", {
        level: "pr",
        mode: "hand-off",
        by: "dev",
        approval: APPROVAL,
        git,
        now,
        commands: ok,
      });
      expect(w.state).toBe("waiting");
      const wt = join(root, "workspace/.worktrees", CHANGE, ".tasks/1.2/forge-ledger");
      await writeFile(join(wt, FILE), "class TransferLimits { boolean ok; }\n");
      await writeFile(
        join(root, "openspec/changes", CHANGE, "tasks/1.2/report.md"),
        "Added TransferLimits.\n",
      );
      const done = await completeTaskHandoff(root, w.waiting!, {
        approval: APPROVAL,
        git,
        now,
        commands: ok,
      });
      expect(done.state).toBe("pr-open");
      expect(done.pr?.url).toBe("manual://git-host/forge-ledger/pull/1");
      const steps = await fileStepStore(root).list({ system: "git-host" });
      expect(steps.map((s) => s.action)).toContain("open-pull-request");
    },
    T,
  );
});
