import { expect, it } from "vitest";
import { handoffPublisherFor } from "../src/change-commands.js";

/** Review: in production the hand-off's branch is pushed before its PR is asked for. */
it("publishes with git unless a test gives its own Git host", () => {
  expect(handoffPublisherFor({})).toBeDefined();
  expect(handoffPublisherFor({ gitHost: {} as never })).toBeUndefined();
  const own = { publish: async () => ({ commit: "x" }) };
  expect(handoffPublisherFor({ gitHost: {} as never, publisher: own })).toBe(own);
});

it("pushes the hand-off's files to its branch on the remote", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const g = (cwd: string, ...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {
      cwd,
      encoding: "utf8",
    });
  const base = await mkdtemp(join(tmpdir(), "pub-"));
  const remote = join(base, "remote.git");
  const root = join(base, "meta");
  g(base, "init", "-q", "--bare", remote);
  g(base, "init", "-q", "-b", "main", root);
  await writeFile(join(root, "README.md"), "meta\n");
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "init");
  g(root, "remote", "add", "origin", remote);
  g(root, "push", "-q", "origin", "main");
  await writeFile(join(root, "brief.md"), "A brief.\n");
  const said: string[] = [];
  const p = handoffPublisherFor({}, { out: (l) => said.push(l), err: (l) => said.push(l) })!;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const was = { ...process.env };
  Object.assign(process.env, env);
  try {
    await p.publish({
      root,
      branch: "handoff/c1/define",
      base: "main",
      files: ["brief.md"],
      message: "Define: c1",
      approval: { by: "pat", at: "2026-11-08T00:00:00Z", ref: "handoff/c1/define" },
    });
  } finally {
    process.env = was;
  }
  expect(said).toEqual([]);
  expect(g(remote, "show", "handoff/c1/define:brief.md")).toBe("A brief.\n");
});
