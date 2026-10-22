import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { checkoutGitWiki, gitWikiAdapter, type GitRun } from "../src/index.js";

/** ADR 0101: a wiki kept in git (an ADO or GitHub wiki, a docs repo), cloned or a submodule. */

const run = promisify(execFile);
const git: GitRun = async (args, cwd) => {
  const r = await run("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { stdout: r.stdout };
};
const commit = async (dir: string, files: Record<string, string>, date: string) => {
  for (const [f, text] of Object.entries(files)) {
    await mkdir(join(dir, f, ".."), { recursive: true });
    await writeFile(join(dir, f), text);
  }
  await git(["add", "-A"], dir);
  await run(
    "git",
    ["-c", "user.name=Wiki", "-c", "user.email=wiki@example.com", "commit", "-q", "-m", "pages"],
    { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } },
  );
};

async function wikiRepo() {
  const base = await mkdtemp(join(tmpdir(), "atticus-git-wiki-"));
  const wiki = join(base, "platform-wiki");
  await mkdir(wiki);
  await git(["init", "-q", "-b", "main"], wiki);
  await commit(
    wiki,
    {
      "docs/how-to/request-a-kafka-topic.md": "# Request a Kafka topic\n\nRaise CTASK-KAFKA.\n",
      "docs/standards/logging.md": "# Logging\n\nLog as JSON.\n",
      "README.md": "# The platform wiki\n",
    },
    "2026-09-01T10:00:00Z",
  );
  const root = join(base, "forge-meta");
  await mkdir(join(root, "org-pack"), { recursive: true });
  return { base, wiki, root };
}

const source = (location: string, o: Record<string, unknown> = {}) =>
  ({
    id: "platform-wiki",
    type: "git",
    location,
    spaces: [],
    checkout: "clone",
    path: "docs",
    ...o,
  }) as never;

describe("a wiki kept in git", () => {
  it("is cloned into local state and read from its folder, each page dated by git", async () => {
    const { wiki, root } = await wikiRepo();
    const c = await checkoutGitWiki(root, source(wiki), join(root, "org-pack"), git);
    expect(c.dir).toBe(join(root, "workspace", "knowledge", "platform-wiki"));
    expect(c.commit).toMatch(/^[0-9a-f]{40}$/);
    const pages = await gitWikiAdapter(new Map([["platform-wiki", c]])).pages(source(wiki), {
      root,
      orgPackDir: join(root, "org-pack"),
    });
    expect(pages.map((p) => [p.pagePath, p.updatedAt])).toEqual([
      ["how-to/request-a-kafka-topic.md", "2026-09-01"],
      ["standards/logging.md", "2026-09-01"],
    ]);
    expect(pages[0]!.content).toContain("CTASK-KAFKA");
    expect(pages[0]!.version).toBe(c.commit);
  });

  it("is brought up to date on the next sync: a new page, a newer date, a new commit", async () => {
    const { wiki, root } = await wikiRepo();
    const first = await checkoutGitWiki(root, source(wiki), join(root, "org-pack"), git);
    await commit(
      wiki,
      { "docs/how-to/set-up-sso.md": "# Set up SSO\n\nRaise the SSO intake form.\n" },
      "2026-10-01T10:00:00Z",
    );
    const next = await checkoutGitWiki(root, source(wiki), join(root, "org-pack"), git);
    expect(next.commit).not.toBe(first.commit);
    const pages = await gitWikiAdapter(new Map([["platform-wiki", next]])).pages(source(wiki), {
      root,
      orgPackDir: join(root, "org-pack"),
    });
    expect(pages.find((p) => p.pagePath === "how-to/set-up-sso.md")!.updatedAt).toBe("2026-10-01");
  });

  it("reads a branch when one is named", async () => {
    const { wiki, root } = await wikiRepo();
    await git(["checkout", "-q", "-b", "draft"], wiki);
    await commit(wiki, { "docs/how-to/draft-only.md": "# Draft\n" }, "2026-10-02T10:00:00Z");
    await git(["checkout", "-q", "main"], wiki);
    const c = await checkoutGitWiki(
      root,
      source(wiki, { ref: "draft" }),
      join(root, "org-pack"),
      git,
    );
    expect(existsSync(join(c.dir, "docs", "how-to", "draft-only.md"))).toBe(true);
  });

  it("can be a submodule of the metarepo, pinned at the commit read", async () => {
    const { wiki, root } = await wikiRepo();
    await git(["init", "-q", "-b", "main"], root);
    const c = await checkoutGitWiki(
      root,
      source(wiki, { checkout: "submodule" }),
      join(root, "org-pack"),
      git,
    );
    expect(c.dir).toBe(join(root, "knowledge", "repos", "platform-wiki"));
    expect(await readFile(join(root, ".gitmodules"), "utf8")).toContain(
      "path = knowledge/repos/platform-wiki",
    );
    expect(c.submodule).toEqual({ path: "knowledge/repos/platform-wiki", moved: false });
    await commit(wiki, { "docs/how-to/new.md": "# New\n" }, "2026-10-03T10:00:00Z");
    const moved = await checkoutGitWiki(
      root,
      source(wiki, { checkout: "submodule" }),
      join(root, "org-pack"),
      git,
    );
    expect(moved.submodule?.moved).toBe(true);
  });

  it("says when a submodule can't be added because the metarepo isn't a git repository", async () => {
    const { wiki, root } = await wikiRepo();
    await expect(
      checkoutGitWiki(root, source(wiki, { checkout: "submodule" }), join(root, "org-pack"), git),
    ).rejects.toThrow(/isn't a git repository.*checkout: clone/);
  });
});
