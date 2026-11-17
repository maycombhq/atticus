import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { isSeq, parse, parseDocument, stringify } from "yaml";
import {
  eolOf,
  inEol,
  RepoManifest,
  throwIfCancelled,
  walkRepo,
  WORKSPACE_SCHEMA_VERSION,
  type ManifestRepo,
} from "@maycombhq/core";
import { DEFAULT_IGNORES, fsRepo, globToRegExp, memoryRepo, type RepoHandle } from "@maycombhq/sdk";
import { cloneUrlKey, createGit, type GitRunner } from "@maycombhq/workspace";
import { detectRepoType, type Detection } from "./detect.js";
import { AdoptError } from "./errors.js";
import { exists, isDir, readText, slug, toPosix, writeNew } from "./files.js";
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
  /** Folders looked at that aren't repos, and folders that took too long to read, with why. */
  skipped: { path: string; reason: string }[];
  /**
   * Folders that are a repo the manifest lists already (the same clone URL, or the same path for
   * a repo kept in place), with the id it has there: told before anything of them is read, and
   * left out of `repos` and the questions. Local sources only.
   */
  listed: { path: string; id: string; url: string }[];
  questions: OwnerQuestion[];
  /**
   * Round 50: found repos given another id because the manifest lists theirs already for another
   * repo (another clone URL), with why. The same repo (same clone URL) is left out instead.
   */
  renamed: { from: string; to: string; why: string }[];
  /** What was written: the manifest (none existed), a proposal (one exists), or nothing (dry run). */
  wrote: "manifest" | "proposal" | "nothing";
  /** The file written, relative to the root. */
  file?: string;
  questionsFile?: string;
}

export interface DiscoverOptions {
  /**
   * Profile (platform) the manifest belongs to; default the only profile, or "default" when there
   * is none. With two or more, it must be named (round 50).
   */
  platform?: string;
  /** Write nothing. */
  dryRun?: boolean;
  /**
   * Record local repos by their path under the root (`./<path>`) instead of their clone URL.
   * Adopt uses this; a metarepo of base clones does not.
   */
  inPlace?: boolean;
  /** The git runner origin is asked of (local, no network); default the git on PATH. */
  git?: GitRunner;
  /**
   * Repos listed somewhere else than this platform's manifest (the app gives every platform's):
   * a folder that is one of them is `listed` too, and isn't read.
   */
  known?: readonly { id: string; url: string }[];
  /**
   * Told of each folder as discovery comes to it, before it is read: its name, where it is
   * among the folders (`index` of `total`, from 1), and the id it has when the manifest lists it
   * already (then it isn't read).
   */
  onFolder?: (f: {
    folder: string;
    index: number;
    total: number;
    listed?: string;
    // Waited for when it gives a promise (the app's job says its line, and hears Stop, there).
  }) => unknown;
  /**
   * How long one folder may take to read, in milliseconds (default a minute): past it the folder
   * is skipped, saying so, and the rest are still read.
   */
  repoTimeoutMs?: number;
  /** The clock the bound is read from; default the machine's. Tests give their own. */
  clock?: () => number;
}

/** How long one folder may take to read before it is skipped. */
export const REPO_READ_MS = 60_000;

/** A folder took longer to read than it may. */
class TooSlow extends Error {}

/** The time one folder has: `check` throws once it is spent. */
interface Bound {
  check(): void;
}

function boundOf(ms: number, clock: () => number): Bound {
  const until = clock() + ms;
  return {
    check() {
      if (clock() > until) throw new TooSlow();
    },
  };
}

/** Why a folder that took too long was skipped, and what to do instead. */
const tooSlowReason = (ms: number) =>
  `took too long to read (over ${ms / 1000} second${ms === 1000 ? "" : "s"}); add it by its clone URL`;

