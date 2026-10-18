/** Errors with a plain message for the CLI; `code` maps to exit codes there (invalid → 2). */
export class TestgenError extends Error {
  constructor(
    readonly code: "not-found" | "invalid" | "refused",
    message: string,
  ) {
    super(message);
    this.name = "TestgenError";
  }
}
