import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { writeChangeRepos } from "@maycombhq/workspace";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, "fixtures");
export const FORGE = join(HERE, "../../../fixtures/forge");
export const FORGE_CHANGE = join(HERE, "../../../fixtures/forge-change");
export const CHANGE = "add-transfer-limit";
export const NOW = new Date("2026-10-21T09:00:00Z");

export const changeDir = (root: string) => join(root, "openspec/changes", CHANGE);
export const worktree = (root: string, repo: string) =>
  join(root, "workspace/.worktrees", CHANGE, repo);
export const read = (p: string) => readFile(p, "utf8");
export const expected = (f: string) => readFileSync(join(FIXTURES, "expected", f), "utf8");

/**
 * A metarepo for the M3 exit fixture with planned stories: the Forge org pack with the
 * forge-change additions, the Forge expected catalog, the change add-transfer-limit with the
 * hand-written stories, tasks and interfaces of this package's fixture, and change worktrees
 * for forge-ledger (with the spec updated for the change) and forge-portal-bff.
 */
export async function forgeChangeRoot(o: { worktrees?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-testgen-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(FORGE_CHANGE, "org-pack"), join(root, "org-pack"), { recursive: true });
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
  const dir = changeDir(root);
  await cp(join(FORGE_CHANGE, "openspec/changes", CHANGE), dir, { recursive: true });
  await rm(join(dir, "stories"), { recursive: true, force: true });
  await cp(join(FIXTURES, "change"), dir, { recursive: true });
  await cp(join(FORGE, "inputs"), join(root, "inputs"), { recursive: true });
  if (o.worktrees !== false) {
    for (const repo of ["forge-ledger", "forge-portal-bff"])
      await cp(join(FORGE, "repos", repo), worktree(root, repo), { recursive: true });
    await cp(join(FIXTURES, "worktree/forge-ledger"), worktree(root, "forge-ledger"), {
      recursive: true,
    });
    await writeChangeRepos(root, {
      schemaVersion: 1,
      change: CHANGE,
      repos: ["forge-ledger", "forge-portal-bff"].map((id) => ({
        id,
        branch: `change/${CHANGE}`,
        base: "main",
        worktree: `workspace/.worktrees/${CHANGE}/${id}`,
        build: { status: "not-run" as const },
      })),
    });
  }
  return root;
}
