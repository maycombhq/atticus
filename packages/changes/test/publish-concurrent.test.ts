import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { gitHandoffPublisher } from "../src/index.js";

/** Round 37: two publishes at once each push only their own files. */
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env });

it("never pushes another publish's files", async () => {
  const base = await mkdtemp(join(tmpdir(), "pub2-"));
  const remote = join(base, "remote.git");
  const root = join(base, "meta");
  g(base, "init", "-q", "--bare", remote);
  g(base, "init", "-q", "-b", "main", root);
  await writeFile(join(root, "README.md"), "meta\n");
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "init");
  g(root, "remote", "add", "origin", remote);
  g(root, "push", "-q", "origin", "main");
  const a: string[] = [];
  const b: string[] = [];
  await mkdir(join(root, "a"));
  await mkdir(join(root, "b"));
  for (let i = 0; i < 30; i++) {
    await writeFile(join(root, "a", `${i}.yaml`), `a: ${i}\n`);
    await writeFile(join(root, "b", `${i}.yaml`), `b: ${i}\n`);
    a.push(`a/${i}.yaml`);
    b.push(`b/${i}.yaml`);
  }
  const p = gitHandoffPublisher({ env });
  const approval = { by: "pat", at: "2026-11-08T00:00:00Z", ref: "x" };
  await Promise.all([
    p.publish({ root, branch: "propose/a", base: "main", files: a, message: "a", approval }),
    p.publish({ root, branch: "propose/b", base: "main", files: b, message: "b", approval }),
  ]);
  const tree = (br: string) => g(remote, "ls-tree", "-r", "--name-only", br).trim().split("\n");
  expect(tree("propose/a").filter((f) => f.startsWith("b/"))).toEqual([]);
  expect(tree("propose/b").filter((f) => f.startsWith("a/"))).toEqual([]);
  expect(tree("propose/a").filter((f) => f.startsWith("a/"))).toHaveLength(30);
}, 60_000);
