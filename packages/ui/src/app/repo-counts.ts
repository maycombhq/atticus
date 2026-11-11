/**
 * Beta.27 review: one meaning of "repos", wherever a count of them shows (the status bar, the
 * Explorer's Systems header, its tree). A repo is one of the **manifest's** repos, as
 * GET /api/trust lists them (Map › Trust): the estate the metarepo names, read or not.
 *
 * The map draws a box for a repo once its catalog has one (GET /api/graph/node/estate's repo
 * nodes); a repo not read yet, or one with nothing on the architecture lens (a gateway's config,
 * an events schema, infrastructure), has none. Beta.27's first cut said "4 repos" in the
 * Explorer's header (the boxes), "7 repos" in the status bar (the manifest) and 1/1/2/1 on the
 * systems' rows (repos and components no repo holds, together). Now the header says how many of
 * the manifest's repos are on the map ("4 of 7 repos on the map"), the tree lists the rest under
 * "Not on the map" so header and tree add up, and a system's row counts its repos only.
 */

/** The manifest's repos: Map › Trust's read. */
export const MANIFEST_REPOS_PATH = "/api/trust";

/** GET /api/trust, as far as the count reads it. */
export interface ManifestReposAnswer {
  repos?: readonly { repo?: string }[] | readonly unknown[];
}

/** A node of the map's estate view, as far as the count reads it. */
export interface MapRepoNode {
  id: string;
  kind: string;
}

export interface RepoCounts {
  /** The manifest's repos: the number every count of repos shows. */
  repos: number;
  /** Those of them the map has a box for. */
  onMap: number;
  /** Those it has none for, by name. */
  notOnMap: string[];
}

/** The manifest's repos, by name; undefined until known. */
export function manifestRepos(a: ManifestReposAnswer | undefined): string[] | undefined {
  if (!a || !Array.isArray(a.repos)) return undefined;
  return (a.repos as readonly unknown[]).map((r, i) =>
    r && typeof r === "object" && typeof (r as { repo?: unknown }).repo === "string"
      ? (r as { repo: string }).repo
      : `#${i + 1}`,
  );
}

/** How many repos the manifest names (the status bar's count); undefined until known. */
export const manifestRepoCount = (a: ManifestReposAnswer | undefined): number | undefined =>
  manifestRepos(a)?.length;

/** The repos the map draws a box for, by name (its `repo:<name>` nodes). */
export function mapRepos(nodes: readonly MapRepoNode[]): string[] {
  return nodes.filter((n) => n.kind === "repo").map((n) => n.id.replace(/^repo:/, ""));
}

/**
 * The repos, once both reads are known: the manifest's, those on the map and those not.
 * Undefined while either isn't: the boxes alone would read as the repos and disagree with the
 * status bar.
 */
export function repoCountsOf(
  manifest: ManifestReposAnswer | undefined,
  map: { children: readonly MapRepoNode[] } | undefined,
): RepoCounts | undefined {
  const named = manifestRepos(manifest);
  if (!named || !map) return undefined;
  const boxed = new Set(mapRepos(map.children));
  const notOnMap = named.filter((r) => !boxed.has(r)).sort((a, b) => a.localeCompare(b));
  return { repos: named.length, onMap: named.length - notOnMap.length, notOnMap };
}
