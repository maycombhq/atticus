import { LockHeldError, lockFileOf, readLock } from "@maycombhq/core";

/**
 * ADR 0210 part 5: before a run that writes spends anything, that its result can be written: no
 * other write holds the metarepo's lock, and no upgrade is owed (the build's `not-upgraded`).
 * The words of what stops it, or undefined.
 */
export async function runPreflight(root: string): Promise<string | undefined> {
  const held = await readLock(root, "scan");
  if (held && !held.stale) return new LockHeldError(held, lockFileOf(root, "scan")).message;
  const { slotsStepWaits } = await import("./standing.js");
  if (await slotsStepWaits(root))
    return "The catalog waits for atticus upgrade, so this run's result can't be written: run atticus upgrade --yes first.";
  return undefined;
}
