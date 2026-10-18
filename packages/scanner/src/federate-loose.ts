import type { CatalogRecord, MergeResult } from "@maycombhq/core";

/**
 * Federated loose ends through merge identity resolution (ADR 0038 "not yet", closed in ADR
 * 0041). A federated metarepo's Unresolved records are calls and events it couldn't place in
 * its own estate; many are calls to, or subscriptions on, ours. They go through the same
 * merge as our code, together with our raw facts, and every interface that only exists
 * because of them joins the catalog with the federated origin's flag.
 *
 * Local code still wins: an interface our own merge already has is never replaced, and
 * nothing of ours changes. An interface is taken only when both its ends are known (one of
 * our components or systems, or a federated component); a loose end that can't be placed
 * stays a federated loose end.
 */
export function resolveFederatedLooseEnds(o: {
  /** Our merged records (what the scan found without federation). */
  local: CatalogRecord[];
  /** Our raw facts as merge first saw them (code and inputs), with their loose ends. */
  raw: CatalogRecord[];
  /** Federated records, each flagged `federated:<id>`. */
  federated: CatalogRecord[];
  merge: (records: CatalogRecord[]) => MergeResult;
}): { federated: CatalogRecord[]; resolved: Map<string, number> } {
  const originOf = (r: CatalogRecord) =>
    (r.flags ?? []).find((f) => f.startsWith("federated:"))?.slice("federated:".length);
  const loose = o.federated.filter((r) => r.kind === "Unresolved");
  if (!loose.length) return { federated: o.federated, resolved: new Map() };
  const fedComponents = o.federated.filter((r) => r.kind === "Component");

  const result = o.merge([...o.raw, ...fedComponents, ...loose]);
  const have = new Set(o.local.map((r) => `${r.kind}/${r.id}`));
  const known = new Set<string>([
    ...o.local.filter((r) => r.kind === "Component" || r.kind === "System").map((r) => r.id),
    ...fedComponents.map((r) => r.id),
  ]);
  const origin = new Map(fedComponents.map((c) => [c.id, originOf(c)]));
  const stillLoose = new Set(
    result.records.filter((r) => r.kind === "Unresolved").map((r) => r.id),
  );

  const added: CatalogRecord[] = [];
  for (const r of result.records) {
    if (r.kind !== "Interface" || have.has(`Interface/${r.id}`)) continue;
    const i = r as CatalogRecord & { from: string; to: string };
    const from = origin.get(i.from) ?? origin.get(i.to);
    if (!from || !known.has(i.from) || !known.has(i.to)) continue;
    added.push({ ...r, flags: [...new Set([...(r.flags ?? []), `federated:${from}`])] });
  }
  // A federated loose end is placed when merge no longer lists it and an interface we took
  // carries its evidence (the code line it was read from).
  const key = (e: unknown) => JSON.stringify(e);
  const carried = new Set(added.flatMap((i) => i.evidence.map(key)));
  const resolved = new Map<string, number>();
  const kept = o.federated.filter((r) => {
    if (r.kind !== "Unresolved" || stillLoose.has(r.id)) return true;
    if (!r.evidence.some((e) => e.source !== "export" && carried.has(key(e)))) return true;
    const id = originOf(r) ?? "";
    resolved.set(id, (resolved.get(id) ?? 0) + 1);
    return false;
  });
  return {
    federated: [...kept, ...added].sort((a, b) =>
      a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind),
    ),
    resolved,
  };
}
