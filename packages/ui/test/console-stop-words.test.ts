import { describe, expect, it } from "vitest";
import { isStopping, stateWords, stopHint } from "../src/app/activity.js";
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

describe("beta.27 re-review: the Console's words, merged with the screens' review", () => {
  it("a run that refused says so, whatever else it is (as the screens' rows give it)", () => {
    expect(stateWords({ state: "done", outcome: "refused" })).toBe(T.refused);
    expect(stateWords({ state: "failed" })).toBe(T.states.failed);
    expect(stateWords(entry({ state: "ended", outcome: "refused" }))).toBe(T.refused);
  });

  it("a job another atticus ui runs says it is stopped in that window; a command, its terminal", () => {
    const other = { ...entry({ id: "term-20261111-100000-4242-ab12" }), stop: undefined };
    expect(stopHint(other)).toBe(T.otherWindow);
    expect(stopHint({ ...other, kind: "command" as never, where: "terminal" as never })).toBe(
      T.stopTerminal,
    );
    // This window's own job has its Stop; one that ended needs none.
    expect(stopHint({ ...other, stop: "/api/jobs/job-1/cancel" })).toBeUndefined();
    expect(stopHint({ ...other, state: "done" as never })).toBeUndefined();
  });
});
