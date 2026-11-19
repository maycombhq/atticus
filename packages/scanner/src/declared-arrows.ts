import {
  arrowEndKey,
  cmpText,
  declaredArrows,
  factIdPart,
  interfaceId,
  type ArrowEnd,
  type CatalogRecord,
  type DeclaredArrow,
  type OrgPack,
} from "@maycombhq/core";
import { estateRepos } from "./merge-input.js";

/**
 * ADR 0204 1.5 to 1.8: the declared arrows of the profiles' `links`, as C1 has an arrow: one
 * asserted Interface each, flagged `declared-link`, its only evidence the person's word (`manual`,
 * the profile, who). Made again on every build from the profile, never kept on its own; pure.
 *
 * An arrow is not drawn while the build has a real call the same way between the same two boxes
 * (any Interface but a declared one: read from code, paired by a person or the AI); it is listed
 * in `superseded` instead, and the profile is left as it is. An item naming a repo or system the
 * manifests and profiles no longer have is listed in `orphaned` and kept in the profile.
 */

export const DECLARED_LINK = "declared-link";
const DECLARED = new Set([DECLARED_LINK, "declared-caller"]);

export interface DeclaredArrowBuild {
  records: CatalogRecord[];
  /** The arrows the code now shows, with how many real calls it shows. */
  superseded: { from: string; to: string; by: string; at: string; calls: number }[];
  /** The arrows with an end no manifest or profile has now (`missing`), or no box drawn yet. */
  orphaned: { from: string; to: string; missing: string; why: "gone" | "not-drawn" }[];
}

/** The records that are a box's: the one its arrow is drawn to, and all a real call may reach. */
function boxesOf(op: OrgPack, records: readonly CatalogRecord[]) {
  const repos = estateRepos(op);
  const systems = new Set(op.profiles.flatMap((p) => (p.profile?.systems ?? []).map((s) => s.id)));
  const comps = new Map<string, string[]>();
  const ids = new Set<string>();
  for (const r of records) {
    ids.add(`${r.kind}|${r.id}`);
    const repo = (r as { repo?: unknown }).repo;
    if (r.kind === "Component" && typeof repo === "string")
      comps.set(repo, [...(comps.get(repo) ?? []), r.id].sort(cmpText));
  }
  return (e: ArrowEnd): { main: string; all: Set<string> } | "gone" | "not-drawn" => {
    if ("repo" in e) {
      const r = repos.find((x) => x.id === e.repo);
      if (!r) return "gone";
      const mine = comps.get(r.id) ?? [];
      const main =
        [r.component, r.id, factIdPart(r.id)].find((c) => c && mine.includes(c)) ?? mine[0];
      return main ? { main, all: new Set(mine) } : "not-drawn";
    }
    if (!systems.has(e.system) && !repos.some((x) => x.system === e.system)) return "gone";
    if (!ids.has(`System|${e.system}`)) return "not-drawn";
    const inside = repos.filter((x) => x.system === e.system).flatMap((x) => comps.get(x.id) ?? []);
    return { main: e.system, all: new Set([e.system, ...inside]) };
  };
}

const endWords = (e: ArrowEnd) => ("repo" in e ? e.repo : e.system);

export function declaredArrowRecords(
  op: OrgPack,
  records: readonly CatalogRecord[],
  /** The arrows to build (the profiles' by default; one asked about, to tell a real call). */
  items: readonly DeclaredArrow[] = declaredArrows(op),
): DeclaredArrowBuild {
  const out: DeclaredArrowBuild = { records: [], superseded: [], orphaned: [] };
  if (!items.length) return out;
  const box = boxesOf(op, records);
  const real = records.filter(
    (r): r is Extract<CatalogRecord, { kind: "Interface" }> =>
      r.kind === "Interface" &&
      r.status !== "retired" &&
      r.status !== "planned-retire" &&
      !(r.flags ?? []).some((f) => DECLARED.has(f)),
  );
  for (const d of items) {
    const [a, b] = [box(d.from), box(d.to)];
    const from = arrowEndKey(d.from);
    const to = arrowEndKey(d.to);
    if (typeof a === "string" || typeof b === "string") {
      const [end, why] = typeof a === "string" ? [d.from, a] : [d.to, b as "gone" | "not-drawn"];
      out.orphaned.push({ from, to, missing: endWords(end), why });
      continue;
    }
    const calls = real.filter((r) => a.all.has(r.from) && b.all.has(r.to)).length;
    if (calls) {
      out.superseded.push({ from, to, by: d.by, at: d.at, calls });
      continue;
    }
    out.records.push(arrowInterface(d, a.main, b.main));
  }
  out.records.sort((x, y) => cmpText(x.id, y.id));
  return out;
}

function arrowInterface(d: DeclaredArrow, from: string, to: string): CatalogRecord {
  return {
    kind: "Interface",
    schemaVersion: 2,
    id: interfaceId(from, to, undefined, "/**"),
    status: d.planned ? "planned-new" : "current",
    confidence: "asserted",
    from,
    to,
    via: "other",
    normalizedPath: "/**",
    sync: "sync",
    direction: "outbound",
    conflicts: [],
    flags: [DECLARED_LINK],
    evidence: [{ source: "manual", path: d.file, by: d.by }],
  } as CatalogRecord;
}