/**
 * An http(s) URL without its credentials (`user:password@`, or a token as the user): Git's
 * credential manager supplies them, and a manifest never holds one. An ssh URL's user
 * (`ssh://git@host/...`, `git@host:path`) is how it signs in, never a secret: kept.
 */
export function withoutCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@]*@/i, "$1");
}

/**
 * origin's URL, asked of Git (`git config`, local, no network), the way repo add and workspace
 * sync --from read it: Git undoes the config file's quoting and escapes (a Windows path's `\\`, a
 * URL with spaces) and reads `url`, never `pushurl`. Without http credentials.
 */
async function originUrl(dir: string, git: GitRunner): Promise<string | undefined> {
  // A clone's own config is read as a file Git parses (a folder that is only a .git/config and
  // HEAD still answers); a worktree or submodule (.git is a file) is asked through its folder.
  // A folder with no .git of its own has no origin: never the one of a repository it sits in.
  if (!(await exists(join(dir, ".git")))) return undefined;
  const asked = (await isDir(join(dir, ".git")))
    ? ["config", "--file", join(dir, ".git", "config"), "--get", "remote.origin.url"]
    : ["config", "--get", "remote.origin.url"];
  const url = await git(asked, dir).then(
    (r) => r.stdout.replace(/\r?\n$/, ""),
    () => "",
  );
  return url ? withoutCredentials(url) : undefined;
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

/**
 * Below a folder: the hidden folders' names (`.claude`, `.github`), never looked inside, and the
 * nested clones and worktrees (a `.git` folder or file), by path. node_modules and build output
 * aren't walked.
 */
async function hiddenAndNested(
  dir: string,
  bound?: Bound,
): Promise<{ hidden: string[]; nested: string[] }> {
  const hidden = new Set<string>();
  const nested: string[] = [];
  const walk = async (abs: string, rel: string) => {
    bound?.check();
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) {
        hidden.add(e.name);
        continue;
      }
      if ((DEFAULT_IGNORES as readonly string[]).includes(e.name)) continue;
      const sub = join(abs, e.name);
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (await exists(join(sub, ".git"))) nested.push(path);
      else await walk(sub, path);
    }
  };
  await walk(dir, "");
  return { hidden: [...hidden].sort(), nested: nested.sort() };
}

/**
 * The folder as detection reads it: no file under a hidden folder, node_modules, or a nested
 * clone or worktree, so an assistant's worktree under `.claude/` (and the test fixtures in it)
 * never decides what a repo is. Listed as `fsRepo` lists a checkout (the same walker, the same
 * order, .gitignore honoured, a file over 5 MB left out), but those folders aren't walked at all
 * rather than walked and left out, and the walk stops once the folder's time is spent (`bound`).
 */
async function visibleRepo(
  name: string,
  dir: string,
  ignore: readonly string[] = DEFAULT_IGNORES,
  bound?: Bound,
): Promise<RepoHandle> {
  const { hidden, nested } = await hiddenAndNested(dir, bound);
  const h = fsRepo(name, dir, "0000000", { ignore: [...new Set([...ignore, ...hidden])] });
  const root = resolve(dir);
  const left = new Set(ignore);
  const inner = new Set(nested);
  let files: string[] | undefined;
  const all = async () => {
    if (!files) {
      const out: string[] = [];
      await walkRepo(
        root,
        async (p) => {
          bound?.check();
          out.push(p);
        },
        {
          skipFolder: (above, folder) => {
            bound?.check();
            return (
              left.has(folder) ||
              folder.startsWith(".") ||
              folder === "node_modules" ||
              inner.has([...above, folder].join("/"))
            );
          },
        },
      );
      files = out.sort();
    }
    return files;
  };
  /** Each matched file's size, read once: one over the limit isn't listed (as fsRepo). */
  const sizes = new Map<string, number>();
  return {
    name: h.name,
    commit: h.commit,
    async *listFiles(globs) {
      const matchers = globs.map(globToRegExp);
      for (const p of await all()) {
        bound?.check();
        if (!matchers.some((m) => m.test(p))) continue;
        if (!sizes.has(p))
          sizes.set(p, (await stat(join(root, ...p.split("/"))).catch(() => undefined))?.size ?? 0);
        if (sizes.get(p)! > h.maxFileBytes) continue;
        yield p;
      }
    },
    readText: (p) => h.readText(p),
  };
}

