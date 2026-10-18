import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { RepoManifest, type ManifestRepo } from "@maycombhq/core";
import {
  baseClonePath,
  createWorkspace,
  ensureGitignore,
  intellijProjectPath,
  loadRepos,
  readChangeRepos,
  vscodeWorkspacePath,
  worktreePath,
  writeChangeRepos,
} from "../src/index.js";

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
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  ).trim();
}

/** A local "remote": a bare repo with one commit, plus a scratch clone to push more commits. */
async function origin(
  dir: string,
  name: string,
  files: Record<string, string>,
  branch = "main",
): Promise<{ url: string; push: (f: Record<string, string>) => Promise<void> }> {
  const work = join(dir, "src", name);
  await mkdir(work, { recursive: true });
  git(work, "init", "-q", "-b", branch);
  const commit = async (f: Record<string, string>) => {
    for (const [p, t] of Object.entries(f)) {
      await mkdir(join(work, p, ".."), { recursive: true });
      await writeFile(join(work, p), t);
    }
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "update");
  };
  await commit(files);
  const url = join(dir, "remotes", `${name}.git`);
  git(dir, "clone", "-q", "--bare", work, url);
  git(work, "remote", "add", "origin", url);
  return {
    url,
    push: async (f) => {
      await commit(f);
      git(work, "push", "-q", "origin", branch);
    },
  };
}

let dir: string;
let root: string;
let repos: ManifestRepo[];
let ledger: Awaited<ReturnType<typeof origin>>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atticus-ws-"));
  root = join(dir, "metarepo");
  await mkdir(root);
  git(root, "init", "-q");
  ledger = await origin(dir, "forge-ledger", {
    "pom.xml": "<project/>\n",
    "src/Ledger.java": "class Ledger {}\n",
  });
  const gateway = await origin(
    dir,
    "forge-gateway",
    { "proxies/ledger-v1/proxy.xml": "<p/>\n", "proxies/other/proxy.xml": "<o/>\n" },
    "develop",
  );
  repos = RepoManifest.parse({
    schemaVersion: 1,
    platform: "forge",
    repos: [
      { id: "forge-ledger", url: ledger.url, type: "forge-service", owner: "team-ledger" },
      {
        id: "forge-gateway",
        url: gateway.url,
        defaultBranch: "develop",
        type: "gateway",
        owner: "team-platform",
        sparse: ["proxies/ledger-v1"],
      },
      {
        id: "forge-old",
        url: join(dir, "nowhere.git"),
        type: "library",
        owner: "team-ledger",
        archived: true,
      },
    ],
  }).repos;
});

