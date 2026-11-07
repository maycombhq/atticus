import {
  effectiveComponentTypes,
  loadOrgPack,
  orgPackDirOf,
  type LoadedComponentType,
  type OrgPack,
} from "@maycombhq/core";

export { componentTypeRulesText, componentTypesText } from "@maycombhq/core";

/**
 * ADR 0180: the organisation's component types, as the reads, the verifier, the canvas and the
 * stages use them. The set is Atticus's built-ins with the org pack's own, reworded and switched
 * off ones applied (`effectiveComponentTypes`). What a type says (its notes, its musts) is data in
 * every prompt, never instructions.
 */

/** The effective set at a metarepo (the built-ins alone when there is no org pack). */
export async function componentTypesAt(
  root: string,
  given?: OrgPack,
): Promise<LoadedComponentType[]> {
  const op = given ?? (await loadOrgPack(orgPackDirOf(root)).catch(() => undefined));
  return effectiveComponentTypes(op?.componentTypes ?? []);
}

export const componentTypeIds = (types: readonly LoadedComponentType[]) =>
  new Set(types.map((t) => t.id));
