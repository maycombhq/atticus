import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { ChangeRepos, RepoManifest, toCanonicalYaml, type ManifestRepo } from "@maycombhq/core";
import { changeReposPath } from "./layout.js";

export class WorkspaceFileError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "WorkspaceFileError";
  }
}

function describe(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues.map((i) => `${i.path.map(String).join(".") || "(file)"}: ${i.message}`).join("; ");
}

async function readYaml(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  try {
    return parse(text);
  } catch (err) {
    throw new WorkspaceFileError(`${path}: invalid YAML: ${(err as Error).message}`, path);
  }
}

export async function loadManifest(path: string): Promise<RepoManifest> {
  const r = RepoManifest.safeParse(await readYaml(path));
  if (!r.success) throw new WorkspaceFileError(`${path}: ${describe(r.error.issues)}`, path);
  return r.data;
}

export interface LoadedRepo extends ManifestRepo {
  platform: string;
}

/**
 * Every repo from every platform profile (org-pack/profiles/<platform>/repos.manifest.yaml).
 * Repo ids must be unique across profiles, because each one names a folder under workspace/.
 */
export async function loadRepos(root: string): Promise<LoadedRepo[]> {
  const profiles = join(root, "org-pack", "profiles");
  let names: string[];
  try {
    names = (await readdir(profiles, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
  const out: LoadedRepo[] = [];
  const where = new Map<string, string>();
  for (const name of names) {
    const path = join(profiles, name, "repos.manifest.yaml");
    try {
      await readFile(path);
    } catch {
      continue;
    }
    const m = await loadManifest(path);
    for (const repo of m.repos) {
      const other = where.get(repo.id);
      if (other)
        throw new WorkspaceFileError(
          `repo id ${repo.id} is in both ${other} and ${m.platform}`,
          path,
        );
      where.set(repo.id, m.platform);
      out.push({ ...repo, platform: m.platform });
    }
  }
  return out;
}

const CHANGE_REPOS_KEYS = ["schemaVersion", "change", "id"];

export async function readChangeRepos(
  root: string,
  change: string,
): Promise<ChangeRepos | undefined> {
  const path = changeReposPath(root, change);
  try {
    await readFile(path);
  } catch {
    return undefined;
  }
  const r = ChangeRepos.safeParse(await readYaml(path));
  if (!r.success) throw new WorkspaceFileError(`${path}: ${describe(r.error.issues)}`, path);
  if (r.data.change !== change)
    throw new WorkspaceFileError(`${path}: says change ${r.data.change}, expected ${change}`, path);
  return r.data;
}

export async function writeChangeRepos(root: string, value: ChangeRepos): Promise<string> {
  const data = ChangeRepos.parse(value);
  const path = changeReposPath(root, data.change);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, toCanonicalYaml(data, CHANGE_REPOS_KEYS), "utf8");
  return path;
}