/** What reading a folder of clones needs from the discovery it is part of. */
interface LocalRead {
  /** The repo a folder is in a manifest already, told by its clone URL alone (nothing read). */
  listedAs(dir: string): Promise<{ id: string; url: string } | undefined>;
  onFolder?: DiscoverOptions["onFolder"];
  /** The time one folder has, from now. */
  bound(): Bound;
  /** That time, for the words of a folder skipped for it. */
  timeoutMs: number;
}

/** A repo found in the folder: read (its detection), or listed already and not read. */
interface LocalRepo {
  dir: string;
  modules?: string[];
  detection?: Detection;
  listed?: { id: string; url: string };
}

async function localCandidates(
  dir: string,
  read: LocalRead,
): Promise<{ repos: LocalRepo[]; skipped: DiscoverResult["skipped"] }> {
  const skipped: DiscoverResult["skipped"] = [];
  const repos: LocalRepo[] = [];
  const builds: { name: string; detection: Detection }[] = [];
  const listed = (await readdir(dir, { withFileTypes: true }))
    .filter(
      (e) =>
        (e.isDirectory() || e.isSymbolicLink()) &&
        !SKIP_FOLDERS.has(e.name) &&
        !e.name.startsWith("."),
    )
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  // B-run2-fixes 6: a link to a clone (a folder of clones linked to pinned ones) is followed,
  // one level only, and the repo's folder stays the link inside this folder. Never a link to this
  // folder or one it is in (a loop), nor a second link to a clone already read.
  const here = await realpath(dir);
  const real = new Map<string, string>();
  for (const e of listed) if (e.isDirectory()) real.set(await realpath(join(dir, e.name)), e.name);
  const entries: string[] = [];
  for (const e of listed) {
    if (e.isDirectory()) {
      entries.push(e.name);
      continue;
    }
    const to = await realpath(join(dir, e.name)).catch(() => undefined);
    if (!to || !(await isDir(to))) {
      skipped.push({ path: e.name, reason: "a link to nothing" });
      continue;
    }
    const up = relative(to, here);
    if (up === "" || (!up.startsWith("..") && !isAbsolute(up))) {
      skipped.push({ path: e.name, reason: "a link to this folder or one it is in" });
      continue;
    }
    const had = real.get(to);
    if (had) {
      skipped.push({ path: e.name, reason: `a link to ${had}, which is read already` });
      continue;
    }
    real.set(to, e.name);
    entries.push(e.name);
  }
  /** One folder's files and what they say it is; undefined, and skipped, when it took too long. */
  const readFolder = async (
    name: string,
    at: string,
    ignore: readonly string[] = DEFAULT_IGNORES,
  ): Promise<Detection | undefined> => {
    try {
      const bound = read.bound();
      return await detectRepoType(await visibleRepo(name, at, ignore, bound));
    } catch (e) {
      if (!(e instanceof TooSlow)) throw e;
      skipped.push({ path: name, reason: tooSlowReason(read.timeoutMs) });
      return undefined;
    }
  };
  // A folder that is itself a clone (or a worktree of one) is one repo (below). The manifest
  // may list it already: then its subfolders are its modules there, and aren't read.
  const selfClone = await exists(join(dir, ".git"));
  const selfListed = selfClone ? await read.listedAs(dir) : undefined;
  for (const [i, name] of entries.entries()) {
    // Stop is heard between folders: nothing is written until every folder is read.
    throwIfCancelled();
    const sub = join(dir, name);
    const isClone = await isDir(join(sub, ".git"));
    const worktree = selfClone && !isClone && (await exists(join(sub, ".git")));
    // The field report of beta.28.3: a repo a manifest lists already is told by its clone URL
    // (Git's own config, one small file) before any of its files are listed or read. Inside a
    // clone only another clone is a repo; a plain subfolder is one of its modules.
    const was = worktree || (selfClone && !isClone) ? undefined : await read.listedAs(sub);
    await read.onFolder?.({
      folder: name,
      index: i + 1,
      total: entries.length,
      ...(was ? { listed: was.id } : {}),
    });
    throwIfCancelled();
    // A worktree inside a clone is a checkout of the clone's own branches: not a module.
    if (worktree) {
      skipped.push({
        path: name,
        reason: "a git worktree (a checkout of another clone), not a repo",
      });
      continue;
    }
    if (was) {
      repos.push({ dir: sub, listed: was });
      continue;
    }
    if (selfListed && !isClone) continue;
    const det = await readFolder(name, sub);
    if (!det) continue;
    if (isClone) repos.push({ dir: sub, detection: det });
    else if (det.type !== "unknown" || det.component) builds.push({ name, detection: det });
    else skipped.push({ path: name, reason: "no build file, code or platform files" });
  }
  const sorted = () => skipped.sort((a, b) => (a.path < b.path ? -1 : 1));
  // A folder that is itself a clone is one repo: its subfolders that build are its modules,
  // and a clone inside it is a repo of its own (ADR 0057).
  if (selfClone) {
    if (selfListed) return { repos: [{ dir, listed: selfListed }, ...repos], skipped: sorted() };
    const det = await readFolder(basename(resolve(dir)), dir, SELF_IGNORE);
    return {
      repos: [
        ...(det ? [{ dir, detection: det, modules: builds.map((b) => b.name) }] : []),
        ...repos,
      ],
      skipped: sorted(),
    };
  }
  sorted();
  // Otherwise each subfolder that builds is a repo of its own (a folder of clones).
  for (const b of builds) repos.push({ dir: join(dir, b.name), detection: b.detection });
  repos.sort((a, b) => (basename(a.dir) < basename(b.dir) ? -1 : 1));
  // The folder itself is one repo when it has no repos inside but builds something.
  if (repos.length === 0) {
    const was = await read.listedAs(dir);
    if (was) return { repos: [{ dir, listed: was }], skipped: [] };
    const before = skipped.length;
    const det = await readFolder(basename(resolve(dir)), dir, SELF_IGNORE);
    if (!det) return { repos: [], skipped: skipped.slice(before) };
    if ((await isDir(join(dir, ".git"))) || det.type !== "unknown" || det.component)
      return { repos: [{ dir, detection: det }], skipped: [] };
  }
  return { repos, skipped };
}

