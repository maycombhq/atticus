import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { loadOrgPack, orgPackDirOf } from "@maycombhq/core";
import { baseClonePath } from "@maycombhq/workspace";

const isDir = async (p: string) => !!(await stat(p).catch(() => undefined))?.isDirectory();

/**
 * A repo by manifest id (its base clone) or a folder. Its own module, not onboard-commands': a
 * command that only reads facts (atticus next, through map-parts and facts-files) would otherwise
 * load the onboarding commands and, through them, the model's context tools (test/startup.test.ts
 * holds this).
 */
export async function repoFor(
  root: string,
  target: string,
): Promise<{ id: string; dir: string } | undefined> {
  const op = await loadOrgPack(orgPackDirOf(root));
  const known = op.profiles.flatMap((p) => p.repos?.repos ?? []).find((r) => r.id === target);
  if (known) {
    const dir = baseClonePath(root, known.id);
    return (await isDir(dir)) ? { id: known.id, dir } : undefined;
  }
  const dir = resolve(target);
  return (await isDir(dir)) ? { id: basename(dir), dir } : undefined;
}
