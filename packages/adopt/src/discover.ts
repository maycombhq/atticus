import { readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { RepoManifest, type ManifestRepo } from "@maycombhq/core";
import { fsRepo, memoryRepo, type RepoHandle } from "@maycombhq/sdk";
import { detectRepoType, type Detection } from "./detect.js";
import { isDir, readText, slug, toPosix, writeNew } from "./files.js";
import { resolveMetarepo, type MetarepoPaths } from "./layout.js";

/**
 * `atticus repos discover`: find the repos of an estate and propose repos.manifest.yaml
 * entries, with each repo's type detected from its files. Two sources: a local folder of
 * clones, or a Git host organisation listing (through a `RepoListing`, a mock in tests).
 * Owner and system can't be read from files, so they get the placeholder `unassigned` (owner,
 * which C6 requires) or are left out (system), and each becomes an owner question.
 * An existing manifest is never overwritten: discovery then writes a proposal beside it.
 */

/** Owner placeholder: C6 requires an owner slug, and nobody can be guessed from files. */
export const UNASSIGNED = "unassigned";

export interface ListedRepo {
  name: string;
  url: string;
  defaultBranch?: string;
  archived?: boolean;
}

/**
 * The part of a Git host adapter discovery needs: the organisation's repos and a read-only
 * view of each repo's files at its default branch. Real hosts implement it with their tree
 * and contents APIs; tests use `MockRepoListing`. (A candidate additive C4 method on GitHost.)
 */
export interface RepoListing {
  listRepos(org: string): Promise<ListedRepo[]>;
  openRepo(repo: ListedRepo): Promise<RepoHandle>;
}

export class MockRepoListing implements RepoListing {
  constructor(
    private readonly orgs: Record<string, (ListedRepo & { files: Record<string, string> })[]>,
  ) {}
  async listRepos(org: string): Promise<ListedRepo[]> {
    const repos = this.orgs[org];
    if (!repos) throw new Error(`no organisation ${org} on the mock Git host`);
    return repos.map(({ files: _f, ...r }) => r);
  }
  async openRepo(repo: ListedRepo): Promise<RepoHandle> {
    for (const repos of Object.values(this.orgs)) {
      const r = repos.find((x) => x.name === repo.name);
      if (r) return memoryRepo(r.name, "0000000", r.files);
    }
    throw new Error(`no repo ${repo.name} on the mock Git host`);
  }
}

export type DiscoverSource = { dir: string } | { host: RepoListing; org: string };

export interface OwnerQuestion {
  repo: string;
  field: "owner" | "system" | "type";
  question: string;
}

export interface DiscoveredRepo {
  entry: ManifestRepo;
  detection: Detection;
  /** Where the repo is on disk, for local sources. */
  dir?: string;
}

export interface DiscoverResult {
  platform: string;
  repos: DiscoveredRepo[];
  /** Folders looked at that aren't repos. */
  skipped: { path: string; reason: string }[];
  questions: OwnerQuestion[];
  /** What was written: the manifest (none existed), a proposal (one exists), or nothing (dry run). */
  wrote: "manifest" | "proposal" | "nothing";
  /** The file written, relative to the root. */
  file?: string;
  questionsFile?: string;
}

export interface DiscoverOptions {
  /** Profile (platform) the manifest belongs to; default the only profile, else "default". */
  platform?: string;
  /** Write nothing. */
  dryRun?: boolean;
  /**
   * Record local repos by their path under the root (`./<path>`) instead of their clone URL.
   * Adopt uses this; a metarepo of base clones does not.
   */
  inPlace?: boolean;
}

/** origin's URL from .git/config, read as a file (no git call), without credentials. */
async function originUrl(dir: string): Promise<string | undefined> {
  const cfg = await readText(join(dir, ".git", "config"));
  if (!cfg) return undefined;
  const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg);
  return m?.[1]?.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i, "$1");
}

async function headBranch(dir: string): Promise<string | undefined> {
  const head = await readText(join(dir, ".git", "HEAD"));
  return head ? /^ref: refs\/heads\/(\S+)/.exec(head)?.[1] : undefined;
}

const SKIP_FOLDERS = new Set([
  ".git",
  ".atticus",
  ".github",
  ".claude",
  ".specify",
  ".vscode",
  ".idea",
  "node_modules",
  "workspace",
  "openspec",
  "org-pack",
  "catalog",
  "proposals",
  "inputs",
  "specs",
]);

