import type { DeterministicCheckDef } from "../hits.js";
import {
  factKnown,
  knowledgeCheck,
  observabilityPresent,
  snowDraftsPresent,
  vendorOperationKnown,
} from "./catalog.js";
import {
  dataColumnsClassified,
  dataDocPresent,
  dataMigrationNamed,
  dataRetentionStated,
} from "./data.js";
import {
  interfaceEndsInCatalog,
  interfaceHasPattern,
  interfaceIdsInCatalog,
  interfacePatternApproved,
  interfaceViaMatchesPattern,
  patternCodeInRegistry,
  settingsPresent,
} from "./interfaces.js";
import {
  breakingDeltaConsumers,
  callTimeoutStated,
  routeCallersKnown,
  publicEntryAuth,
  storeWriteRollback,
} from "./questions.js";
import {
  mappingsCoverInterfaces,
  noEmbeddedInstructions,
  specScenariosPresent,
  storyHasAcceptanceCriteria,
  tasksCoverStories,
} from "./plan.js";

/**
 * The built-in deterministic checks a C3 rule can name in `check.check`. Layer 1 of the
 * critic: zero tokens, files only. Plugins add their own through `runCritic`'s `checks`.
 */
export const BUILT_IN_CHECKS: readonly DeterministicCheckDef[] = [
  interfacePatternApproved,
  patternCodeInRegistry,
  interfaceHasPattern,
  interfaceViaMatchesPattern,
  interfaceEndsInCatalog,
  interfaceIdsInCatalog,
  settingsPresent,
  observabilityPresent,
  storyHasAcceptanceCriteria,
  specScenariosPresent,
  dataDocPresent,
  dataMigrationNamed,
  dataColumnsClassified,
  dataRetentionStated,
  snowDraftsPresent,
  noEmbeddedInstructions,
  knowledgeCheck,
  factKnown,
  vendorOperationKnown,
  mappingsCoverInterfaces,
  tasksCoverStories,
  // Added with the four questions (ADR 0124 addendum, Part 4).
  callTimeoutStated,
  publicEntryAuth,
  breakingDeltaConsumers,
  storeWriteRollback,
  // Who a gateway route lets in (ADR 0124 addendum A-callers).
  routeCallersKnown,
];

export function checkRegistry(
  extra: DeterministicCheckDef[] = [],
): Map<string, DeterministicCheckDef> {
  const m = new Map<string, DeterministicCheckDef>();
  for (const c of [...BUILT_IN_CHECKS, ...extra]) m.set(c.id, c);
  return m;
}
