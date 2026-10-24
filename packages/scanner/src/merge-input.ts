import { join } from "node:path";
import {
  mergeCatalog,
  type CatalogRecord,
  type MergeInput,
  type MergeResult,
  type OrgPack,
} from "@maycombhq/core";

/**
 * The passes every catalog build shares, whoever read the code (ADR 0017, 0053, 0124): the
 * estate's repos from the org pack's manifests, the merge input they make (hosts, modules,
 * systems, patterns), and the curated decisions a person made, replayed over the result. A scan
 * and `atticus verify <repo> --write` both build the catalog through these, so a catalog never
 * depends on which of them wrote it last.
 */

/** A repo as the manifests list it, with the platform of its profile. */
export type EstateRepo = NonNullable<OrgPack["profiles"][number]["repos"]>["repos"][number] & {
  platform: string;
};

/** A module of a repo with its own component and the hosts it answers on (ADR 0057). */
export interface EstateModule {
  path: string;
  component: string;
  hosts: string[];
}

/** The repos the manifests list, archived ones left out; with `only`, just those. */
export function estateRepos(op: OrgPack, only?: readonly string[]): EstateRepo[] {
  return op.profiles
    .flatMap((p) => (p.repos?.repos ?? []).map((r) => ({ ...r, platform: p.platform })))
    .filter((r) => !r.archived && (!only || only.includes(r.id)));
}

/**
 * What mergeCatalog needs besides the records: each repo with its hosts, each module with hosts
 * of its own (so a call to them joins the module's component), the profiles' systems and the
 * integration patterns. `modulesOf` gives a repo's modules: the manifest's, or those a scan found.
 */
export function estateMergeInput(
  op: OrgPack,
  repos: readonly EstateRepo[],
  records: CatalogRecord[],
  modulesOf: (repo: string) => readonly EstateModule[] = (id) =>
    repos.find((r) => r.id === id)?.modules ?? [],
): MergeInput {
  return {
    records,
    repos: repos.flatMap((r) => [
      {
        id: r.id,
        type: r.type,
        ...(r.component ? { component: r.component } : {}),
        ...(r.system ? { system: r.system } : {}),
        hosts: r.hosts,
      },
      // A module's hosts join calls to its own component (ADR 0057).
      ...modulesOf(r.id)
        .filter((m) => m.hosts.length > 0)
        .map((m) => ({
          id: r.id,
          type: r.type,
          component: m.component,
          ...(r.system ? { system: r.system } : {}),
          hosts: m.hosts,
        })),
    ]),
    systems: op.profiles.flatMap((p) => p.profile?.systems ?? []),
    patterns: op.patterns,
    profilePath: op.profiles[0]
      ? `org-pack/profiles/${op.profiles[0].platform}/profile.yaml`
      : undefined,
  };
}

/** Merge records into one catalog with the estate's repos, hosts and systems. */
export function mergeEstate(
  op: OrgPack,
  repos: readonly EstateRepo[],
  records: CatalogRecord[],
  modulesOf?: (repo: string) => readonly EstateModule[],
): MergeResult {
  return mergeCatalog(estateMergeInput(op, repos, records, modulesOf));
}

/** The folder of curated decisions: `<layout.catalog>/curated` under the root. */
export function curatedDirOf(root: string, op: OrgPack): string {
  return join(root, ...op.sources.layout.catalog.split("/"), "curated");
}
