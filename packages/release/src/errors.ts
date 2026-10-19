/** A release view that can't be made: the change is missing, or the request is wrong. */
export class ReleaseError extends Error {
  constructor(
    message: string,
    readonly code: "not-found" | "usage" | "refused" | "invalid" = "invalid",
  ) {
    super(message);
    this.name = "ReleaseError";
  }
}