const SELF_IGNORE = [".git", "node_modules", ".atticus", "openspec", "specs", ".specify"];

async function localCandidates(dir: string): Promise<{
  repos: { dir: string; repo: RepoHandle; modules?: string[] }[];
  skipped: DiscoverResult["skipped"];
}> {
  const skipped: DiscoverResult["skipped"] = [];
  const repos: { dir: string; repo: RepoHandle; modules?: string[] }[] = [];
  const builds: string[] = [];
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !SKIP_FOLDERS.has(e.name) && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  for (const name of entries) {
    const sub = join(dir, name);
    const repo = fsRepo(name, sub, "0000000");
    const isClone = await isDir(join(sub, ".git"));
    const det = await detectRepoType(repo);
    if (isClone) repos.push({ dir: sub, repo });
    else if (det.type !== "unknown" || det.component) builds.push(name);
    else skipped.push({ path: name, reason: "no build file, code or platform files" });
  }
  // A folder that is itself a clone is one repo: its subfolders that build are its modules,
  // and a clone inside it is a repo of its own (ADR 0057).
  if (await isDir(join(dir, ".git"))) {
    const nested = repos.map((r) => basename(r.dir));
    const self = fsRepo(basename(resolve(dir)), dir, "0000000", {
      ignore: [...SELF_IGNORE, ...nested],
    });
    return { repos: [{ dir, repo: self, modules: builds }, ...repos], skipped };
  }
  // Otherwise each subfolder that builds is a repo of its own (a folder of clones).
  for (const name of builds)
    repos.push({ dir: join(dir, name), repo: fsRepo(name, join(dir, name), "0000000") });
  repos.sort((a, b) => (basename(a.dir) < basename(b.dir) ? -1 : 1));
  // The folder itself is one repo when it has no repos inside but builds something.
  if (repos.length === 0) {
    const self = fsRepo(basename(resolve(dir)), dir, "0000000", {
      ignore: SELF_IGNORE,
    });
    const det = await detectRepoType(self);
    if ((await isDir(join(dir, ".git"))) || det.type !== "unknown" || det.component)
      return { repos: [{ dir, repo: self }], skipped: [] };
  }
  return { repos, skipped };
}

function questionsFor(entry: ManifestRepo, det: Detection): OwnerQuestion[] {
  const q: OwnerQuestion[] = [];
  if (entry.owner === UNASSIGNED)
    q.push({
      repo: entry.id,
      field: "owner",
      question: `Which team owns ${entry.id}? Set owner in repos.manifest.yaml (a team id from roles.yaml).`,
    });
  if (!entry.system)
    q.push({
      repo: entry.id,
      field: "system",
      question: `Which system does ${entry.id} belong to? Set system in repos.manifest.yaml, or leave it out if the repo serves several.`,
    });
  if (det.type === "unknown")
    q.push({
      repo: entry.id,
      field: "type",
      question: `What kind of repo is ${entry.id}? No build file or platform file told us; set type in repos.manifest.yaml.`,
    });
  return q;
}

/** The manifest's repos; undefined when there is none; null when it can't be read (kept as is). */
async function existingManifest(path: string): Promise<ManifestRepo[] | undefined | null> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  try {
    const r = RepoManifest.safeParse(parse(text));
    return r.success ? r.data.repos : null;
  } catch {
    return null;
  }
}

const HEADER =
  "# Proposed by atticus repos discover. Types come from each repo's files; owners marked\n# `unassigned` and missing systems are questions (see QUESTIONS.md). Review before use.\n";

