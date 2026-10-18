/** Errors from setup commands, with a code the CLI maps to an exit code (usage → 2). */
export class AdoptError extends Error {
  constructor(
    readonly code: "usage" | "exists" | "not-found" | "not-adopted" | "source",
    message: string,
  ) {
    super(message);
    this.name = "AdoptError";
  }
}
