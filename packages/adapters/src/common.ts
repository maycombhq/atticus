import { z } from "zod";

/**
 * Shared rules for every adapter (contract C4).
 *
 * Safety rule, not configurable: a person approves every write to a shared system. So
 * every write method takes an Approval, and adapters refuse a write without a valid one.
 * "standing" approvals exist only for notifications, which a person turns on once.
 */
export const Approval = z.strictObject({
  /** The person who approved: a handle from the Git host or directory. */
  by: z.string().min(1),
  at: z.iso.datetime({ offset: true }),
  scope: z.enum(["once", "standing"]).default("once"),
  /** What was approved, e.g. a finding, hand-off PR or artifact path. */
  ref: z.string().min(1),
});
export type Approval = z.input<typeof Approval>;

export type AdapterErrorCode =
  | "not-found"
  | "unauthorized"
  | "rate-limited"
  | "conflict"
  | "unavailable"
  | "invalid"
  | "not-approved";

export class AdapterError extends Error {
  constructor(
    readonly adapter: string,
    readonly code: AdapterErrorCode,
    message: string,
    /** True when trying again later may work (rate limits, outages). */
    readonly retryable = code === "rate-limited" || code === "unavailable",
  ) {
    super(`${adapter}: ${message}`);
    this.name = "AdapterError";
  }
}

/** Throws not-approved unless the approval is valid and allowed for this write. */
export function requireApproval(
  adapter: string,
  approval: Approval | undefined,
  opts: { allowStanding?: boolean } = {},
): z.infer<typeof Approval> {
  const r = Approval.safeParse(approval);
  if (!r.success) {
    throw new AdapterError(
      adapter,
      "not-approved",
      "this write needs a person's approval (by, at, ref)",
    );
  }
  if (r.data.scope === "standing" && !opts.allowStanding) {
    throw new AdapterError(
      adapter,
      "not-approved",
      "a standing approval can't cover this write; it needs approval each time",
    );
  }
  return r.data;
}

/** One recorded adapter call, so tests can assert exactly what would have been sent. */
export interface JournalEntry {
  adapter: string;
  method: string;
  args: unknown[];
  approval?: z.infer<typeof Approval>;
}

/** Test controls every mock has. */
export interface MockControls {
  readonly journal: readonly JournalEntry[];
  /** Make the next call (or the next call to `method`) fail with this error. */
  failNext(code: AdapterErrorCode, method?: string): void;
}

/** Base for mocks: a journal and injectable failures. */
export class MockBase implements MockControls {
  readonly journal: JournalEntry[] = [];
  private failures: { code: AdapterErrorCode; method?: string }[] = [];

  constructor(protected readonly name: string) {}

  failNext(code: AdapterErrorCode, method?: string): void {
    this.failures.push(method === undefined ? { code } : { code, method });
  }

  /** Record a call and raise an injected failure if one is due. */
  protected call(method: string, args: unknown[], approval?: z.infer<typeof Approval>): void {
    const i = this.failures.findIndex((f) => f.method === undefined || f.method === method);
    if (i !== -1) {
      const [f] = this.failures.splice(i, 1);
      throw new AdapterError(this.name, f!.code, `injected ${f!.code} on ${method}`);
    }
    this.journal.push(
      approval
        ? { adapter: this.name, method, args, approval }
        : { adapter: this.name, method, args },
    );
  }

  protected notFound(what: string): never {
    throw new AdapterError(this.name, "not-found", `${what} not found`);
  }
}
