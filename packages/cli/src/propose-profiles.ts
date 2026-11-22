import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { createGit, type GitRunner } from "@maycombhq/workspace";

/**
 * ADR 0204 (Migration): the profiles a proposal raises to a version an older Atticus refuses: a
 * `profiles/<platform>/profile.yaml` among its files whose own `schemaVersion` is above the one
 * on the proposal's target branch (a file the target doesn't have counts from version 1). The
 * Propose page says so.
 *
 * The second review: the target, not HEAD, since a raise committed on this branch still reaches
 * the target in the pull request. The target is the remote's default branch as this clone knows it
 * (`origin/HEAD`), else the branch's upstream (`@{upstream}`), else HEAD: read from files, no
 * network. The third review: where the target has the file but it can't be read, the file is
 * listed as `unread` (said on the page), never guessed as version 1.
 */
export async function profilesRaised(
  root: string,
  files: readonly { path: string }[],
  git: GitRunner = createGit({ timeoutMs: 30_000 }),
): Promise<{
  raised: { file: string; from: number; to: number }[];
  unread: { file: string; target: string }[];
}> {
  const versionOf = (text: string | undefined) => {
    try {
      const v = (parse(text ?? "") as { schemaVersion?: unknown } | null)?.schemaVersion;
      return typeof v === "number" ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const raised: { file: string; from: number; to: number }[] = [];
  const unread: { file: string; target: string }[] = [];
  const profiles = files.filter((f) => /(^|\/)profiles\/[^/]+\/profile\.yaml$/.test(f.path));
  if (!profiles.length) return { raised, unread };
  const out = (args: string[]) =>
    git(args, root).then(
      (r) => r.stdout,
      () => undefined,
    );
  const target =
    (await out(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]))?.trim() ||
    (await out(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]))?.trim() ||
    "HEAD";
  for (const f of profiles) {
    const now = versionOf(
      await readFile(join(root, ...f.path.split("/")), "utf8").catch(() => undefined),
    );
    if (now === undefined || now < 3) continue;
    const shown = await out(["show", `${target}:${f.path}`]);
    let was: number | undefined;
    if (shown !== undefined) was = versionOf(shown) ?? 1;
    else {
      // Not shown: a file the target doesn't have (from version 1), or a target that can't be
      // read (a ref gone, a broken object): listed, never guessed.
      const listed = await out(["ls-tree", "--name-only", target, "--", f.path]);
      if (listed !== undefined && listed.trim() === "") was = 1;
    }
    if (was === undefined) unread.push({ file: f.path, target });
    else if (now > was) raised.push({ file: f.path, from: was, to: now });
  }
  return { raised, unread };
}
