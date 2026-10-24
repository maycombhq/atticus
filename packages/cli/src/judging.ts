import { runtimeForCli, type AiRuntime } from "@maycombhq/ai";

/**
 * The runtime a command's judgments of meaning are asked through (ADR 0117 addendum): the one
 * runtime.yaml names (or ATTICUS_RUNTIME). The judge is asked only when it calls a model
 * directly; with the hand-off runtime nothing is asked, and what no one has judged is shown to
 * a person. A view never fails for it: a runtime that can't be built judges nothing.
 *
 * Tests pass `runtime` (null for none).
 */
export async function judgingRuntime(
  root: string,
  given?: AiRuntime | null,
): Promise<AiRuntime | undefined> {
  if (given === null) return undefined;
  if (given) return given;
  try {
    return (await runtimeForCli(root)).runtime;
  } catch {
    return undefined;
  }
}
