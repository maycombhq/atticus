/**
 * ADR 0201 decision 8: the staged path says where to go. A change the stages can't express (it
 * places nothing, changes no step, or has nothing to plan) is told once, in the same words, that
 * it belongs on the quick path, with the command that starts it.
 */
export function quickPathHint(): string {
  return "If this change alters no runtime step in a repo the map holds (a new product, a move to another platform, pipeline or configuration work), it belongs on the quick path: write its requirements file and run atticus change new --from <requirements.md>.";
}

/**
 * The stage rules that mean the change isn't one for the staged path. A blocking finding of one
 * ends the stage loop on the draft it first appears in, with the hint (amending ADR 0087's end
 * rule): another draft would say the same, and it is no question for a person to answer.
 */
export const QUICK_PATH_RULES: ReadonlySet<string> = new Set([
  "feature.nothing-placed",
  "small.no-target-flow",
]);
