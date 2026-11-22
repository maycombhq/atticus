import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { createGit, type GitRunner } from "@maycombhq/workspace";

/**
 * ADR 0204 (Migration): the profiles a proposal raises to a version an older Atticus refuses: a
 * `profiles/<platform>/profile.yaml` among its files whose own `schemaVersion` is above the one
 * on the proposal's target branch (a new file counts from version 1). The Propose page says so.
 * The second review: the target, not HEAD, since a raise committed on this branch still reaches
 * the target in the pull request. The target is the remote's default branch as this clone knows it
 * (`origin/HEAD`, read from files, no network), else HEAD.
 */
export async function profilesRaised(
  root: string,
  files: readonly { path: string }[],
  git: GitRunner = createGit({ timeoutMs: 30_000 }),
): Promise<{ file: string; from: number; to: number }[]> {
  const versionOf = (text: string | undefined) => {
    try {
      const v = (parse(text ?? "") as { schemaVersion?: unknown } | null)?.schemaVersion;
      return typeof v === "number" ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const out: { file: string; from: number; to: number }[] = [];
  const profiles = files.filter((f) => /(^|\/)profiles\/[^/]+\/profile\.yaml$/.test(f.path));
  if (!profiles.length) return out;
  const target =
    (await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], root).then(
      (r) => r.stdout.trim(),
      () => "",
    )) || "HEAD";
  for (const f of profiles) {
    const now = versionOf(
      await readFile(join(root, ...f.path.split("/")), "utf8").catch(() => undefined),
    );
    const was =
      versionOf(
        await git(["show", `${target}:${f.path}`], root).then(
          (r) => r.stdout,
          () => undefined,
        ),
      ) ?? 1;
    if (now !== undefined && now > was && now >= 3) out.push({ file: f.path, from: was, to: now });
  }
  return out;
}
