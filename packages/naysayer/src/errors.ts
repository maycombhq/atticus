export type CriticErrorCode = "not-found" | "no-gate" | "round-limit" | "invalid" | "refused";

/** A critic operation that can't go ahead, with a plain sentence saying why. */
export class CriticError extends Error {
  constructor(
    readonly code: CriticErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CriticError";
  }
}
