import { describe, expect, it } from "vitest";
import { isStopping, stateWords } from "../src/app/activity.js";
import { COPY } from "../src/copy.js";

/**
 * Beta.27 review: Stop on a sync showed "Stopping…" only while its request ran, then "running"
 * again while the sync went on; and after the app restarted, the jobs it had started were gone.
 * The Console says "stopping…" until the job ends, and a job an earlier run of the app started,
 * running when it closed, "stopped when the app closed".
 */
const T = COPY.activity;
const entry = (o: Partial<Parameters<typeof stateWords>[0]> & { id?: string }) => ({
  id: "job-1",
  kind: "sync" as const,
  where: "app" as const,
  state: "running" as const,
  startedAt: "2026-11-11T10:00:00.000Z",
  lines: 0,
  from: 0,
  ...o,
});

describe("the Console's words for a stop", () => {
  it("says stopping until the job ends, then cancelled", () => {
    expect(stateWords(entry({}))).toBe(T.states.running);
    expect(stateWords(entry({ stopping: true }))).toBe(T.stoppingState);
    expect(stateWords(entry({ state: "cancelled" }))).toBe(T.states.cancelled);
    expect(isStopping({}, entry({ stopping: true }) as never)).toBe(true);
    expect(isStopping({ stopping: "job-1" }, entry({}) as never)).toBe(true);
    expect(isStopping({}, entry({}) as never)).toBe(false);
    expect(isStopping({}, entry({ state: "cancelled", stopping: true }) as never)).toBe(false);
  });

  it("says a job of an earlier run of the app stopped when the app closed", () => {
    expect(stateWords(entry({ state: "ended", id: "term-20261111-100000-4242-ab12" }))).toBe(
      T.appClosedState,
    );
    // A command in a terminal that ended without saying keeps its own words.
    expect(stateWords(entry({ state: "ended", where: "terminal" as never }))).toBe(T.states.ended);
  });
});
