import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockGitHost } from "@maycombhq/adapters";
import { MockRuntime } from "@maycombhq/ai";
import { raiseTaskPr, readTaskRun, runTask } from "../src/index.js";
import { CHANGE, git, speckitRoot } from "./helpers.js";

const T = 120_000;
const NOW = new Date("2026-11-08T09:00:00Z");
const now = () => NOW;
const APPROVAL = {
  by: "dev",
  at: "2026-11-08T09:00:00Z",
  ref: "task 1.2 of add-transfer-limit: PR",
};
const FILE = "src/main/java/forge/ledger/TransferLimits.java";
const answer = () =>
  `Done.\n\n=== file: ${FILE}\npackage forge.ledger;\n\nclass TransferLimits { boolean ok; }\n=== end file\n`;
const ok = async () => ({ exitCode: 0, stdout: "BUILD OK", stderr: "" });

/**
 * Sixth UX walk: a task drafted at the draft level (committed on its task branch) gets its PR on
 * the person's click, without running the AI step again: the same push and PR the pr level makes.
 */
describe("Raise the task's PR after its draft", () => {
  it(
    "opens the PR of a built task on the person's yes, and never without it",
    async () => {
      const { root, remotes } = await speckitRoot({ repos: ["forge-ledger"] });
      const drafted = await runTask(root, CHANGE, "1.2", {
        level: "draft",
        by: "dev",
        runtime: new MockRuntime(answer, { now }),
        git,
        now,
        commands: ok,
      });
      expect(drafted.state).toBe("built");
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      // No yes, no push.
      await expect(
        raiseTaskPr(root, CHANGE, "1.2", { git, gitHost: host, now } as never),
      ).rejects.toThrow(/person's yes/);
      expect((await readTaskRun(root, CHANGE, "1.2"))?.state).toBe("built");

      const r = await raiseTaskPr(root, CHANGE, "1.2", {
        approval: APPROVAL,
        git,
        gitHost: host,
        now,
      });
      expect(r.state).toBe("pr-open");
      expect(r.pr?.number).toBeGreaterThan(0);
      expect(r.commit).toBe(drafted.commit);
      expect(remotes["forge-ledger"]).toBeDefined();
      expect((await readTaskRun(root, CHANGE, "1.2"))?.state).toBe("pr-open");
      // A second click says where the PR is; nothing is pushed again.
      await expect(
        raiseTaskPr(root, CHANGE, "1.2", { approval: APPROVAL, git, gitHost: host, now }),
      ).rejects.toThrow(`Task 1.2's PR is already open: ${r.pr!.url}`);
    },
    T,
  );

  it(
    "refuses a task with no build to show, says why and what to do, and changes nothing",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const manifest = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
      await writeFile(
        manifest,
        (await readFile(manifest, "utf8")).replace("    build: forge build && forge test\n", ""),
      );
      const drafted = await runTask(root, CHANGE, "1.2", {
        level: "draft",
        by: "dev",
        runtime: new MockRuntime(answer, { now }),
        git,
        now,
        commands: ok,
      });
      expect(drafted.state).toBe("unverified");
      await expect(
        raiseTaskPr(root, CHANGE, "1.2", {
          approval: APPROVAL,
          git,
          gitHost: new MockGitHost([{ repo: "forge-ledger" }]),
          now,
        }),
      ).rejects.toThrow(
        `Atticus opens a task's PR only after a passing build, and forge-ledger has no build command in repos.manifest.yaml: add one and run task 1.2 again, or push task/${CHANGE}/1.2 and open its PR into change/${CHANGE} yourself.`,
      );
      expect((await readTaskRun(root, CHANGE, "1.2"))?.state).toBe("unverified");
    },
    T,
  );

  it("says a task that hasn't run has no draft to raise", async () => {
    const { root } = await speckitRoot({ repos: ["forge-ledger"] });
    await expect(
      raiseTaskPr(root, CHANGE, "1.2", { approval: APPROVAL, git, now }),
    ).rejects.toThrow(
      "Task 1.2 hasn't been drafted yet: run it with AI first; its PR comes after the draft.",
    );
  });
});
