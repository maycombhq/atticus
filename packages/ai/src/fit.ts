import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Every prompt fits the model it goes to (ADR 0112). A step is told the model's limit
 * (`atticus <step> --max-tokens n`: the whole prompt must fit n tokens) and builds its pack to
 * fit: its budget becomes the smaller of its own and the room the limit leaves.
 *
 * Tokens are counted as the pack counts them (`estimateTokens`: characters / 4). Code and YAML
 * tokenize nearer 3 characters a token, so a quarter of the limit is kept back for the
 * counter's error, and a fixed frame for what goes around the pack (the hand-off's heading,
 * result file and finishing command, and the VS Code runner's preface).
 */

/** The share of the model's limit kept back for the counter's error. */
export const PROMPT_MARGIN = 0.25;
/** Tokens kept for the hand-off frame and the runner's preface around the pack. */
export const PROMPT_FRAME_TOKENS = 400;

/** The tokens a pack may take for a model of `maxTokens`. */
export function promptBudget(maxTokens: number): number {
  return Math.max(0, Math.floor(maxTokens * (1 - PROMPT_MARGIN)) - PROMPT_FRAME_TOKENS);
}

const limit = new AsyncLocalStorage<number>();

/**
 * Run `fn` with a model limit every pack built inside it honours (the CLI does this for
 * `--max-tokens`), so each step fits without each passing the limit down by hand. Scoped to
 * the async call, so steps running side by side (the app's server) keep their own.
 */
export function withPromptLimit<T>(maxTokens: number | undefined, fn: () => T): T {
  return maxTokens === undefined ? fn() : limit.run(maxTokens, fn);
}

/** The model limit of the step running now, if it was given one. */
export function currentPromptLimit(): number | undefined {
  return limit.getStore();
}

/** A step's budget fitted to the model's limit: given, else the step's (withPromptLimit). */
export function fitBudget(budget: number, maxTokens = currentPromptLimit()): number {
  return maxTokens === undefined ? budget : Math.min(budget, promptBudget(maxTokens));
}

/** The words that say what to do when a step's prompt can't fit. */
export const BIGGER_MODEL =
  "Use a model with a bigger limit (atticus.model in VS Code, or adapters.model in runtime.yaml)";

/**
 * A step's smallest useful prompt (its instructions and the sources it can't work without)
 * doesn't fit the model's limit. Thrown before anything is handed off, so the person hears it
 * from the step with the numbers and what to do, not from the runner after.
 */
export class PromptTooLong extends Error {
  constructor(
    readonly step: string,
    /** Tokens the smallest useful prompt takes, as the pack counts them. */
    readonly needed: number,
    /** Tokens the model's limit leaves for the prompt. */
    readonly budget: number,
    readonly maxTokens: number,
    /** The sources it can't do without, beside its instructions. */
    readonly required: string[],
    /** The step's smaller form, when it has one (e.g. "--batch-tokens n for fewer pages at a time"). */
    readonly smaller?: string,
  ) {
    super(
      `atticus ${step} can't fit its smallest useful prompt in the model: it needs about ${needed} tokens (its instructions${required.length ? ` and ${required.join(", ")}` : ""}), and a model of ${maxTokens} tokens leaves ${budget} for the prompt. ${BIGGER_MODEL}${smaller ? `, or ${smaller}` : ""}.`,
    );
    this.name = "PromptTooLong";
  }
}
