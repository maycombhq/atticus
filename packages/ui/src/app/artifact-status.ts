import { COPY } from "../copy.js";

const S = COPY.artifactStatus;

/**
 * Seventh UX walk: a change file's status in words. A status of ready or blocked says what the
 * phase allows, so a file that isn't there (API 2.70.0's `written`, false) says it isn't written
 * yet; an older server that doesn't say goes by the status alone.
 */
export function artifactStatusWord(a: { status: string; written?: boolean }): string {
  if (a.status === "done") return S.written;
  if (a.status === "not-required") return S.notRequired;
  if (a.written === false) return S.notWritten;
  if (a.written === true) return S.needsWork;
  return a.status === "blocked" ? S.blocked : S.ready;
}