function questionsFor(entry: ManifestRepo, det: Detection): OwnerQuestion[] {
  const q: OwnerQuestion[] = [];
  if (entry.owner === UNASSIGNED)
    q.push({
      repo: entry.id,
      field: "owner",
      question: `Which team owns ${entry.id}? Set owner in repos.manifest.yaml (a team id).`,
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

/**
 * The manifest as it is on disk and its repos; undefined when there is none; `repos` null when it
 * can't be read (kept as is).
 */
async function existingManifest(
  path: string,
): Promise<{ text: string; repos: ManifestRepo[] | null } | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const r = RepoManifest.safeParse(parse(text));
    return { text, repos: r.success ? r.data.repos : null };
  } catch {
    return { text, repos: null };
  }
}

/** A value left at its default: unset, an empty list, or archived false. */
const unset = (k: string, v: unknown) =>
  v === undefined || (Array.isArray(v) && v.length === 0) || (k === "archived" && v === false);

/**
 * A manifest entry as written: every field that is set, in the order discovery made it, and none
 * left at its default, so the file says what discovery found and no more.
 */
function entryOut(r: ManifestRepo): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (unset(k, v)) continue;
    out[k] =
      k === "modules"
        ? (v as ManifestRepo["modules"]).map((m) =>
            Object.fromEntries(Object.entries(m).filter(([mk, mv]) => !unset(mk, mv))),
          )
        : v;
  }
  return out;
}

