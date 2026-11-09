import type { RepoHandle } from "./plugin.js";

/**
 * How a repo handle's files were listed (review round 49): the folders a walk leaves out, the
 * size a file may be, the exclusions a scan's settings add. The same commit listed another way
 * gives an extractor other files, so `scanRepo` folds this into each stored result's key. Kept
 * on the handle under a registered symbol, not in the RepoHandle contract (C4): a wrapper that
 * narrows the listing (the scanner's `withExcludes`) extends it with `Symbol.for` of the same
 * name, and a handle that says nothing is keyed as before.
 */
export const LISTING = Symbol.for("@maycombhq/sdk.listing");

/** The listing a handle says it has, or "" when it says none. */
export function listingOf(repo: RepoHandle): string {
  const v = (repo as unknown as Record<symbol, unknown>)[LISTING];
  return typeof v === "string" ? v : "";
}

/** Says how a handle lists its files. */
export function setListing(repo: RepoHandle, listing: string): void {
  Object.defineProperty(repo, LISTING, { value: listing, enumerable: false, configurable: true });
}
