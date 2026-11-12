import { createGit, type GitRunner } from "./git.js";

export interface CheckoutState {
  /** Full SHA of HEAD. */
  commit: string;
  /** True when tracked or untracked files differ from HEAD; dirty checkouts are never cached. */
  dirty: boolean;
  /** HEAD's committer date (ISO 8601), when git gave it: a time the commit itself fixes. */
  committedAt?: string;
}

/**
 * Commit and cleanliness of a checkout, for the scan runner's cache key. `ignore` are folders
 * (relative, "/"-separated, with a trailing "/") whose changes don't make it dirty: Atticus's own
 * folder in a repo adopted in place (ADR 0195 review), which every scan writes.
 */
export async function checkoutState(
  dir: string,
  git: GitRunner = createGit(),
  o: { ignore?: readonly string[] } = {},
): Promise<CheckoutState> {
  const head = (await git(["show", "-s", "--format=%H%n%cI", "HEAD"], dir)).stdout.trim();
  const [commit = "", committedAt] = head.split("\n");
  const status = (
    await git(["status", "--porcelain", "--untracked-files=normal"], dir)
  ).stdout.trim();
  const ignore = o.ignore ?? [];
  const changed = status
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, ""))
    .flatMap((p) => p.split(" -> "))
    .filter((p) => !ignore.some((i) => p === i.replace(/\/$/, "") || p.startsWith(i)));
  return {
    commit: commit.trim(),
    dirty: changed.length > 0,
    ...(committedAt?.trim() ? { committedAt: committedAt.trim() } : {}),
  };
}
