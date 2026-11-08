import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockGitHost } from "@maycombhq/adapters";
import { bringInMerged, proposeForReview, proposePlan } from "../src/propose.js";

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
    expect(plan.branch).toBe("propose/answers/2026-11-08-100000-pat-lee");
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
    expect(g(remote, "show", "propose/answers/2026-11-08-100000-pat-lee:questions/q1.yaml")).toBe(
      "answer: 1\n",
    );
    expect(() =>
      g(remote, "show", "propose/answers/2026-11-08-100000-pat-lee:notes/private.md"),
    ).toThrow();
    expect(said.at(-2)).toMatch(/^PR #\d+ is open for review/);
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

const envOn = () => {
  const was = { ...process.env };
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  });
  return () => {
    process.env = was;
  };
};

describe("review round 35", () => {
  it("carries a rename's removal, gives a second proposal its own branch, and says a refusal", async () => {
    const { root, remote } = await metarepo();
    await mkdir(join(root, "facts"), { recursive: true });
    await writeFile(join(root, "facts/old name.jsonl"), "{}\n");
    g(root, "add", "-A");
    g(root, "commit", "-q", "-m", "facts");
    g(root, "push", "-q", "origin", "main");
    g(root, "mv", "facts/old name.jsonl", "facts/new näme.jsonl");
    const host = new MockGitHost([{ repo: "forge-meta" }]);
    const said: string[] = [];
    const io = { out: (l: string) => said.push(l), err: (l: string) => said.push(`ERR ${l}`) };
    const off = envOn();
    try {
      const plan = await proposePlan(root, "corrections", {
        by: "pat",
        now: new Date("2026-11-08T10:00:00Z"),
      });
      expect(plan.files).toEqual([
        { path: "facts/new näme.jsonl", status: "R", from: "facts/old name.jsonl" },
      ]);
      expect(
        await proposeForReview(
          root,
          {
            scope: "corrections",
            by: "pat",
            files: ["facts/new näme.jsonl"],
            gitHost: host,
            now: new Date("2026-11-08T10:00:00Z"),
          },
          io,
        ),
      ).toBe(0);
      const tree = g(
        remote,
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        "propose/corrections/2026-11-08-100000-pat",
      ).split("\0");
      expect(tree).toContain("facts/new näme.jsonl");
      expect(tree).not.toContain("facts/old name.jsonl");
      // The same branch again (the same second): the host refuses, and it is said, not a 500.
      expect(
        await proposeForReview(
          root,
          {
            scope: "corrections",
            by: "pat",
            files: ["facts/new näme.jsonl"],
            gitHost: host,
            now: new Date("2026-11-08T10:00:00Z"),
          },
          io,
        ),
      ).toBe(1);
      expect(said.at(-1)).toMatch(/^ERR The PR wasn't opened: /);
      // A minute later is its own branch.
      expect(
        await proposeForReview(
          root,
          {
            scope: "corrections",
            by: "pat",
            files: ["facts/new näme.jsonl"],
            gitHost: host,
            now: new Date("2026-11-08T10:01:00Z"),
          },
          io,
        ),
      ).toBe(0);
    } finally {
      off();
    }
  });

  it("brings in what merged: the same edits are put back, the person's own stay", async () => {
    const { root, remote } = await metarepo();
    await mkdir(join(root, "questions"), { recursive: true });
    await writeFile(join(root, "questions/q1.yaml"), "answer: 1\n");
    await writeFile(join(root, "README.md"), "my own edit\n");
    const host = new MockGitHost([{ repo: "forge-meta" }]);
    const said: string[] = [];
    const io = { out: (l: string) => said.push(l), err: (l: string) => said.push(`ERR ${l}`) };
    const off = envOn();
    try {
      g(root, "branch", "-q", "--set-upstream-to=origin/main", "main");
      const now = new Date("2026-11-08T11:00:00Z");
      expect(
        await proposeForReview(
          root,
          { scope: "answers", by: "pat", files: ["questions/q1.yaml"], gitHost: host, now },
          io,
        ),
      ).toBe(0);
      // The PR merges on the host (here: the branch is merged into main on the remote).
      const work = join(root, "..", "merger");
      g(join(root, ".."), "clone", "-q", "-b", "main", remote, work);
      g(work, "merge", "-q", "--no-edit", "origin/propose/answers/2026-11-08-110000-pat");
      g(work, "push", "-q", "origin", "main");
      expect(await bringInMerged(root, io)).toBe(0);
      expect(g(root, "log", "-1", "--format=%s").trim()).not.toBe("init");
      expect(await readFile(join(root, "questions/q1.yaml"), "utf8")).toBe("answer: 1\n");
      expect(await readFile(join(root, "README.md"), "utf8")).toBe("my own edit\n");
      expect(said.at(-1)).toContain("Your own edits stay as they were: README.md");
    } finally {
      off();
    }
  });
});

describe("review round 36: Bring in never loses an edit", () => {
  const setup = async () => {
    const { root, remote } = await metarepo();
    g(root, "branch", "-q", "--set-upstream-to=origin/main", "main");
    await writeFile(join(root, "other.md"), "base\n");
    g(root, "add", "-A");
    g(root, "commit", "-q", "-m", "other");
    g(root, "push", "-q", "origin", "main");
    const work = join(root, "..", "teammate");
    g(join(root, ".."), "clone", "-q", "-b", "main", remote, work);
    return { root, work };
  };
  const io = (said: string[]) => ({
    out: (l: string) => said.push(l),
    err: (l: string) => said.push(`ERR ${l}`),
  });

  it("refuses with nothing touched when what merged also changes a file the person edited", async () => {
    const { root, work } = await setup();
    await mkdir(join(work, "questions"), { recursive: true });
    await writeFile(join(work, "questions/q1.yaml"), "answer: 1\n");
    await writeFile(join(work, "README.md"), "edited\n");
    await writeFile(join(work, "other.md"), "the teammate's\n");
    g(work, "add", "-A");
    g(work, "commit", "-q", "-m", "merged");
    g(work, "push", "-q", "origin", "main");
    await mkdir(join(root, "questions"), { recursive: true });
    await writeFile(join(root, "questions/q1.yaml"), "answer: 1\n");
    await writeFile(join(root, "README.md"), "edited\n");
    await writeFile(join(root, "other.md"), "mine\n");
    const said: string[] = [];
    expect(await bringInMerged(root, io(said))).toBe(1);
    expect(said.at(-1)).toContain("nothing was changed: other.md");
    expect(await readFile(join(root, "questions/q1.yaml"), "utf8")).toBe("answer: 1\n");
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("edited\n");
    expect(await readFile(join(root, "other.md"), "utf8")).toBe("mine\n");
  });

  it("sets a staged new file aside, and brings in the rest", async () => {
    const { root, work } = await setup();
    await mkdir(join(work, "questions"), { recursive: true });
    await writeFile(join(work, "questions/q1.yaml"), "answer: 1\n");
    await writeFile(join(work, "README.md"), "edited\n");
    g(work, "add", "-A");
    g(work, "commit", "-q", "-m", "merged");
    g(work, "push", "-q", "origin", "main");
    await mkdir(join(root, "questions"), { recursive: true });
    await writeFile(join(root, "questions/q1.yaml"), "answer: 1\n");
    await writeFile(join(root, "README.md"), "edited\n");
    g(root, "add", "-A");
    const said: string[] = [];
    expect(await bringInMerged(root, io(said)), said.join("\n")).toBe(0);
    expect(g(root, "log", "-1", "--format=%s").trim()).toBe("merged");
    expect(await readFile(join(root, "questions/q1.yaml"), "utf8")).toBe("answer: 1\n");
    expect(g(root, "status", "--porcelain").trim()).toBe("");
  });

  it("refuses a branch with its own commits, with nothing touched", async () => {
    const { root, work } = await setup();
    await writeFile(join(work, "other.md"), "theirs\n");
    g(work, "commit", "-q", "-am", "theirs");
    g(work, "push", "-q", "origin", "main");
    await writeFile(join(root, "local.md"), "x\n");
    g(root, "add", "-A");
    g(root, "commit", "-q", "-m", "local");
    const said: string[] = [];
    expect(await bringInMerged(root, io(said))).toBe(1);
    expect(said.at(-1)).toContain("Your branch has commits");
  });
});
