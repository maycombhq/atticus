/** Errors with a plain message for the CLI; `code` maps to exit codes there. */
export class PlannerError extends Error {
  constructor(
    readonly code: "not-found" | "invalid" | "refused" | "ai-failed",
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "PlannerError";
  }
}
