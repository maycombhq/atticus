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
 * "Not on the map" so header and tree add up, and a system's row counts its repos only. Beta.27
 * re-review: a box for a repo the manifest doesn't name (records left for a repo taken out of
 * it) is counted nowhere, flagged on its row ("not in the manifest") and said in the header.
 */

import { catalogMayHaveChanged, filesMayHaveChanged, type LiveEvent } from "../api/client.js";

/** The manifest's repos: Map › Trust's read. */
export const MANIFEST_REPOS_PATH = "/api/trust";

/**
 * Beta.27 review: the file events that can change Map › Trust's read (a count shown from it reads
 * it again on those only): the catalog or the org pack, the manifest (a top file) and the facts.
 */
export const manifestMayHaveChanged = (events: LiveEvent[]): boolean =>
  catalogMayHaveChanged(events) || filesMayHaveChanged(events, /(^|\/)facts\//);

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
  /**
   * Beta.27 review: the repos the map has a box for that the manifest doesn't name (records left
   * for a repo taken out of it), by name: never counted as a repo, flagged where they show.
   */
  offManifest: string[];
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
 * The repos, once both reads are known: the manifest's, those of them on the map (the manifest's
 * and the boxes' both), those not, and the boxes the manifest doesn't name. Undefined while either
 * isn't: the boxes alone would read as the repos and disagree with the status bar.
 */
export function repoCountsOf(
  manifest: ManifestReposAnswer | undefined,
  map: { children: readonly MapRepoNode[] } | undefined,
): RepoCounts | undefined {
  const named = manifestRepos(manifest);
  if (!named || !map) return undefined;
  const listed = new Set(named);
  const boxed = new Set(mapRepos(map.children));
  const byName = (a: string, b: string) => a.localeCompare(b);
  const notOnMap = [...listed].filter((r) => !boxed.has(r)).sort(byName);
  const offManifest = [...boxed].filter((r) => !listed.has(r)).sort(byName);
  const onMap = [...listed].filter((r) => boxed.has(r)).length;
  return { repos: listed.size, onMap, notOnMap, offManifest };
}
