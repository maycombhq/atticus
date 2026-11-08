import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockGitHost } from "@maycombhq/adapters";
import { proposeForReview, proposePlan } from "../src/propose.js";

/**
 * ADR 0183: Propose for review lists what a kind of work changed and, on the person's yes,
 * pushes exactly those files to a branch and opens the PR. A person merges.
 */
const FORGE = join(import.meta.dirname, "../../../fixtures/forge/metarepo");
const g = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });

async function metarepo() {
  const base = await mkdtemp(join(tmpdir(), "propose-"));
  const root = join(base, "meta");
  const remote = join(base, "remote.git");
  await cp(join(FORGE, "org-pack"), join(root, "org-pack"), { recursive: true });
  const rt = join(root, "org-pack/runtime.yaml");
  await writeFile(
    rt,
    (await readFile(rt, "utf8")).replace(
      "gitHost: { type: mock }",
      "gitHost: { type: mock, settings: { metarepo: forge-meta } }",
    ),
  );
  g(base, "init", "-q", "--bare", remote);
  g(root, "init", "-q", "-b", "main");
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "init");
  g(root, "remote", "add", "origin", remote);
  g(root, "push", "-q", "origin", "main");
  return { root, remote };
}

describe("Propose for review", () => {
  it("lists the answers' files, then pushes exactly those and opens the PR", async () => {
    const { root, remote } = await metarepo();
    await mkdir(join(root, "questions"), { recursive: true });
    await writeFile(join(root, "questions/q1.yaml"), "answer: 1\n");
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes/private.md"), "not mine to propose\n");
    const now = new Date("2026-11-08T10:00:00Z");
    const plan = await proposePlan(root, "answers", { by: "Pat Lee", now });
    expect(plan.files).toEqual([{ path: "questions/q1.yaml", status: "??" }]);
    expect(plan.branch).toBe("propose/answers/2026-11-08-pat-lee");
    const host = new MockGitHost([{ repo: "forge-meta" }]);
    const said: string[] = [];
    const was = { ...process.env };
    Object.assign(process.env, {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    });
    let code: number;
    try {
      code = await proposeForReview(
        root,
        {
          scope: "answers",
          by: "Pat Lee",
          files: ["questions/q1.yaml", "notes/private.md"],
          gitHost: host,
          now,
        },
        { out: (l) => said.push(l), err: (l) => said.push(`ERR ${l}`) },
      );
    } finally {
      process.env = was;
    }
    expect(code, said.join("\n")).toBe(0);
    expect(g(remote, "show", "propose/answers/2026-11-08-pat-lee:questions/q1.yaml")).toBe(
      "answer: 1\n",
    );
    expect(() =>
      g(remote, "show", "propose/answers/2026-11-08-pat-lee:notes/private.md"),
    ).toThrow();
    expect(said.at(-1)).toMatch(/^PR #\d+ is open for review/);
    // The person's working tree and branch are as they were.
    expect(g(root, "branch", "--show-current").trim()).toBe("main");
  });

  it("says so when nothing listed has a change", async () => {
    const { root } = await metarepo();
    const said: string[] = [];
    const code = await proposeForReview(
      root,
      {
        scope: "answers",
        by: "pat",
        files: ["questions/q9.yaml"],
        gitHost: new MockGitHost([{ repo: "forge-meta" }]),
      },
      { out: (l) => said.push(l), err: (l) => said.push(l) },
    );
    expect(code).toBe(2);
    expect(said[0]).toContain("Nothing to propose");
  });
});
