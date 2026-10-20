import type { ParseCache, RepoHandle } from "@maycombhq/sdk";

/**
 * Where a parse can be shared (ADR 0067): the repo scan's parse cache and the file's path. Every
 * reader that takes one parses the file at most once per scan; without a cache it parses alone.
 */
export interface ParsedAt {
  cache?: ParseCache | undefined;
  path: string;
}

/** A file of this repo, for the readers that share parses: `parseHcl(text, at(repo, path))`. */
export const at = (repo: Pick<RepoHandle, "parseCache">, path: string): ParsedAt => ({
  cache: repo.parseCache,
  path,
});
