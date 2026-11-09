import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockGitHost } from "@maycombhq/adapters";
import { MockRuntime } from "@maycombhq/ai";
import { buildTask, readTaskRun, runTask } from "../src/index.js";
import { CHANGE, git, speckitRoot } from "./helpers.js";

const T = 120_000;
const NOW = new Date("2026-11-09T09:00:00Z");
const now = () => NOW;
const APPROVAL = {
  by: "dev",
  at: "2026-11-09T09:00:00Z",
  ref: "task 1.2 of add-transfer-limit: build and PR",
};
const FILE = "src/main/java/forge/ledger/TransferLimits.java";
const answer = () =>
  `Done.\n\n=== file: ${FILE}\npackage forge.ledger;\n\nclass TransferLimits { boolean ok; }\n=== end file\n`;
const ok = async () => ({ exitCode: 0, stdout: "BUILD OK", stderr: "" });
const fails = async () => ({ exitCode: 1, stdout: "", stderr: "BUILD FAILED" });

/** A task drafted while its repo had no build command: UNVERIFIED. */
async function unverified() {
  const { root, remotes } = await speckitRoot({ repos: ["forge-ledger"] });
  const manifest = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
  const had = await readFile(manifest, "utf8");
  await writeFile(manifest, had.replace("    build: forge build && forge test\n", ""));
  const drafted = await runTask(root, CHANGE, "1.2", {
    level: "draft",
    by: "dev",
    runtime: new MockRuntime(answer, { now }),
    git,
    now,
    commands: ok,
  });
  expect(drafted.state).toBe("unverified");
  return { root, remotes, manifest, had, drafted };
}

/**
 * App-only audit (tasks): an UNVERIFIED task, once its repo has a build command, is built where it
 * was drafted and its PR raised on the person's yes, without running the AI step again.
 */
describe("Build and raise PR on an unverified task", () => {
  it(
    "refuses while the repo still has no build command, saying where to set it",
    async () => {
      const { root } = await unverified();
      await expect(buildTask(root, CHANGE, "1.2", { git, now, commands: ok })).rejects.toThrow(
        /forge-ledger has no build command yet: set it on Set up › Repos/,
      );
      expect((await readTaskRun(root, CHANGE, "1.2"))?.state).toBe("unverified");
    },
    T,
  );

  it(
    "builds with the build command set since, then raises its PR on the person's yes",
    async () => {
      const { root, manifest, had, drafted } = await unverified();
      await writeFile(manifest, had);
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      const r = await buildTask(root, CHANGE, "1.2", {
        approval: APPROVAL,
        git,
        gitHost: host,
        now,
        commands: ok,
      });
      expect(r.state).toBe("pr-open");
      expect(r.commit).toBe(drafted.commit);
      expect(r.attempts.at(-1)).toMatchObject({
        command: "forge build && forge test",
        passed: true,
      });
      expect(r.notes.join("\n")).toContain("Built with forge build && forge test");
      expect(host.journal.some((j) => j.method === "createPullRequest")).toBe(true);
    },
    T,
  );

  it(
    "without the person's yes it only builds: the task is drafted and built, its PR next",
    async () => {
      const { root, manifest, had } = await unverified();
      await writeFile(manifest, had);
      const r = await buildTask(root, CHANGE, "1.2", { git, now, commands: ok });
      expect(r.state).toBe("built");
    },
    T,
  );

  it(
    "a build that fails leaves the task for a person, with its log",
    async () => {
      const { root, manifest, had } = await unverified();
      await writeFile(manifest, had);
      const r = await buildTask(root, CHANGE, "1.2", { git, now, commands: fails });
      expect(r.state).toBe("needs-person");
      expect(r.notes.at(-1)).toMatch(/The build fails .*build-\d+\.log/);
    },
    T,
  );
});
