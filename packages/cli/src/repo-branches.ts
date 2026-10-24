import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";
import { parse } from "yaml";
import {
  catalogDirOf,
  orgPackDirOf,
  RepoManifest,
  writeFileAtomic,
  type CatalogRecord,
} from "@maycombhq/core";
import { diffCatalogs, readCatalog } from "@maycombhq/scanner";
import {
  baseClonePath,
  branchSlug,
  checkoutState,
  loadRepos,
  remoteDefaultBranch,
} from "@maycombhq/workspace";

/**
 * Branches you can see and choose (ADR 0123), from files only: each repo's default branch (the
 * manifest's and the remote's, as the base clone last heard it), its named branches, the commit
 * the baseline was read from, and the branches scanned beside it (catalog/branches/<b>/); what a
 * branch changes against the baseline; and setting a repo's branches in its manifest.
 */

export interface BranchScan {
  branch: string;
  scannedAt: string;
  repos: { id: string; commit: string }[];
}

async function branchScans(root: string): Promise<BranchScan[]> {
  const dir = join(catalogDirOf(root), "branches");
  const out: BranchScan[] = [];
  for (const d of (await readdir(dir).catch(() => [] as string[])).sort()) {
    const text = await readFile(join(dir, d, "branch.yaml"), "utf8").catch(() => undefined);
    if (!text) continue;
    const m = parse(text) as Partial<BranchScan>;
    if (typeof m.branch === "string" && typeof m.scannedAt === "string" && Array.isArray(m.repos))
      out.push({ branch: m.branch, scannedAt: m.scannedAt, repos: m.repos });
  }
  return out;
}

export async function repoBranches(root: string) {
  const scans = await branchScans(root);
  const repos = [];
  for (const r of await loadRepos(root)) {
    if (r.archived) continue;
    const base = baseClonePath(root, r.id);
    const remoteDefault = await remoteDefaultBranch(base);
    const commit = await checkoutState(base).then(
      (s) => s.commit,
      () => undefined,
    );
    repos.push({
      id: r.id,
      platform: r.platform,
      url: r.url,
      type: r.type,
      owner: r.owner,
      defaultBranch: r.defaultBranch,
      ...(remoteDefault ? { remoteDefault } : {}),
      branches: r.branches,
      ...(commit ? { commit } : {}),
      scans: scans.flatMap((s) =>
        s.repos
          .filter((x) => x.id === r.id)
          .map((x) => ({ branch: s.branch, scannedAt: s.scannedAt, commit: x.commit })),
      ),
    });
  }
  return { repos };
}

const key = (r: { kind: string; id: string }) => `${r.kind}/${r.id}`;

/** What a branch scanned beside the baseline changes against it, for the repos it read. */
export async function compareBranch(root: string, branch: string) {
  const scan = (await branchScans(root)).find((s) => s.branch === branch);
  if (!scan) return undefined;
  const ids = new Set(scan.repos.map((r) => r.id));
  const ofRepos = (records: CatalogRecord[]) =>
    records.filter((r) => r.evidence.some((e) => e.repo && ids.has(e.repo)));
  const cat = catalogDirOf(root);
  const before = await readCatalog(join(cat, "generated"));
  const after = await readCatalog(join(cat, "branches", branchSlug(branch), "generated"));
  const d = diffCatalogs(ofRepos(before.records), ofRepos(after.records));
  return {
    branch,
    scannedAt: scan.scannedAt,
    repos: scan.repos,
    added: d.added.map(key),
    removed: d.removed.map(key),
    changed: d.changed.map((c) => ({ record: key(c), fields: c.fields })),
  };
}

export class RepoEditError extends Error {
  constructor(
    readonly code: "not-found" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Set a repo's default branch and named branches in its manifest, keeping the rest of the file
 * and its comments; the result is checked against the manifest schema before it is written.
 * Returns the manifest's path, relative to the metarepo.
 */
export async function editRepoBranches(
  root: string,
  repoId: string,
  set: { defaultBranch?: string; branches?: string[] },
): Promise<string> {
  const repo = (await loadRepos(root)).find((r) => r.id === repoId);
  if (!repo) throw new RepoEditError("not-found", `There is no repo ${repoId} in any manifest.`);
  const rel = `org-pack/profiles/${repo.platform}/repos.manifest.yaml`;
  const file = join(orgPackDirOf(root), "profiles", repo.platform, "repos.manifest.yaml");
  const doc = parseDocument(await readFile(file, "utf8"));
  const list = doc.get("repos");
  const item = isSeq(list) ? list.items.find((x) => isMap(x) && x.get("id") === repoId) : undefined;
  if (!isMap(item)) throw new RepoEditError("not-found", `${rel} doesn't list ${repoId}.`);
  const branches = set.branches?.map((b) => b.trim()).filter(Boolean);
  const def = set.defaultBranch?.trim() || repo.defaultBranch;
  if (branches?.includes(def))
    throw new RepoEditError(
      "invalid",
      `${def} is the default branch: its catalog is the baseline, so it isn't one of the branches scanned beside it.`,
    );
  if (set.defaultBranch?.trim()) item.set("defaultBranch", set.defaultBranch.trim());
  if (branches) {
    if (branches.length) item.set("branches", doc.createNode([...new Set(branches)]));
    else item.delete("branches");
  }
  const check = RepoManifest.safeParse(doc.toJS());
  if (!check.success)
    throw new RepoEditError(
      "invalid",
      check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  await writeFileAtomic(file, doc.toString({ flowCollectionPadding: true }));
  return rel;
}
