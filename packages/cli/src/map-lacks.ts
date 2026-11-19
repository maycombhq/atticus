import { plannedByOpenChanges } from "@maycombhq/changes";
import { loadOrgPack, orgPackDirOf } from "@maycombhq/core";
import { nearestIds, notInMap, type CatalogIndex } from "@maycombhq/index";

/**
 * What the map tools read beside the catalog (ADR 0201 addendum, 2026-11-19; the real-model run
 * of the personas): the manifests' repos and the open changes, to say which of three things an
 * id the map lacks is, and the owners the manifests and profiles name, for impact's OWNER column
 * where the catalog's system has none. Files only; nothing is written.
 */
export interface MapSides {
  /** What is said of an id the map lacks: in the manifests and unread, planned by a change, or neither. */
  lacks(id: string, ix: CatalogIndex): string;
  /** The owner the manifests or a profile name for a record, by its system or its own id. */
  owner(r: { kind: string; id: string; system?: string }): string | undefined;
}

export async function mapSides(root: string): Promise<MapSides> {
  const repoOwner = new Map<string, string>();
  const systemOwner = new Map<string, string>();
  const repos = new Set<string>();
  try {
    const pack = await loadOrgPack(orgPackDirOf(root));
    for (const p of pack.profiles) {
      for (const r of p.repos?.repos ?? []) {
        repos.add(r.id);
        if (r.owner) {
          repoOwner.set(r.id, r.owner);
          if (r.system && !systemOwner.has(r.system)) systemOwner.set(r.system, r.owner);
        }
      }
      // A profile's own word on a system's owner is the more exact one.
      for (const s of p.profile?.systems ?? []) if (s.owner) systemOwner.set(s.id, s.owner);
    }
  } catch {
    // no org pack that reads: the catalog's own owners are all there is
  }
  const planned = await plannedByOpenChanges(root).catch(() => new Map<string, string[]>());
  return {
    lacks(id, ix) {
      const manifest = repos.has(id);
      const plannedBy = planned.get(id) ?? [];
      return notInMap(id, {
        manifest,
        plannedBy,
        ...(manifest || plannedBy.length
          ? {}
          : { nearest: nearestIds(ix, id, [...repos, ...planned.keys()]) }),
      });
    },
    owner: (r) => (r.system ? systemOwner.get(r.system) : undefined) ?? repoOwner.get(r.id),
  };
}

/** Said in impact's OWNER column where neither the catalog nor the org pack names one. */
export const NO_OWNER = "no owner on record";
