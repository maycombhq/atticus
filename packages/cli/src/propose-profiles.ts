import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { createGit, type GitRunner } from "@maycombhq/workspace";

/**
 * ADR 0204 (Migration): the profiles a proposal raises to a version an older Atticus refuses: a
 * `profiles/<platform>/profile.yaml` among its files whose own `schemaVersion` is above the one
 * committed at HEAD (a new file counts from version 1). The Propose page says so.
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
  for (const f of files) {
    if (!/(^|\/)profiles\/[^/]+\/profile\.yaml$/.test(f.path)) continue;
    const now = versionOf(
      await readFile(join(root, ...f.path.split("/")), "utf8").catch(() => undefined),
    );
    const was =
      versionOf(
        await git(["show", `HEAD:${f.path}`], root).then(
          (r) => r.stdout,
          () => undefined,
        ),
      ) ?? 1;
    if (now !== undefined && now > was && now >= 3) out.push({ file: f.path, from: was, to: now });
  }
  return out;
}
