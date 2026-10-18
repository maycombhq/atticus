import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOpenSpec } from "@maycombhq/openspec-adapter";
import { gitHandoffPublisher, handoff, newChange } from "../src/index.js";
import {
  FEATURE_OWNERS,
  REPO,
  approval,
  copyPhase,
  forgeMetarepo,
  host,
  readText,
} from "./helpers.js";

const T = 60_000;
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_TERMINAL_PROMPT: "0",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: ENV,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("publishing a hand-off branch with git", () => {
  it(
    "commits the phase's files on handoff/<change>/<phase> and pushes it, leaving the working tree and index alone",
    async () => {
      const root = await forgeMetarepo();
      const remote = join(await mkdtemp(join(tmpdir(), "atticus-changes-remote-")), "meta.git");
      git(root, "init", "-q", "-b", "main");
      git(root, "add", "org-pack", ".github");
      git(root, "commit", "-q", "-m", "first");
      git(root, "init", "-q", "--bare", remote);
      git(root, "remote", "add", "origin", remote);
      git(root, "push", "-q", "origin", "main");

      await newChange(root, {
        title: "Add transfer limit",
        type: "feature",
        by: "pat",
        owners: FEATURE_OWNERS,
        systems: ["ledger", "portal"],
        now: "2026-10-19T09:00:00Z",
      });
      await copyPhase(root, "add-transfer-limit", "add-transfer-limit/define");
      const statusBefore = git(root, "status", "--porcelain");

      const gh = host();
      await handoff(root, "add-transfer-limit", {
        gitHost: gh,
        repo: REPO,
        by: "pat",
        approval: approval("pat", "2026-10-19T10:00:00Z"),
        now: "2026-10-19T10:00:00Z",
        publisher: gitHandoffPublisher({ env: ENV }),
      });

      const branch = "handoff/add-transfer-limit/define";
      const files = git(remote, "ls-tree", "-r", "--name-only", branch).split("\n");
      expect(files).toEqual([
        ".github/CODEOWNERS",
        "openspec/changes/add-transfer-limit/brief.md",
        "openspec/changes/add-transfer-limit/change.yaml",
        "openspec/changes/add-transfer-limit/proposal.md",
        "openspec/changes/add-transfer-limit/specs/transfer-limits/spec.md",
        ...files.filter((f) => f.startsWith("org-pack/")),
      ]);
      expect(git(remote, "show", `${branch}:openspec/changes/add-transfer-limit/brief.md`)).toBe(
        (await readText(join(root, "openspec/changes/add-transfer-limit/brief.md"))).trim(),
      );
      expect(git(remote, "rev-parse", `${branch}^`)).toBe(git(remote, "rev-parse", "main"));
      expect(git(root, "status", "--porcelain")).toBe(statusBefore);
      expect(git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      expect(existsSync(join(root, ".git/atticus-handoff-index"))).toBe(false);

      // A second publish (after changes were requested) adds a commit on top.
      const publisher = gitHandoffPublisher({ env: ENV });
      await writeFile(
        join(root, "openspec/changes/add-transfer-limit/proposal.md"),
        "# Proposal\n\nMore.\n",
      );
      const first = git(remote, "rev-parse", branch);
      await publisher.publish({
        root,
        branch,
        base: "main",
        files: ["openspec/changes/add-transfer-limit/proposal.md"],
        message: "Update",
        approval: approval("pat", "2026-10-19T11:00:00Z"),
      });
      expect(git(remote, "rev-parse", `${branch}^`)).toBe(first);
      expect(git(remote, "show", `${branch}:openspec/changes/add-transfer-limit/proposal.md`)).toBe(
        "# Proposal\n\nMore.",
      );
    },
    T,
  );

  it("refuses to publish without an approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-changes-nopub-"));
    await mkdir(root, { recursive: true });
    await expect(
      gitHandoffPublisher().publish({
        root,
        branch: "handoff/x/define",
        base: "main",
        files: [],
        message: "x",
        approval: { by: "", at: "", ref: "" },
      }),
    ).rejects.toMatchObject({ code: "not-approved" });
  });
});

describe("creating the change through OpenSpec", () => {
  it(
    "uses the OpenSpec adapter when one is given",
    async () => {
      const root = await forgeMetarepo();
      const os = createOpenSpec({ root });
      await os.init();
      const c = await newChange(root, {
        title: "Add transfer limit",
        type: "feature",
        by: "pat",
        now: "2026-10-19T09:00:00Z",
        openspec: os,
      });
      expect(c.state).toBe("define");
      expect((await os.listChanges()).map((x) => x.name)).toEqual(["add-transfer-limit"]);
      expect(existsSync(join(root, "openspec/changes/add-transfer-limit/.openspec.yaml"))).toBe(
        true,
      );
      expect(existsSync(join(root, "openspec/changes/add-transfer-limit/brief.md"))).toBe(true);
    },
    T,
  );
});
