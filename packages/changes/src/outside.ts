import type { OrgPack } from "@maycombhq/core";
import { outsideProfileSystems } from "@maycombhq/scanner";

/**
 * O2: what a system outside the estate is. `vendor`: a profile system of boundary vendor (or a
 * catalog System of that boundary); `other-team`: any other system the profiles declare that no
 * estate repo belongs to, such as another team's (ADR 0142 reads its published spec as a
 * vendor's is). A system an estate repo belongs to is neither.
 */
export type OutsideKind = "vendor" | "other-team";

/** Every system outside the estate the org pack's profiles declare, by id, with what it is (O2). */
export function outsideSystemsOf(op: OrgPack): Map<string, OutsideKind> {
  return new Map(
    outsideProfileSystems(op).map(
      (s) => [s.id, s.boundary === "vendor" ? "vendor" : "other-team"] as const,
    ),
  );
}

/**
 * What a system is, outside the estate (O2): `vendor` when its catalog System's or profile's
 * boundary says so, `other-team` when the profiles declare it and no estate repo belongs to it,
 * else undefined (the estate's own, or unknown).
 */
export function outsideKindOf(
  outside: ReadonlyMap<string, OutsideKind>,
  system: string | undefined,
  catalogBoundary?: string,
): OutsideKind | undefined {
  if (!system) return undefined;
  if (catalogBoundary === "vendor") return "vendor";
  return outside.get(system);
}

/** An outside system in words, after its name: "a vendor", "another team's system" (O2). */
export const outsideWords = (k: OutsideKind): string =>
  k === "vendor" ? "a vendor" : "another team's system";
