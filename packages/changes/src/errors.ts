import type { Artifact } from "./types.js";

/** Why a change can't move on. Each reason is one plain sentence for people, plus its subject. */
export type ReasonCode =
  | "wrong-state"
  | "missing-artifact"
  | "unfilled-artifact"
  | "blocking-finding"
  | "open-gap"
  | "bad-finding"
  | "critic-round-missing"
  | "lens-waiting"
  | "privacy-role-missing"
  | "approval-missing"
  | "self-approval"
  | "separation"
  | "changes-requested"
  | "no-handoff"
  | "host-refused"
  | "pr-closed";

export interface Reason {
  code: ReasonCode;
  message: string;
  artifact?: Artifact;
  finding?: string;
  role?: string;
  person?: string;
}

export type ChangeErrorCode = "not-found" | "invalid" | "conflict" | "refused";

/**
 * An operation on a change that can't go ahead. `refused` carries the reasons (missing
 * artifacts, blocking findings, approvals), so callers can show all of them at once.
 */
export class ChangeError extends Error {
  constructor(
    readonly code: ChangeErrorCode,
    message: string,
    readonly reasons: Reason[] = [],
  ) {
    super(message);
    this.name = "ChangeError";
  }
}
