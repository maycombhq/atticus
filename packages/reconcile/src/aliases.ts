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
  const resolve = nameResolver(records, systems);
  return new Map(names.map((name) => [name, resolve(name)]));
}

/**
 * `resolveNames` for one name at a time, with the catalog read once (item 11 of beta.33: intake
 * resolved each diagram box by reading every record again, 1 s of each Apply at 60 repos).
 */
export function nameResolver(
  records: CatalogRecord[],
  systems: ProfileSystem[],
): (name: string) => NameResolution {
  const curated = curatedAliases(records);
  const componentsOf = new Map<string, string[]>();
  const ids = new Set<string>();
  for (const r of records)
    if (r.kind === "Component") {
      ids.add(r.id);
      const xs = componentsOf.get(r.system) ?? [];
      componentsOf.set(r.system, xs);
      xs.push(r.id);
    }
  for (const r of records) if (r.kind === "System") ids.add(r.id);
  for (const s of systems) ids.add(s.id);
  const idWords = [...ids].map((id) => ({ id, words: words(id) }));
  const profileName = new Map<string, string>();
  for (const s of systems)
    for (const n of [s.name, ...s.aliases]) profileName.set(n.toLowerCase(), s.id);
  const seen = new Map<string, NameResolution>();
  const resolve = (name: string): NameResolution => {
    const key = name.toLowerCase();
    const c = curated.get(key);
    if (c) return { name, id: c, how: "curated", similar: [] };
    if (ids.has(slug(name))) return { name, id: slug(name), how: "exact", similar: [] };
    const sys = profileName.get(key);
    if (sys) {
      const comps = componentsOf.get(sys) ?? [];
      return { name, id: comps.length === 1 ? comps[0]! : sys, how: "profile", similar: [] };
    }
    const w = words(name);
    const similar = idWords
      .map(({ id, words: iw }) => ({ id, score: [...iw].filter((x) => w.has(x)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, 3)
      .map((x) => x.id);
    return { name, similar };
  };
  return (name) => {
    const r = seen.get(name) ?? resolve(name);
    seen.set(name, r);
    return r;
  };
}
