import { createGit, type GitRunner } from "./git.js";

export interface CheckoutState {
  /** Full SHA of HEAD. */
  commit: string;
  /** True when tracked or untracked files differ from HEAD; dirty checkouts are never cached. */
  dirty: boolean;
}

/** Commit and cleanliness of a checkout, for the scan runner's cache key. */
export async function checkoutState(
  dir: string,
  git: GitRunner = createGit(),
): Promise<CheckoutState> {
  const commit = (await git(["rev-parse", "HEAD"], dir)).stdout.trim();
  const status = (
    await git(["status", "--porcelain", "--untracked-files=normal"], dir)
  ).stdout.trim();
  return { commit, dirty: status !== "" };
}
