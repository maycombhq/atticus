import { mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGit, type GitRunner } from "@maycombhq/workspace";
import { AdoptError } from "../errors.js";
import { exists, isDir } from "../files.js";

/**
 * Where an absorbed repo's files are. A local folder is read where it is (read-only). A bare
 * repository, a `file://` URL or a remote URL is cloned once, shallow, through the git runner
 * into the state folder's `absorbed/<id>/`, which is also where the scan finds a federated
 * metarepo. Remote URLs are never used in tests: they are local bare repos or folders there.
 */

export interface OpenedSource {
  /** The folder to read. */
  dir: string;
  /** How it was reached. */
  kind: "folder" | "clone";
  /** The url to record in sources.yaml. */
  url: string;
}

const REMOTE = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP = /^[^/\\]+@[^:/\\]+:/;

async function isBare(dir: string): Promise<boolean> {
  return (
    (await isDir(join(dir, "objects"))) &&
    (await exists(join(dir, "HEAD"))) &&
    !(await isDir(join(dir, ".git")))
  );
}

export async function openSource(
  source: string,
  o: { root: string; stateDir: string; id: string; ref?: string; git?: GitRunner },
): Promise<OpenedSource> {
  let local: string | undefined;
  if (source.startsWith("file://")) local = fileURLToPath(source);
  else if (!REMOTE.test(source) && !SCP.test(source))
    local = isAbsolute(source) ? source : resolve(o.root, source);

  if (local) {
    if (!(await isDir(local)))
      throw new AdoptError("source", `There is no folder or repository at ${source}.`);
    if (!(await isBare(local)) && !o.ref) return { dir: local, kind: "folder", url: source };
  }
  const target = join(o.stateDir, "absorbed", o.id);
  await rm(target, { recursive: true, force: true });
  const git = o.git ?? createGit();
  const url = local && !source.startsWith("file://") ? local : source;
  await mkdir(dirname(target), { recursive: true });
  try {
    await git(
      ["clone", "--depth", "1", ...(o.ref ? ["--branch", o.ref] : []), "--", url, target],
      dirname(target),
    );
  } catch (e) {
    throw new AdoptError("source", `Couldn't clone ${source}: ${(e as Error).message}`);
  }
  return { dir: target, kind: "clone", url: source };
}
