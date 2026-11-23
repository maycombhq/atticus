import { plannedByOpenChanges } from "@maycombhq/changes";
import { loadOrgPack, orgPackDirOf } from "@maycombhq/core";
import { relative, sep } from "node:path";
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
  /** The same owner with the org-pack file that names it (root-relative, forward slashes). */
  ownerSaid(r: { kind: string; id: string; system?: string }): Said | undefined;
  /** A repo the manifests list: its system, and its owner with the file (ADR 0207 `owners`). */
  repo(id: string): { system?: string; said?: Said } | undefined;
}

/** An owner and the file that names it. */
export interface Said {
  owner: string;
  file: string;
}

export async function mapSides(root: string): Promise<MapSides> {
  const repoOwner = new Map<string, Said>();
  const systemOwner = new Map<string, Said>();
  const repos = new Map<string, { system?: string }>();
  try {
    const dir = orgPackDirOf(root);
    const at = (p: string, f: string) =>
      relative(root, `${dir}${sep}profiles${sep}${p}${sep}${f}`).split(sep).join("/");
    const pack = await loadOrgPack(dir);
    for (const p of pack.profiles) {
      const file = at(p.platform, "repos.manifest.yaml");
      for (const r of p.repos?.repos ?? []) {
        repos.set(r.id, r.system ? { system: r.system } : {});
        if (r.owner) {
          repoOwner.set(r.id, { owner: r.owner, file });
          if (r.system && !systemOwner.has(r.system))
            systemOwner.set(r.system, { owner: r.owner, file });
        }
      }
      // A profile's own word on a system's owner is the more exact one.
      for (const s of p.profile?.systems ?? [])
        if (s.owner)
          systemOwner.set(s.id, { owner: s.owner, file: at(p.platform, "profile.yaml") });
    }
  } catch {
    // no org pack that reads: the catalog's own owners are all there is
  }
  const ownerSaid = (r: { id: string; system?: string }) =>
    (r.system ? systemOwner.get(r.system) : undefined) ?? repoOwner.get(r.id);
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
          : { nearest: nearestIds(ix, id, [...repos.keys(), ...planned.keys()]) }),
      });
    },
    owner: (r) => ownerSaid(r)?.owner,
    ownerSaid,
    repo: (id) => {
      const r = repos.get(id);
      const said = repoOwner.get(id);
      return r && { ...r, ...(said ? { said } : {}) };
    },
  };
}

/** Said in impact's OWNER column where neither the catalog nor the org pack names one. */
export const NO_OWNER = "no owner on record";
