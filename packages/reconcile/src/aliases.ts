import type { CatalogRecord } from "@maycombhq/core";

export interface ProfileSystem {
  id: string;
  name: string;
  aliases: string[];
}

export type AliasHow = "curated" | "exact" | "profile";

export interface NameResolution {
  name: string;
  /** The catalog id the name stands for, when one was found. */
  id?: string;
  how?: AliasHow;
  /** For a name with no match: catalog ids with a similar name, best first. */
  similar: string[];
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const words = (s: string) =>
  new Set(
    slug(s)
      .split("-")
      .filter((w) => w.length > 1),
  );

/** Alias decisions people have made: CuratedDecision records with action alias (value: a name or names). */
export function curatedAliases(records: CatalogRecord[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of records) {
    if (r.kind !== "CuratedDecision" || r.action !== "alias") continue;
    const names = Array.isArray(r.value) ? r.value : [r.value];
    for (const n of names) if (typeof n === "string") out.set(n.toLowerCase(), r.target);
  }
  return out;
}

/**
 * Resolve the names people use (diagram boxes, document mentions) to catalog ids, in order:
 * 1. a person's alias decision (catalog/curated);
 * 2. the name is the id of a component or system, once made a slug ("Portal BFF" → portal-bff);
 * 3. the profile names it as a system or system alias; a system with one component resolves to
 *    that component ("Ledger Platform" → ledger → ledger-api).
 * Anything else is unresolved, with similar names offered.
 */
export function resolveNames(
  names: string[],
  records: CatalogRecord[],
  systems: ProfileSystem[],
): Map<string, NameResolution> {
  const curated = curatedAliases(records);
  const components = records.filter((r) => r.kind === "Component");
  const ids = new Set([
    ...components.map((c) => c.id),
    ...records.filter((r) => r.kind === "System").map((r) => r.id),
    ...systems.map((s) => s.id),
  ]);
  const componentsOf = (sys: string) => components.filter((c) => c.system === sys).map((c) => c.id);
  const profileName = new Map<string, string>();
  for (const s of systems)
    for (const n of [s.name, ...s.aliases]) profileName.set(n.toLowerCase(), s.id);
  const out = new Map<string, NameResolution>();
  for (const name of names) {
    if (out.has(name)) continue;
    const key = name.toLowerCase();
    const c = curated.get(key);
    if (c) {
      out.set(name, { name, id: c, how: "curated", similar: [] });
      continue;
    }
    if (ids.has(slug(name))) {
      out.set(name, { name, id: slug(name), how: "exact", similar: [] });
      continue;
    }
    const sys = profileName.get(key);
    if (sys) {
      const comps = componentsOf(sys);
      out.set(name, {
        name,
        id: comps.length === 1 ? comps[0]! : sys,
        how: "profile",
        similar: [],
      });
      continue;
    }
    const w = words(name);
    const similar = [...ids]
      .map((id) => ({ id, score: [...words(id)].filter((x) => w.has(x)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, 3)
      .map((x) => x.id);
    out.set(name, { name, similar });
  }
  return out;
}
