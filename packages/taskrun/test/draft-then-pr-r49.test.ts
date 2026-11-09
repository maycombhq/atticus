import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { MockGitHost } from "@maycombhq/adapters";
import { MockRuntime } from "@maycombhq/ai";
import { runTask } from "../src/index.js";
import { CHANGE, git, speckitRoot } from "./helpers.js";

/**
 * Review round 49 (end to end): a task drafted at the draft level is raised by running it again at
 * the pr level. The answer is the same, so nothing new is staged; the task branch already holds
 * the draft's commit, ahead of the change branch, and the run carries on with it to the build and
 * the PR. And with no build command for the repo, the run says to set one, not just "No PR".
 */

const T = 180_000;
const now = () => new Date("2026-11-08T09:00:00Z");
const APPROVAL = { by: "dev", at: "2026-11-08T09:00:00Z", ref: "task 1.2 (round 49)" };
const ok = async () => ({ exitCode: 0, stdout: "BUILD OK", stderr: "" });
const LIMITS = "src/main/java/forge/ledger/TransferLimits.java";
const answer = () =>
  new MockRuntime(
    () =>
      `Done.\n\n=== file: ${LIMITS}\npackage forge.ledger;\n\nclass TransferLimits {}\n=== end file\n`,
    { now },
  );

async function run(root: string, level: "draft" | "pr", host?: MockGitHost) {
  return runTask(root, CHANGE, "1.2", {
    level,
    by: "dev",
    ...(level === "pr" ? { approval: APPROVAL } : {}),
    runtime: answer(),
    git,
    ...(host ? { gitHost: host } : {}),
    now,
    commands: ok,
  });
}

describe("a drafted task raised at the pr level (round 49)", () => {
  it(
    "uses the draft's commit on the task branch and opens the PR",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const d = await run(root, "draft");
      expect(d.state).toBe("built");
      expect(d.commit).toMatch(/^[0-9a-f]{40}$/);
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      const r = await run(root, "pr", host);
      expect(r.notes.join("\n")).not.toContain("nothing to commit");
      expect(r.state).toBe("pr-open");
      expect(r.commit).toBe(d.commit);
      expect(r.notes).toContain(
        `Nothing new to commit: task/${CHANGE}/1.2 already has this task's commit ${d.commit!.slice(0, 12)}, ahead of change/${CHANGE}, so it is the one built and raised.`,
      );
      const prs = await host.listPullRequests("forge-ledger", {});
      expect(prs.map((p) => [p.head, p.base])).toEqual([
        [`task/${CHANGE}/1.2`, `change/${CHANGE}`],
      ]);
    },
    T,
  );

  it(
    "with no build command, says to set one in repos.manifest.yaml",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const path = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
      const m = parse(await readFile(path, "utf8")) as { repos: { id: string; build?: string }[] };
      delete m.repos.find((r) => r.id === "forge-ledger")!.build;
      await writeFile(path, stringify(m));
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      const r = await run(root, "pr", host);
      expect(r.state).toBe("needs-person");
      expect(r.notes).toContain(
        "No PR: a pull request needs a passing build, and forge-ledger has no build command: set a build command for forge-ledger (build: under its entry in repos.manifest.yaml), then run task 1.2 again.",
      );
      expect(await host.listPullRequests("forge-ledger", {})).toEqual([]);
    },
    T,
  );
});