/** Clone URLs the same once compared as keys (an in-place path: as written). */
function sameUrl(a: string, b: string): boolean {
  const ka = cloneUrlKey(a);
  const kb = cloneUrlKey(b);
  return ka !== undefined && kb !== undefined ? ka === kb : a.trim() === b.trim();
}

/** Repos the same: their clone URLs are. */
const sameRepo = (a: { url: string }, b: { url: string }) => sameUrl(a.url, b.url);

const HEADER =
  "# Proposed by atticus repos discover. Types come from each repo's files; owners marked\n# `unassigned` and missing systems are questions (see QUESTIONS.md). Review before use.\n";

export async function reposDiscover(
  root: string,
  source: DiscoverSource,
  o: DiscoverOptions = {},
  paths?: MetarepoPaths,
): Promise<DiscoverResult> {
  const p = paths ?? (await resolveMetarepo(root));
  const git = o.git ?? createGit({ timeoutMs: 15_000 });
  let platform = o.platform;
  if (!platform) {
    const profiles = (
      await readdir(join(p.orgPackDir, "profiles"), { withFileTypes: true }).catch(() => [])
    )
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    // Round 50: with two or more, the repos are one platform's, and only a person knows which.
    if (profiles.length > 1)
      throw new AdoptError(
        "usage",
        `There are ${profiles.length} platform profiles (${profiles.join(", ")}): say which the repos belong to with --platform.`,
      );
    platform = profiles[0] ?? "default";
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

  const manifestPath = join(p.orgPackDir, "profiles", platform, "repos.manifest.yaml");
  const current = await existingManifest(manifestPath);
  const kept = current?.repos ?? [];
  const listed: DiscoverResult["listed"] = [];
  /** Ids found folders took that aren't added: a later folder of the same name is still `-2`. */
  const reserved: string[] = [];

  if ("dir" in source) {
    const dirOf = source.dir;
    // Each folder's URL as the manifest would hold it, asked once: a repo kept in place by its
    // path, a clone by its origin (Git's config, local), else the folder.
    const urls = new Map<string, Promise<string>>();
    const urlOf = (dir: string) => {
      let url = urls.get(dir);
      if (!url) {
        const rel = toPosix(relative(root, dir));
        const inside = !rel.startsWith("..") && !isAbsolute(rel);
        url =
          o.inPlace && inside
            ? Promise.resolve(rel === "" ? "." : `./${rel}`)
            : originUrl(dir, git).then((origin) => origin ?? toPosix(resolve(dir)));
        urls.set(dir, url);
      }
      return url;
    };
    const known = [...kept, ...(o.known ?? [])];
    const timeoutMs = o.repoTimeoutMs ?? REPO_READ_MS;
    const clock = o.clock ?? Date.now;
    const c = await localCandidates(dirOf, {
      listedAs: async (dir) => {
        if (!known.length) return undefined;
        const url = await urlOf(dir);
        const had = known.find((k) => sameUrl(k.url, url));
        return had ? { id: had.id, url } : undefined;
      },
      ...(o.onFolder ? { onFolder: o.onFolder } : {}),
      bound: () => boundOf(timeoutMs, clock),
      timeoutMs,
    });
    skipped = c.skipped;
    for (const { dir, detection: det, modules, listed: was } of c.repos) {
      const id = uniqueId(dir === dirOf ? basename(resolve(dir)) : basename(dir));
      if (was || !det) {
        if (was) listed.push({ path: toPosix(relative(dirOf, dir)) || ".", ...was });
        reserved.push(id);
        continue;
      }
      const entry: ManifestRepo = {
        id,
        url: await urlOf(dir),
        defaultBranch: (await headBranch(dir)) ?? "main",
        branches: [],
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
          branches: [],
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

  // Round 50: a found repo the manifest lists already (the same clone URL) is left out (a
  // folder's before it is read, above); one whose id it lists for another repo gets an id of its
  // own, and the result says so.
  const renamed: DiscoverResult["renamed"] = [];
  const taken = new Set([...kept.map((r) => r.id), ...found.map((f) => f.entry.id), ...reserved]);
  const added: DiscoveredRepo[] = [];
  for (const f of found) {
    if (kept.some((k) => sameRepo(k, f.entry))) continue;
    if (kept.some((k) => k.id === f.entry.id)) {
      let id = f.entry.id;
      for (let n = 2; taken.has(id); n++) id = `${f.entry.id}-${n}`;
      taken.add(id);
      renamed.push({
        from: f.entry.id,
        to: id,
        why: `the manifest lists ${f.entry.id} already, with another clone URL`,
      });
      f.entry = { ...f.entry, id };
    }
    added.push(f);
  }
  const questions = found.flatMap((f) => questionsFor(f.entry, f.detection));
  const result: DiscoverResult = {
    platform,
    repos: found,
    skipped,
    listed,
    questions,
    renamed,
    wrote: "nothing",
  };
  if (o.dryRun) return result;

  /** A new manifest, at the current schema version. */
  const fresh = (repos: ManifestRepo[]) =>
    stringify(
      { schemaVersion: WORKSPACE_SCHEMA_VERSION, platform, repos: repos.map(entryOut) },
      { lineWidth: 0 },
    );
  /**
   * The manifest on disk with the new entries appended (as core's addManifestRepo does): every
   * entry a person wrote, its comments, its order and the file's schema version kept as they are.
   */
  const appended = (text: string, repos: ManifestRepo[]) => {
    const doc = parseDocument(text.replace(/\r\n/g, "\n"));
    let list = doc.get("repos");
    if (!isSeq(list)) {
      doc.set("repos", doc.createNode([]));
      list = doc.get("repos");
    }
    if (!isSeq(list)) return fresh(repos);
    if (!list.items.length) list.flow = false;
    for (const r of repos) list.add(doc.createNode(entryOut(r)));
    return inEol(
      doc.toString({ lineWidth: 0, flowCollectionPadding: /\[ \S/.test(text) }),
      eolOf(text),
    );
  };
  const proposalDir = join(p.proposalsDir, "repos", platform);
  if (current === undefined || (current.repos !== null && current.repos.length === 0)) {
    // No manifest, or the empty one init wrote: nothing a person wrote is replaced. The empty
    // one keeps its version and anything else it says; a new one is at the current version.
    const entries = found.map((f) => f.entry);
    await writeNew(
      manifestPath,
      current
        ? inEol(
            (current.text.includes(HEADER) ? "" : HEADER) + appended(current.text, entries),
            eolOf(current.text),
          )
        : HEADER + fresh(entries),
      false,
    );
    result.wrote = "manifest";
    result.file = toPosix(relative(root, manifestPath));
    // A profile folder discovery made is a profile: its profile.yaml too (kept when there).
    await writeNew(
      join(p.orgPackDir, "profiles", platform, "profile.yaml"),
      stringify({ schemaVersion: 1, platform, name: platform, systems: [] }, { lineWidth: 0 }),
    );
  } else {
    // Keep every existing entry as it is; add only repos the manifest doesn't list.
    const file = join(proposalDir, "repos.manifest.yaml");
    const entries = added.map((a) => a.entry);
    await writeNew(
      file,
      current.repos === null
        ? HEADER + fresh(entries)
        : inEol(HEADER + appended(current.text, entries), eolOf(current.text)),
      false,
    );
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
