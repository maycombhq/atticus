import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  parseRecord,
  Recording,
  recordPath,
  serializeRecord,
  type CatalogRecord,
} from "@maycombhq/core";
import { readPage, type KnowledgePage } from "@maycombhq/knowledge";
import { writeChangeRepos } from "@maycombhq/workspace";

/**
 * The built-in datasets are seeded from the fixtures every other package is tested on (the
 * Forge estate, the forge-change exit fixture, the dialect eval, and the hand-written
 * recordings beside each agent's package), read in place: nothing expected is copied here.
 * They need the Atticus checkout; an organisation's own datasets (org-pack/evals) don't.
 */

export const SEEDED_CHANGE = "add-transfer-limit";

/** The Atticus checkout's root, found by walking up from this package. */
export function findRepoRoot(start = dirname(fileURLToPath(import.meta.url))): string | undefined {
  let d = resolve(start);
  for (;;) {
    if (
      existsSync(join(d, "fixtures", "forge-change", "README.md")) &&
      existsSync(join(d, "packages"))
    )
      return d;
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

export const tempDir = (prefix: string) => mkdtemp(join(tmpdir(), `atticus-evals-${prefix}-`));

const rows = (file: string) => parse(readFileSync(file, "utf8")) as Record<string, unknown>[];

/** The Forge expected catalog (hand-written) as records. */
export function forgeRecords(repoRoot: string): CatalogRecord[] {
  return rows(join(repoRoot, "fixtures/forge/expected/scan.yaml")).map((r) => {
    const p = parseRecord({ schemaVersion: 2, status: "current", ...r });
    if (!p.ok) throw new Error(`bad fixture record ${String(r.id)}`);
    return p.record;
  });
}

/** Forge's wiki pages as the knowledge sources hand them over. */
export function forgePages(repoRoot: string): KnowledgePage[] {
  const dir = join(repoRoot, "fixtures/forge/inputs/wiki");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) =>
      readPage({
        source: "forge-wiki",
        path: `inputs/wiki/${f}`,
        pagePath: f,
        content: readFileSync(join(dir, f), "utf8"),
      }),
    );
}

/**
 * A metarepo for the M3 exit fixture: the Forge org pack with the forge-change additions, the
 * Forge expected catalog as catalog files, and the change. `plan: false` removes the hand-written
 * planning artifacts so the planner starts from the approved design.
 */
export async function forgeChangeRoot(
  repoRoot: string,
  o: { plan?: boolean; inputs?: boolean; dir?: string } = {},
): Promise<string> {
  const root = o.dir ?? (await tempDir("forge-change"));
  const forge = join(repoRoot, "fixtures/forge");
  const fc = join(repoRoot, "fixtures/forge-change");
  await cp(join(forge, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(fc, "org-pack"), join(root, "org-pack"), { recursive: true });
  for (const r of forgeRecords(repoRoot)) {
    const f = join(root, "catalog/generated", recordPath(r));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(r));
  }
  const dir = join(root, "openspec/changes", SEEDED_CHANGE);
  await cp(join(fc, "openspec/changes", SEEDED_CHANGE), dir, { recursive: true });
  if (o.plan === false)
    for (const f of ["stories.md", "tasks.md", "snow.md", "stories"])
      await rm(join(dir, f), { recursive: true, force: true });
  if (o.inputs) await cp(join(forge, "inputs"), join(root, "inputs"), { recursive: true });
  return root;
}

/** The test writer's metarepo: planned stories of the testgen fixture and change worktrees. */
export async function testgenRoot(repoRoot: string): Promise<string> {
  const root = await forgeChangeRoot(repoRoot, { inputs: true });
  const fx = join(repoRoot, "packages/testgen/test/fixtures");
  const dir = join(root, "openspec/changes", SEEDED_CHANGE);
  await rm(join(dir, "stories"), { recursive: true, force: true });
  await cp(join(fx, "change"), dir, { recursive: true });
  const wt = (repo: string) => join(root, "workspace/.worktrees", SEEDED_CHANGE, repo);
  for (const repo of ["forge-ledger", "forge-portal-bff"])
    await cp(join(repoRoot, "fixtures/forge/repos", repo), wt(repo), { recursive: true });
  await cp(join(fx, "worktree/forge-ledger"), wt("forge-ledger"), { recursive: true });
  await writeChangeRepos(root, {
    schemaVersion: 1,
    change: SEEDED_CHANGE,
    repos: ["forge-ledger", "forge-portal-bff"].map((id) => ({
      id,
      branch: `change/${SEEDED_CHANGE}`,
      base: "main",
      worktree: `workspace/.worktrees/${SEEDED_CHANGE}/${id}`,
      build: { status: "not-run" as const },
    })),
  });
  return root;
}

/** The template writer's metarepo: Forge's inputs beside the org pack, without the firewall template. */
export async function templatesRoot(repoRoot: string): Promise<string> {
  const root = await forgeChangeRoot(repoRoot, { inputs: true });
  await writeFile(
    join(root, "org-pack/sources.yaml"),
    "schemaVersion: 1\nwikis:\n  - { id: forge-wiki, type: markdown-folder, location: ../inputs/wiki, owner: team-platform }\n",
  );
  await rm(join(root, "org-pack/process/snow/firewall-rule.yaml"));
  return root;
}

/** Every recording under a folder (`<agent>/<sha>.json` or a flat folder of one agent's). */
export function readRecordings(dir: string): Recording[] {
  if (!existsSync(dir)) return [];
  const out: Recording[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p);
      else if (n.name.endsWith(".json"))
        out.push(Recording.parse(JSON.parse(readFileSync(p, "utf8"))));
    }
  };
  walk(dir);
  return out;
}

/** The recorded answers by agent: what the mock runtime gives back (the hand-written answer). */
export function referenceAnswers(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of readRecordings(dir)) out[r.agent] ??= r.output;
  return out;
}
