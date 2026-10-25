import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedFiles, changesSince, GitError, type GitRunner } from "../src/index.js";

/**
 * The files changed between two commits (ADR 0124 addendum A-incremental), through the git
 * adapter: a temp Forge repo with commits made here by the git binary, no network.
 */

const T = 60_000;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "init.defaultBranch=main",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();
}

const CONTROLLER = [
  "package forge.ledger;",
  "",
  "@RestController",
  "public class AccountController {",
  '  @GetMapping("/accounts/{accountId}")',
  "  public Account get(long accountId) { return null; }",
  "}",
  "",
].join("\n");
const NOTIFIER = [
  "package forge.ledger;",
  "",
  "public class Notifier {",
  "  public void send(String body) {",
  '    client.post("http://notify.internal/notify", body);',
  "  }",
  "}",
  "",
].join("\n");

function forgeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "atticus-changed-"));
  git(dir, "init", "-q");
  const src = join(dir, "src", "main", "java", "forge", "ledger");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "AccountController.java"), CONTROLLER);
  writeFileSync(join(src, "Notifier.java"), NOTIFIER);
  writeFileSync(
    join(src, "SettlementListener.java"),
    '@Component\npublic class SettlementListener {\n  @KafkaListener(topics = "forge.payments.settled")\n  public void onSettled(String payload) {}\n}\n',
  );
  writeFileSync(join(dir, "README.md"), "# forge-ledger\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  const one = git(dir, "rev-parse", "HEAD");
  return { dir, src, one };
}

describe("changedFiles: what changed between two commits", () => {
  it(
    "says edited, added, deleted and renamed files, following a rename",
    async () => {
      const { dir, src, one } = forgeRepo();
      writeFileSync(
        join(src, "AccountController.java"),
        CONTROLLER.replace("@RestController", "// the accounts API\n\n@RestController"),
      );
      renameSync(join(src, "Notifier.java"), join(src, "NotifyClient.java"));
      rmSync(join(src, "SettlementListener.java"));
      writeFileSync(
        join(src, "StatementController.java"),
        'import org.springframework.web.bind.annotation.*;\n\n@RestController\nclass StatementController {\n  @GetMapping("/statements/{month}")\n  Statement get(String month) { return null; }\n}\n',
      );
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "two");
      const two = git(dir, "rev-parse", "HEAD");

      const p = "src/main/java/forge/ledger/";
      expect(await changedFiles(dir, one, two)).toEqual([
        { status: "modified", path: `${p}AccountController.java` },
        { status: "renamed", path: `${p}NotifyClient.java`, from: `${p}Notifier.java` },
        { status: "deleted", path: `${p}SettlementListener.java` },
        { status: "added", path: `${p}StatementController.java` },
      ]);
      // a short commit, as a facts file may keep one, names the same commit
      expect(await changedFiles(dir, one.slice(0, 7), two)).toHaveLength(4);
      expect(await changedFiles(dir, two, two)).toEqual([]);
    },
    T,
  );

  it(
    "fails with a GitError for a commit the clone doesn't have; changesSince says it is missing",
    async () => {
      const { dir, one } = forgeRepo();
      await expect(changedFiles(dir, "abcdef1234567", one)).rejects.toBeInstanceOf(GitError);
      const r = await changesSince(dir, ["abcdef1234567", one], one);
      expect(r.missing).toEqual(["abcdef1234567"]);
      expect(r.changes).toEqual({});
    },
    T,
  );

  it("reads the -z output of a mocked runner: paths with spaces, copies and type changes", async () => {
    const calls: string[][] = [];
    const runner: GitRunner = async (args) => {
      calls.push(args);
      return {
        stdout: [
          "M",
          "docs/a b.md",
          "C075",
          "src/A.java",
          "src/B.java",
          "T",
          "bin/run",
          "R100",
          "old/x.ts",
          "new/x.ts",
          "",
        ].join("\0"),
        stderr: "",
      };
    };
    expect(await changedFiles("/repo", "1111111", "2222222", runner)).toEqual([
      { status: "type-changed", path: "bin/run" },
      { status: "modified", path: "docs/a b.md" },
      { status: "renamed", path: "new/x.ts", from: "old/x.ts" },
      { status: "copied", path: "src/B.java", from: "src/A.java" },
    ]);
    expect(calls[0]).toEqual([
      "diff",
      "--name-status",
      "-M",
      "-z",
      "--no-color",
      "--no-ext-diff",
      "1111111",
      "2222222",
      "--",
    ]);
    const r = await changesSince("/repo", ["2222222", "1111111", "1111111"], "2222222", runner);
    expect(Object.keys(r.changes)).toEqual(["1111111"]);
    expect(calls).toHaveLength(2);
  });
});
