import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { createGit, createWorkspace, loadRepos, type GitRunner } from "@maycombhq/workspace";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, "../../../fixtures");
export const FORGE = join(FIXTURES, "forge");
export const SPECKIT = join(FIXTURES, "forge-speckit");
export const CHANGE = "add-transfer-limit";
export const NOW = "2026-10-21T09:00:00Z";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_TERMINAL_PROMPT: "0",
};

export const git: GitRunner = createGit({ env: ENV });

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: ENV,
  }).trim();
}

/**
 * A metarepo for the Spec Kit fixture: the Forge org pack with the forge-change and
 * forge-speckit additions, the Forge expected catalog, the change add-transfer-limit, local
 * bare "remotes" for the code repos (from fixtures/forge/repos), and the change's worktrees
 * opened with the real workspace manager. No network: every remote is a folder.
 */
export async function speckitRoot(
  o: { repos?: string[]; open?: boolean } = {},
): Promise<{ root: string; remotes: Record<string, string> }> {
  const root = await mkdtemp(join(tmpdir(), "atticus-speckit-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(FIXTURES, "forge-change/org-pack"), join(root, "org-pack"), { recursive: true });
  // A person's judgments of the seeded change: which new columns hold personal data (ADR 0117).
  await cp(join(FIXTURES, "forge-change/judgments"), join(root, "judgments"), { recursive: true });
  await cp(join(SPECKIT, "org-pack"), join(root, "org-pack"), { recursive: true });
  const rows = parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[];
  for (const r of rows) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(`bad fixture record ${String(r.id)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(
    join(FIXTURES, "forge-change/openspec/changes", CHANGE),
    join(root, "openspec/changes", CHANGE),
    {
      recursive: true,
    },
  );
  sh(root, "init", "-q");

  const ids = o.repos ?? ["forge-ledger", "forge-portal-bff"];
  const remotes: Record<string, string> = {};
  const manifestPath = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
  const manifest = parse(await readFile(manifestPath, "utf8")) as {
    repos: { id: string; url: string }[];
  };
  for (const id of ids) {
    const work = join(root, "..", `${root.split(/[\\/]/).pop()}-src`, id);
    await cp(join(FORGE, "repos", id), work, { recursive: true });
    sh(work, "init", "-q", "-b", "main");
    sh(work, "add", "-A");
    sh(work, "commit", "-q", "-m", "initial");
    const bare = join(root, "..", `${root.split(/[\\/]/).pop()}-remotes`, `${id}.git`);
    await mkdir(dirname(bare), { recursive: true });
    sh(dirname(bare), "clone", "-q", "--bare", work, bare);
    remotes[id] = bare;
    manifest.repos.find((r) => r.id === id)!.url = bare;
  }
  await writeFile(manifestPath, stringify(manifest));
  if (o.open !== false) {
    const repos = (await loadRepos(root)).filter((r) => ids.includes(r.id));
    const ws = createWorkspace(root, git);
    const synced = await ws.sync(repos);
    const failed = synced.filter((s) => s.action === "failed");
    if (failed.length) throw new Error(`sync failed: ${JSON.stringify(failed)}`);
    await ws.openChange(CHANGE, repos);
  }
  return { root, remotes };
}

export const worktree = (root: string, repo: string, change = CHANGE) =>
  join(root, "workspace/.worktrees", change, repo);

export const read = (path: string) => readFile(path, "utf8");