describe("base clones", () => {
  it(
    "clones every active repo, honours sparse paths and skips archived ones",
    async () => {
      const ws = createWorkspace(root);
      const r = await ws.sync(repos);
      expect(r.map((x) => [x.id, x.action])).toEqual([
        ["forge-ledger", "cloned"],
        ["forge-gateway", "cloned"],
        ["forge-old", "skipped"],
      ]);
      expect(r[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(join(baseClonePath(root, "forge-ledger"), "src/Ledger.java"))).toBe(true);
      expect(
        existsSync(join(baseClonePath(root, "forge-gateway"), "proxies/ledger-v1/proxy.xml")),
      ).toBe(true);
      expect(
        existsSync(join(baseClonePath(root, "forge-gateway"), "proxies/other/proxy.xml")),
      ).toBe(false);
    },
    T,
  );

  it(
    "fast-forwards on the next sync and records the new SHA",
    async () => {
      const ws = createWorkspace(root);
      const [first] = await ws.sync([repos[0]!]);
      await ledger.push({ "src/Entry.java": "class Entry {}\n" });
      const [second] = await ws.sync([repos[0]!]);
      expect(second!.action).toBe("updated");
      expect(second!.sha).not.toBe(first!.sha);
      expect(existsSync(join(baseClonePath(root, "forge-ledger"), "src/Entry.java"))).toBe(true);
    },
    T,
  );

  it(
    "leaves a base clone with local edits alone",
    async () => {
      const ws = createWorkspace(root);
      await ws.sync([repos[0]!]);
      await writeFile(join(baseClonePath(root, "forge-ledger"), "src/Ledger.java"), "edited\n");
      const [r] = await ws.sync([repos[0]!]);
      expect(r!.action).toBe("skipped");
      expect(r!.reason).toContain("read-only");
    },
    T,
  );

  it(
    "reports a failed clone without stopping the others",
    async () => {
      const ws = createWorkspace(root);
      const broken = { ...repos[0]!, id: "forge-missing", url: join(dir, "missing.git") };
      const r = await ws.sync([broken, repos[0]!]);
      expect(r.map((x) => x.action)).toEqual(["failed", "cloned"]);
      expect(r[0]!.reason).toContain("git clone failed");
    },
    T,
  );

  it(
    "adds /workspace/, /.index/ and /.runs/ to the metarepo's .gitignore once",
    async () => {
      await writeFile(join(root, ".gitignore"), "node_modules/\n.runs\n");
      expect(await ensureGitignore(root)).toEqual(["/workspace/", "/.index/"]);
      expect(await ensureGitignore(root)).toEqual([]);
      expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(
        "node_modules/\n.runs\n\n# Atticus local state\n/workspace/\n/.index/\n",
      );
    },
    T,
  );
});

describe("change worktrees", () => {
  it(
    "creates a worktree on change/<id> per repo and records it in repos.yaml",
    async () => {
      const ws = createWorkspace(root);
      await ws.sync(repos);
      const c = await ws.openChange("add-transfer-limit", [repos[0]!, repos[1]!]);
      expect(c.repos.map((r) => r.id)).toEqual(["forge-gateway", "forge-ledger"]);
      const l = c.repos.find((r) => r.id === "forge-ledger")!;
      expect(l).toMatchObject({
        branch: "change/add-transfer-limit",
        base: "main",
        worktree: "workspace/.worktrees/add-transfer-limit/forge-ledger",
        build: { status: "not-run" },
      });
      expect(c.repos.find((r) => r.id === "forge-gateway")!.base).toBe("develop");

      const wt = worktreePath(root, "add-transfer-limit", "forge-ledger");
      expect(git(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("change/add-transfer-limit");
      expect(git(wt, "rev-parse", "HEAD")).toBe(l.baseSha);
      // Base clone stays on the default branch.
      expect(git(baseClonePath(root, "forge-ledger"), "rev-parse", "--abbrev-ref", "HEAD")).toBe(
        "main",
      );

      const text = await readFile(
        join(root, "openspec/changes/add-transfer-limit/repos.yaml"),
        "utf8",
      );
      expect(
        text.startsWith(
          "schemaVersion: 1\nchange: add-transfer-limit\nrepos:\n  - id: forge-gateway\n",
        ),
      ).toBe(true);
      expect(await readChangeRepos(root, "add-transfer-limit")).toEqual(c);
    },
    T,
  );

  it(
    "is safe to run again and keeps known PR and build state",
    async () => {
      const ws = createWorkspace(root);
      await ws.sync(repos);
      const c = await ws.openChange("add-transfer-limit", [repos[0]!]);
      c.repos[0]!.pr = {
        url: "https://git.example.com/forge/forge-ledger/pull/7",
        number: 7,
        state: "open",
      };
      await writeChangeRepos(root, c);
      const again = await ws.openChange("add-transfer-limit", [repos[0]!, repos[1]!]);
      expect(again.repos.find((r) => r.id === "forge-ledger")!.pr?.number).toBe(7);
      expect(again.repos).toHaveLength(2);
    },
    T,
  );

  it(
    "continues from a change branch someone already pushed",
    async () => {
      const ws = createWorkspace(root);
      await ws.sync([repos[0]!]);
      // A teammate pushes change/shared with a commit.
      const mate = join(dir, "mate");
      git(dir, "clone", "-q", ledger.url, mate);
      git(mate, "checkout", "-q", "-b", "change/shared");
      await writeFile(join(mate, "NOTE.md"), "from a teammate\n");
      git(mate, "add", "-A");
      git(mate, "commit", "-q", "-m", "teammate");
      git(mate, "push", "-q", "origin", "change/shared");

      await ws.openChange("shared", [repos[0]!]);
      expect(existsSync(join(worktreePath(root, "shared", "forge-ledger"), "NOTE.md"))).toBe(true);
    },
    T,
  );

  it(
    "needs a base clone first",
    async () => {
      const ws = createWorkspace(root);
      await expect(ws.openChange("x", [repos[0]!])).rejects.toThrow(/workspace sync/);
    },
    T,
  );
});

describe("editor workspaces", () => {
  it(
    "writes a VS Code workspace with the metarepo and the change's worktrees",
    async () => {
      const ws = createWorkspace(root);
      await ws.sync(repos);
      await mkdir(join(root, ".runs", "add-transfer-limit"), { recursive: true });
      await ws.openChange("add-transfer-limit", [repos[0]!, repos[1]!]);
      const v = JSON.parse(await readFile(vscodeWorkspacePath(root, "add-transfer-limit"), "utf8"));
      expect(v.folders).toEqual([
        { name: "metarepo", path: ".." },
        { name: "forge-gateway", path: ".worktrees/add-transfer-limit/forge-gateway" },
        { name: "forge-ledger", path: ".worktrees/add-transfer-limit/forge-ledger" },
        { name: "context pack", path: "../.runs/add-transfer-limit" },
      ]);
      expect(v.settings["files.exclude"].workspace).toBe(true);
    },
    T,
  );

  it(
    "writes an IntelliJ project with one module per worktree and relative paths",
    async () => {
      const ws = createWorkspace(root);
      await ws.sync(repos);
      await ws.openChange("add-transfer-limit", [repos[0]!]);
      const idea = join(intellijProjectPath(root, "add-transfer-limit"), ".idea");
      const modules = await readFile(join(idea, "modules.xml"), "utf8");
      expect(modules).toContain('filepath="$PROJECT_DIR$/.idea/metarepo.iml"');
      expect(modules).toContain('filepath="$PROJECT_DIR$/.idea/forge-ledger.iml"');
      const iml = await readFile(join(idea, "forge-ledger.iml"), "utf8");
      expect(iml).toContain(
        '<content url="file://$MODULE_DIR$/../../../.worktrees/add-transfer-limit/forge-ledger">',
      );
      const meta = await readFile(join(idea, "metarepo.iml"), "utf8");
      expect(meta).toContain('<content url="file://$MODULE_DIR$/../../../..">');
      // The .idea folder is inside workspace/, so excluding workspace/ is three levels up.
      expect(meta).toContain('<excludeFolder url="file://$MODULE_DIR$/../../.." />');
      expect(meta).toContain('<excludeFolder url="file://$MODULE_DIR$/../../../../.index" />');
      const vcs = await readFile(join(idea, "vcs.xml"), "utf8");
      expect(vcs).toContain(
        '<mapping directory="$PROJECT_DIR$/../../.worktrees/add-transfer-limit/forge-ledger" vcs="Git" />',
      );
      expect(await readFile(join(idea, ".name"), "utf8")).toBe("add-transfer-limit\n");
      expect(iml).not.toContain(root);
    },
    T,
  );
});

describe("prune", () => {
  it(
    "removes only worktrees whose PR merged or closed",
    async () => {
      const ws = createWorkspace(root);
      await ws.sync(repos);
      const c = await ws.openChange("add-transfer-limit", [repos[0]!, repos[1]!]);
      c.repos.find((r) => r.id === "forge-ledger")!.pr = {
        url: "https://git.example.com/x/pull/1",
        number: 1,
        state: "merged",
      };
      await writeChangeRepos(root, c);

      const r = await ws.prune("add-transfer-limit");
      expect(r.removed).toEqual(["forge-ledger"]);
      expect(r.kept).toEqual([{ id: "forge-gateway", reason: "no PR yet" }]);
      expect(existsSync(worktreePath(root, "add-transfer-limit", "forge-ledger"))).toBe(false);
      expect(existsSync(vscodeWorkspacePath(root, "add-transfer-limit"))).toBe(true);
    },
    T,
  );

  it(
    "keeps a worktree with uncommitted work unless forced, then cleans up the editor files",
    async () => {
      const ws = createWorkspace(root);
      await ws.sync(repos);
      await ws.openChange("add-transfer-limit", [repos[0]!]);
      await writeFile(
        join(worktreePath(root, "add-transfer-limit", "forge-ledger"), "WIP.md"),
        "unsaved\n",
      );

      const first = await ws.prune("add-transfer-limit", { all: true });
      expect(first.kept).toEqual([
        { id: "forge-ledger", reason: "uncommitted changes in the worktree" },
      ]);

      const second = await ws.prune("add-transfer-limit", { all: true, force: true });
      expect(second.removed).toEqual(["forge-ledger"]);
      expect(existsSync(vscodeWorkspacePath(root, "add-transfer-limit"))).toBe(false);
      expect(existsSync(intellijProjectPath(root, "add-transfer-limit"))).toBe(false);
      expect(git(baseClonePath(root, "forge-ledger"), "worktree", "list")).not.toContain(
        "add-transfer-limit",
      );
    },
    T,
  );
});

describe("manifests", () => {
  it("loads every profile's repos and refuses an id used twice", async () => {
    const write = async (platform: string, ids: string[]) => {
      const p = join(root, "org-pack/profiles", platform);
      await mkdir(p, { recursive: true });
      const body = ids
        .map(
          (id) =>
            `  - id: ${id}\n    url: https://git.example.com/${id}.git\n    type: library\n    owner: team-a\n`,
        )
        .join("");
      await writeFile(
        join(p, "repos.manifest.yaml"),
        `schemaVersion: 1\nplatform: ${platform}\nrepos:\n${body}`,
      );
    };
    await write("forge", ["forge-ledger"]);
    await write("anvil", ["anvil-web"]);
    const all = await loadRepos(root);
    expect(all.map((r) => [r.platform, r.id])).toEqual([
      ["anvil", "anvil-web"],
      ["forge", "forge-ledger"],
    ]);
    await write("anvil", ["anvil-web", "forge-ledger"]);
    await expect(loadRepos(root)).rejects.toThrow(/forge-ledger is in both anvil and forge/);
  });

  it("returns nothing when there are no profiles yet", async () => {
    expect(await loadRepos(root)).toEqual([]);
  });

  it("reports schema problems with the file and field", async () => {
    const p = join(root, "org-pack/profiles/forge");
    await mkdir(p, { recursive: true });
    await writeFile(
      join(p, "repos.manifest.yaml"),
      "schemaVersion: 1\nplatform: forge\nrepos:\n  - id: Bad Id\n    url: x\n    type: library\n    owner: a\n",
    );
    await expect(loadRepos(root)).rejects.toThrow(/repos\.0\.id/);
  });

  it("parses YAML written by people", () => {
    expect(parse("a: 1")).toEqual({ a: 1 });
  });
});
