import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";
import { parse } from "yaml";
import {
  catalogDirOf,
  ManifestEditError,
  orgPackDirOf,
  REPO_DESCRIPTION_MAX,
  RepoDescription,
  RepoManifest,
  setManifestDescription,
  eolOf,
  inEol,
  writeFileIfUnchanged,
  type CatalogRecord,
} from "@maycombhq/core";
import { diffCatalogs, readCatalog } from "@maycombhq/scanner";
import {
  baseClonePath,
  branchSlug,
  checkoutState,
  gitUser,
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
      // What it is, in a person's words, or a draft nobody has confirmed (ADR 0128).
      ...(r.description ? { description: r.description } : {}),
      defaultBranch: r.defaultBranch,
      ...(remoteDefault ? { remoteDefault } : {}),
      branches: r.branches,
      ...(commit ? { commit } : {}),
      // Seventh UX walk: the build command a task's PR waits on, shown and set on Repos.
      ...(r.build ? { build: r.build } : {}),
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
  const before = await readCatalog(join(cat, "generated"), { cacheRoot: root });
  const after = await readCatalog(join(cat, "branches", branchSlug(branch), "generated"), {
    cacheRoot: root,
  });
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
    readonly code: "not-found" | "invalid" | "conflict",
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
  set: {
    defaultBranch?: string;
    branches?: string[];
    was?: { defaultBranch: string; branches: string[] };
  },
): Promise<string> {
  const repo = (await loadRepos(root)).find((r) => r.id === repoId);
  if (!repo) throw new RepoEditError("not-found", `There is no repo ${repoId} in any manifest.`);
  // The form showed other branches than the manifest has now (a teammate's pull): never
  // written over, said so.
  if (
    set.was &&
    (set.was.defaultBranch !== repo.defaultBranch ||
      set.was.branches.join("\n") !== repo.branches.join("\n"))
  )
    throw new RepoEditError(
      "conflict",
      `${repoId}'s branches changed in the manifest since you opened the form (now ${repo.defaultBranch}, ${repo.branches.join(", ") || "no others"}): open Edit again to see them, then save.`,
    );
  const rel = `org-pack/profiles/${repo.platform}/repos.manifest.yaml`;
  const file = join(orgPackDirOf(root), "profiles", repo.platform, "repos.manifest.yaml");
  const was = await readFile(file, "utf8");
  const doc = parseDocument(was);
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
  await writeFileIfUnchanged(
    file,
    was,
    inEol(doc.toString({ flowCollectionPadding: true }), eolOf(was)),
  );
  return rel;
}

/**
 * Set or clear a repo's build command in its manifest (seventh UX walk): what `build` in
 * repos.manifest.yaml says, the command a task's draft is built and tested with before its PR is
 * raised. One line; the rest of the file and its comments stay; the result is checked against the
 * manifest schema before it is written. A form that showed another command than the manifest has
 * now is refused, never written over. Returns the manifest's path, relative to the metarepo.
 */
export async function editRepoBuild(
  root: string,
  repoId: string,
  set: { build: string; was?: string },
): Promise<{ file: string; build?: string }> {
  const repo = (await loadRepos(root)).find((r) => r.id === repoId);
  if (!repo) throw new RepoEditError("not-found", `There is no repo ${repoId} in any manifest.`);
  if (set.was !== undefined && set.was !== (repo.build ?? ""))
    throw new RepoEditError(
      "conflict",
      `${repoId}'s build command changed in the manifest since you opened the form (now ${repo.build ? `\`${repo.build}\`` : "none"}): open it again to see it, then save.`,
    );
  const build = set.build.trim();
  if (/[\r\n]/.test(build))
    throw new RepoEditError(
      "invalid",
      "A build command is one line: join the steps with && (for example npm ci && npm test).",
    );
  const rel = `org-pack/profiles/${repo.platform}/repos.manifest.yaml`;
  const file = join(orgPackDirOf(root), "profiles", repo.platform, "repos.manifest.yaml");
  const was = await readFile(file, "utf8");
  const doc = parseDocument(was);
  const list = doc.get("repos");
  const item = isSeq(list) ? list.items.find((x) => isMap(x) && x.get("id") === repoId) : undefined;
  if (!isMap(item)) throw new RepoEditError("not-found", `${rel} doesn't list ${repoId}.`);
  if (build) item.set("build", build);
  else item.delete("build");
  const check = RepoManifest.safeParse(doc.toJS());
  if (!check.success)
    throw new RepoEditError(
      "invalid",
      check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  await writeFileIfUnchanged(
    file,
    was,
    inEol(doc.toString({ flowCollectionPadding: true }), eolOf(was)),
  );
  return { file: rel, ...(build ? { build } : {}) };
}

/**
 * Say what a repo is, confirm the draft the assistant wrote, or drop it (ADR 0128). A line a
 * person types or confirms is theirs: it is written as `verified` with their handle and the
 * time, so a draft stops being marked unconfirmed. Returns the manifest's path and the line.
 */
export async function editRepoDescription(
  root: string,
  repoId: string,
  set: { text?: string; accept?: boolean; reject?: boolean; was?: string },
  o: { by?: string; now?: Date } = {},
): Promise<{ file: string; description?: RepoDescription }> {
  const repo = (await loadRepos(root)).find((r) => r.id === repoId);
  if (!repo) throw new RepoEditError("not-found", `There is no repo ${repoId} in any manifest.`);
  if (set.was !== undefined && set.was !== (repo.description?.text ?? ""))
    throw new RepoEditError(
      "conflict",
      `What ${repoId} is changed in the manifest since you opened the form: open Edit again to see it, then save.`,
    );
  const now = o.now ?? new Date();
  let next: RepoDescription | undefined;
  if (!set.reject) {
    const text = set.text?.trim() || (set.accept ? repo.description?.text : undefined);
    if (!text)
      throw new RepoEditError(
        "invalid",
        set.accept
          ? `${repoId} has no drafted description to confirm. Write one instead.`
          : `Say what ${repoId} is, in one line.`,
      );
    if (text.length > REPO_DESCRIPTION_MAX)
      throw new RepoEditError(
        "invalid",
        `That is ${text.length} characters; a description is one line, up to ${REPO_DESCRIPTION_MAX}.`,
      );
    const by =
      o.by ??
      (await gitUser(root).then(
        (u) => u.handle,
        () => "someone",
      ));
    next = RepoDescription.parse({
      text,
      trust: "verified",
      by,
      at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
  } else if (!repo.description)
    throw new RepoEditError("invalid", `${repoId} has no description to drop.`);
  try {
    const f = await setManifestDescription(root, repoId, next);
    return { file: f.rel, ...(next ? { description: next } : {}) };
  } catch (e) {
    if (e instanceof ManifestEditError)
      throw new RepoEditError(e.code === "not-found" ? "not-found" : "invalid", e.message);
    throw e;
  }
}
