/**
 * What a conformance run reports. Every check is listed, passed or not, so a report reads as
 * a checklist; `passed` is true only when no check failed (warnings don't fail a run).
 */

export type ConformanceKind = "catalog" | "org-pack" | "dialect" | "plugin" | "executor";

export interface ConformanceResult {
  /** Stable check id, e.g. "catalog.canonical". */
  check: string;
  status: "pass" | "fail" | "warn";
  message: string;
  /** File the result is about, relative to the target when it is a folder. */
  file?: string;
}

export interface ConformanceReport {
  kind: ConformanceKind;
  target: string;
  /** The specification version the run checked against (docs/spec/VERSION). */
  specVersion: string;
  passed: boolean;
  results: ConformanceResult[];
  /** Counts for a one-line summary. */
  summary: { pass: number; fail: number; warn: number };
}

/** Collects results; `report()` sorts nothing, so results read in the order checks ran. */
export class Results {
  readonly list: ConformanceResult[] = [];
  pass(check: string, message: string, file?: string) {
    this.list.push({ check, status: "pass", message, ...(file ? { file } : {}) });
  }
  fail(check: string, message: string, file?: string) {
    this.list.push({ check, status: "fail", message, ...(file ? { file } : {}) });
  }
  warn(check: string, message: string, file?: string) {
    this.list.push({ check, status: "warn", message, ...(file ? { file } : {}) });
  }
  /** A check that held for every item gets one pass line instead of one per item. */
  passUnlessFailed(check: string, message: string) {
    if (!this.list.some((r) => r.check === check && r.status === "fail")) this.pass(check, message);
  }
  report(kind: ConformanceKind, target: string): ConformanceReport {
    const count = (s: ConformanceResult["status"]) =>
      this.list.filter((r) => r.status === s).length;
    const summary = { pass: count("pass"), fail: count("fail"), warn: count("warn") };
    return {
      kind,
      target,
      specVersion: SPEC_VERSION,
      passed: summary.fail === 0,
      results: this.list,
      summary,
    };
  }
}

/**
 * The version of the published specification (docs/spec/VERSION) this suite checks. Kept
 * here as a constant so the package works outside the repo; a test keeps the two equal.
 */
export const SPEC_VERSION = "0.1.0";
