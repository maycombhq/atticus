import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Fact, staleCite } from "@maycombhq/core";
import { changedFiles } from "../src/index.js";

/**
 * Review round 49: a submodule bump changes files the diff never names (it names the gitlink),
 * so a fact citing a file in the submodule was carried as unchanged. Local git only: the gitlink
 * is written with update-index, no clone of anything.
 */

const T = 60_000;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

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

describe("changedFiles and a submodule", () => {
  it(
    "says a gitlink changed, so every fact citing a file under it is read again",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "atticus-r49-sub-"));
      dirs.push(dir);
      git(dir, "init", "-q");
      writeFileSync(join(dir, "README.md"), "# Forge ledger\n");
      git(dir, "add", "README.md");
      git(dir, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},lib/sm`);
      git(dir, "commit", "-q", "-m", "one");
      const a = git(dir, "rev-parse", "HEAD");
      git(dir, "update-index", "--cacheinfo", `160000,${"2".repeat(40)},lib/sm`);
      git(dir, "commit", "-q", "-m", "two");
      const b = git(dir, "rev-parse", "HEAD");

      const changes = await changedFiles(dir, a, b);
      expect(changes).toEqual([{ status: "modified", path: "lib/sm", gitlink: true }]);
      const fact = Fact.parse({
        repo: "forge-ledger",
        commit: a,
        kind: "entry",
        id: "e-a",
        entryType: "rest",
        method: "GET",
        path: "/v1/a",
        cite: { file: "lib/sm/api.ts", line: 1, value: "/v1/a" },
      });
      expect(staleCite(fact, changes)).toEqual({ file: "lib/sm/api.ts", how: "edited" });

      git(dir, "rm", "-q", "--cached", "lib/sm");
      git(dir, "commit", "-q", "-m", "three");
      const c = git(dir, "rev-parse", "HEAD");
      expect(await changedFiles(dir, b, c)).toEqual([
        { status: "deleted", path: "lib/sm", gitlink: true },
      ]);
    },
    T,
  );

  it(
    "says nothing of a gitlink for a plain file's change",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "atticus-r49-plain-"));
      dirs.push(dir);
      git(dir, "init", "-q");
      const lines = Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i};`);
      writeFileSync(join(dir, "a.ts"), `${lines.join("\n")}\n`);
      git(dir, "add", "a.ts");
      git(dir, "commit", "-q", "-m", "one");
      const a = git(dir, "rev-parse", "HEAD");
      writeFileSync(join(dir, "a.ts"), `${lines.join("\n")}\nexport const more = 1;\n`);
      git(dir, "mv", "a.ts", "b.ts");
      git(dir, "commit", "-q", "-am", "two");
      const b = git(dir, "rev-parse", "HEAD");
      expect(await changedFiles(dir, a, b)).toEqual([
        { status: "renamed", path: "b.ts", from: "a.ts" },
      ]);
    },
    T,
  );
});
