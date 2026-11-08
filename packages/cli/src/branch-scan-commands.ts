import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { catalogDirOf, writeFileAtomic, type CatalogRecord } from "@maycombhq/core";
import { diffCatalogs, readCatalog, scanEstate, writeCatalog } from "@maycombhq/scanner";
import { branchSlug, createWorkspace, isInPlace, loadRepos } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import { diffLines } from "./scan-commands.js";

/**
 * atticus scan --ref <branch> [--repos a,b] (ADR 0123): another branch scanned beside the
 * baseline. Each repo's branch is checked out read-only beside its base clone; the catalog is
 * kept in catalog/branches/<branch>/generated with branch.yaml (the branch, when, and each repo's
 * commit), and compared with the baseline's records from the same repos. The baseline
 * (catalog/generated, the hand-off PRs) is never written. Exit 0 read, 1 a repo or record had a
 * problem, 2 for a branch that is the baseline or that no repo lists.
 */

/** Where a branch's catalog is kept, relative to the catalog folder. */
export const branchCatalogRel = (branch: string) => `branches/${branchSlug(branch)}`;

const fromRepos = (records: CatalogRecord[], repos: Set<string>) =>
  records.filter((r) => r.evidence.some((e) => e.repo && repos.has(e.repo)));

export async function scanBranch(
  root: string,
  branch: string,
  o: { repos?: string[]; full?: boolean; json?: boolean },
  io: Output,
): Promise<number> {
  const all = (await loadRepos(root)).filter((r) => !r.archived && !isInPlace(r.url));
  const named = o.repos?.length ? all.filter((r) => o.repos!.includes(r.id)) : undefined;
  const baseline = (named ?? all).filter((r) => r.defaultBranch === branch);
  if (baseline.length) {
    io.err(
      `${branch} is the default branch of ${baseline.map((r) => r.id).join(", ")}: its catalog is the baseline. Run atticus scan for it.`,
    );
    return 2;
  }
  const repos = named ?? all.filter((r) => r.branches.includes(branch));
  if (!repos.length) {
    io.err(
      `No repo lists ${branch} under branches in its manifest. Add it there (or on Set up › Repos), or name the repos: atticus scan --ref ${branch} --repos <id>,<id>.`,
    );
    return 2;
  }
  const ws = createWorkspace(root);
  const dirs = new Map<string, string>();
  const commits: { id: string; commit: string }[] = [];
  let problems = 0;
  for (const r of repos)
    try {
      const c = await ws.checkoutBranch(r, branch);
      dirs.set(r.id, c.dir);
      commits.push({ id: r.id, commit: c.commit });
    } catch (e) {
      io.err(`${(e as Error).message}; it is left out of this scan.`);
      problems++;
    }
  if (!dirs.size) return 1;
  const ids = [...dirs.keys()];
  const scannedAt = new Date().toISOString();
  const scan = await scanEstate({
    root,
    repos: ids,
    repoDir: (id) => dirs.get(id)!,
    // The branch's code only: inputs/ and other metarepos belong to the baseline.
    inputsDir: null,
    federated: [],
    scannedAt,
    ...(o.full ? { cache: null } : {}),
  });
  const rel = branchCatalogRel(branch);
  const dir = join(catalogDirOf(root), ...rel.split("/"));
  const ofRepos = new Set(ids);
  // Merged with what an earlier scan of this branch kept for other repos (Set up › Repos scans
  // one repo's row at a time): their records and commits stay; only this scan's repos are new.
  const kept = await readCatalog(join(dir, "generated"), { cacheRoot: root }).catch(() => ({
    records: [] as CatalogRecord[],
  }));
  const others = kept.records.filter(
    (r) => r.evidence.length > 0 && r.evidence.every((e) => !e.repo || !ofRepos.has(e.repo)),
  );
  const ids2 = new Set(scan.records.map((r) => `${r.kind}/${r.id}`));
  const merged = [...scan.records, ...others.filter((r) => !ids2.has(`${r.kind}/${r.id}`))];
  const write = await writeCatalog(join(dir, "generated"), merged);
  const was =
    (
      parse(await readFile(join(dir, "branch.yaml"), "utf8").catch(() => "")) as
        { repos?: { id: string; commit: string }[] } | undefined
    )?.repos ?? [];
  await writeFileAtomic(
    join(dir, "branch.yaml"),
    stringify({
      schemaVersion: 1,
      branch,
      scannedAt,
      repos: [...was.filter((x) => !ofRepos.has(x.id)), ...commits].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      ),
    }),
  );
  const before = await readCatalog(join(catalogDirOf(root), "generated"), { cacheRoot: root });
  const diff = diffCatalogs(fromRepos(before.records, ofRepos), fromRepos(scan.records, ofRepos));
  problems += scan.problems.length;
  if (o.json) {
    io.out(
      JSON.stringify(
        { branch, repos: commits, folder: `catalog/${rel}`, diff, problems: scan.problems },
        null,
        2,
      ),
    );
    return problems ? 1 : 0;
  }
  io.out(
    `Scanned ${branch} of ${ids.join(", ")}: ${scan.records.length} records in catalog/${rel}/generated (${write.written} written, ${write.unchanged} unchanged, ${write.removed} removed).`,
  );
  const lines = diffLines(diff);
  io.out(`${branch} against the baseline: ${lines[0]}`);
  for (const l of lines.slice(1)) io.out(l);
  for (const p of scan.problems)
    io.err(`${"repo" in p && p.repo ? `${p.repo}: ` : ""}${p.message}`);
  io.out(
    `The baseline (catalog/generated) is unchanged: a branch is compared with it, never merged into it.`,
  );
  return problems ? 1 : 0;
}
