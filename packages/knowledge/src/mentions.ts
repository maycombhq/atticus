import type { CatalogRecord } from "@maycombhq/core";
import { curatedAliases, resolveNames, type ProfileSystem } from "@maycombhq/reconcile";

/** A name in a page that resolves to a catalog component or system. */
export interface Mention {
  /** The text as written. */
  name: string;
  /** Character offset in the text searched. */
  at: number;
  /** What the name resolves to: a component or system id. */
  id: string;
  /** The system it belongs to (the id itself when it is a system). */
  system: string;
  how: "curated" | "exact" | "profile";
}

export interface MentionIndex {
  find(text: string): Mention[];
  /** The system a component or system id belongs to. */
  systemOf(id: string): string | undefined;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Find system and component names in free text. Candidate names are the profile's system
 * names and aliases, curated alias names, and component and system ids (also written with
 * spaces, "ledger-api" → "ledger api"); each match is then resolved with `resolveNames`
 * from reconcile, so documents and diagrams resolve names the same way.
 */
export function mentionIndex(records: CatalogRecord[], systems: ProfileSystem[]): MentionIndex {
  const componentSystem = new Map<string, string>();
  const systemIds = new Set<string>(systems.map((s) => s.id));
  for (const r of records) {
    if (r.kind === "Component") componentSystem.set(r.id, r.system);
    if (r.kind === "System") systemIds.add(r.id);
  }
  const systemOf = (id: string) => componentSystem.get(id) ?? (systemIds.has(id) ? id : undefined);

  const candidates = new Set<string>();
  for (const s of systems) for (const n of [s.name, ...s.aliases]) candidates.add(n.toLowerCase());
  for (const n of curatedAliases(records).keys()) candidates.add(n);
  for (const id of [...componentSystem.keys(), ...systemIds]) {
    candidates.add(id);
    candidates.add(id.replace(/[-_.]+/g, " "));
  }
  const names = [...candidates].filter((c) => c.length > 1).sort((a, b) => b.length - a.length);
  // Longest names first; a name is a whole word: not inside an email, path or longer id.
  const re = names.length
    ? new RegExp(`(?<![\\w@.\\-/])(${names.map(escape).join("|")})(?![\\w@\\-/])`, "gi")
    : undefined;

  return {
    systemOf,
    find(text: string) {
      if (!re) return [];
      const found: { name: string; at: number }[] = [];
      for (const m of text.matchAll(re)) found.push({ name: m[1]!, at: m.index });
      const resolved = resolveNames([...new Set(found.map((f) => f.name))], records, systems);
      const out: Mention[] = [];
      for (const f of found) {
        const r = resolved.get(f.name);
        if (!r?.id || !r.how) continue;
        const system = systemOf(r.id);
        if (!system) continue;
        out.push({ name: f.name, at: f.at, id: r.id, system, how: r.how });
      }
      return out;
    },
  };
}
