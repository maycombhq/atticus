import type { CatalogRecord, FrameworkModel } from "@maycombhq/core";

/**
 * Pipeline models (ADR 0062): what an organisation's pipeline templates and shared-library steps
 * do, applied to the pipelines that use them. A pipeline record (QualityAsset `pipeline`, from a
 * built-in reader or a dialect) lists the templates it uses in `details.templates`; each one a
 * model entry's `uses` names adds that entry's stages, environments, deploy targets and test
 * steps, and is named in `details.modelled` with the model and where its meaning came from.
 * Deterministic: models are org-pack data.
 */

type Entry = FrameworkModel["pipeline"][number];

/** Whether a template reference is the one an entry names: as written, or without a version. */
export function templateMatches(ref: string, uses: string): boolean {
  const bare = (x: string) => x.replace(/@[^@/]*$/, "").toLowerCase();
  return (
    ref === uses ||
    bare(ref) === bare(uses) ||
    ref.toLowerCase().startsWith(`${uses.toLowerCase()}@`)
  );
}

const LISTS = ["stages", "environments", "deployTargets", "testSteps"] as const;

/** What an entry adds to a pipeline's details, given an environment its call named. */
export function addEntry(details: Record<string, unknown>, e: Entry, model: string, env?: string) {
  for (const k of LISTS) {
    const add = [...e[k], ...(k === "environments" && env ? [env] : [])];
    if (add.length === 0) continue;
    const cur = Array.isArray(details[k]) ? (details[k] as string[]) : [];
    details[k] = [...cur, ...add.filter((x) => !cur.includes(x))];
  }
  const via = `${e.uses ?? `step ${e.step}`} (${model}, ${e.source.kind}${e.source.ref ? ` ${e.source.ref}` : ""})`;
  const modelled = Array.isArray(details.modelled) ? (details.modelled as string[]) : [];
  if (!modelled.includes(via)) details.modelled = [...modelled, via];
}

/** Pipeline records with what their modelled templates do added (records are copied, not changed). */
export function applyPipelineModels(
  records: CatalogRecord[],
  models: readonly FrameworkModel[],
): CatalogRecord[] {
  const entries = models.flatMap((m) => m.pipeline.filter((e) => e.uses).map((e) => ({ m, e })));
  if (entries.length === 0) return records;
  return records.map((r) => {
    const x = r as unknown as {
      kind: string;
      assetKind?: string;
      details?: Record<string, unknown>;
    };
    if (x.kind !== "QualityAsset" || x.assetKind !== "pipeline") return r;
    const templates = Array.isArray(x.details?.templates) ? (x.details!.templates as string[]) : [];
    const hits = entries.filter(({ e }) => templates.some((t) => templateMatches(t, e.uses!)));
    if (hits.length === 0) return r;
    const details = structuredClone(x.details ?? {});
    for (const { m, e } of hits) addEntry(details, e, m.name);
    return { ...r, details } as unknown as CatalogRecord;
  });
}