export async function reposDiscover(
  root: string,
  source: DiscoverSource,
  o: DiscoverOptions = {},
  paths?: MetarepoPaths,
): Promise<DiscoverResult> {
  const p = paths ?? (await resolveMetarepo(root));
  let platform = o.platform;
  if (!platform) {
    try {
      const profiles = (await readdir(join(p.orgPackDir, "profiles"), { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      platform = profiles.length === 1 ? profiles[0]! : "default";
    } catch {
      platform = "default";
    }
  }

  const found: DiscoveredRepo[] = [];
  let skipped: DiscoverResult["skipped"] = [];
  const used = new Set<string>();
  const uniqueId = (name: string) => {
    let id = slug(name);
    for (let n = 2; used.has(id); n++) id = `${slug(name)}-${n}`;
    used.add(id);
    return id;
  };

  if ("dir" in source) {
    const c = await localCandidates(source.dir);
    skipped = c.skipped;
    for (const { dir, repo, modules } of c.repos) {
      const det = await detectRepoType(repo);
      const rel = toPosix(relative(root, dir));
      const inside = !rel.startsWith("..") && !isAbsolute(rel);
      const url =
        o.inPlace && inside
          ? rel === ""
            ? "."
            : `./${rel}`
          : ((await originUrl(dir)) ?? toPosix(resolve(dir)));
      const entry: ManifestRepo = {
        id: uniqueId(dir === source.dir ? basename(resolve(dir)) : basename(dir)),
        url,
        defaultBranch: (await headBranch(dir)) ?? "main",
        type: det.type,
        owner: UNASSIGNED,
        extractors: [],
        dialects: [],
        sparse: [],
        archived: false,
        hosts: [],
        modules: (modules ?? []).map((m) => ({ path: m, component: slug(m), hosts: [] })),
      };
      found.push({ entry, detection: det, dir });
    }
  } else {
    const listed = (await source.host.listRepos(source.org)).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const l of listed) {
      const det = await detectRepoType(await source.host.openRepo(l));
      found.push({
        entry: {
          id: uniqueId(l.name),
          url: l.url,
          defaultBranch: l.defaultBranch ?? "main",
          type: det.type,
          owner: UNASSIGNED,
          extractors: [],
          dialects: [],
          sparse: [],
          archived: l.archived ?? false,
          hosts: [],
          modules: [],
        },
        detection: det,
      });
    }
  }

  const questions = found.flatMap((f) => questionsFor(f.entry, f.detection));
  const manifestPath = join(p.orgPackDir, "profiles", platform, "repos.manifest.yaml");
  const current = await existingManifest(manifestPath);
  const result: DiscoverResult = { platform, repos: found, skipped, questions, wrote: "nothing" };
  if (o.dryRun) return result;

  const doc = (repos: ManifestRepo[]) =>
    stringify(
      {
        schemaVersion: 1,
        platform,
        repos: repos.map((r) => ({
          id: r.id,
          url: r.url,
          defaultBranch: r.defaultBranch,
          type: r.type,
          owner: r.owner,
          ...(r.system ? { system: r.system } : {}),
          ...(r.component ? { component: r.component } : {}),
          ...(r.archived ? { archived: true } : {}),
          ...(r.modules.length
            ? {
                modules: r.modules.map((m) => ({
                  path: m.path,
                  component: m.component,
                  ...(m.hosts.length ? { hosts: m.hosts } : {}),
                })),
              }
            : {}),
        })),
      },
      { lineWidth: 0 },
    );
  const proposalDir = join(p.proposalsDir, "repos", platform);
  if (current === undefined || (current !== null && current.length === 0)) {
    // No manifest, or the empty one init wrote: nothing a person wrote is replaced.
    await writeNew(manifestPath, HEADER + doc(found.map((f) => f.entry)), false);
    result.wrote = "manifest";
    result.file = toPosix(relative(root, manifestPath));
  } else {
    // Keep every existing entry as it is; add only repos the manifest doesn't list.
    const kept = current ?? [];
    const have = new Set(kept.flatMap((r) => [r.id, r.url]));
    const added = found.filter((f) => !have.has(f.entry.id) && !have.has(f.entry.url));
    const file = join(proposalDir, "repos.manifest.yaml");
    await writeNew(file, HEADER + doc([...kept, ...added.map((a) => a.entry)]), false);
    result.wrote = "proposal";
    result.file = toPosix(relative(root, file));
  }
  if (questions.length) {
    const qf = join(proposalDir, "QUESTIONS.md");
    await writeNew(
      qf,
      [
        `# Questions for ${platform}`,
        "",
        "Discovery read files only; these need a person.",
        "",
        ...questions.map((q) => `- [ ] ${q.repo} (${q.field}): ${q.question}`),
        "",
      ].join("\n"),
      false,
    );
    result.questionsFile = toPosix(relative(root, qf));
  }
  return result;
}
