import { afterEach, describe, expect, it, vi } from "vitest";
import { pollJob } from "../src/api/client.js";

/**
 * Review of beta.23: an editor panel hears no job.done or job.progress events, so Run all ready
 * tasks and Scans stayed "working" for good. A job they started is also followed by asking.
 */
afterEach(() => vi.unstubAllGlobals());

function serve(states: string[]) {
  vi.stubGlobal("document", { querySelector: () => null });
  let i = 0;
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      asked.push(path);
      const state = states[Math.min(i++, states.length - 1)];
      return new Response(
        JSON.stringify({
          id: "job-3",
          state,
          progress: { done: i, total: 3, message: `step ${i}` },
          errors: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  return asked;
}

describe("a job followed by asking", () => {
  it("hears each state until the job ends, then stops asking", async () => {
    const asked = serve(["running", "running", "done"]);
    const seen: string[] = [];
    await pollJob("job-3", (j) => void seen.push(j.state), { wait: async () => undefined })
      .finished;
    expect(seen).toEqual(["running", "running", "done"]);
    expect(asked).toEqual(["/api/jobs/job-3", "/api/jobs/job-3", "/api/jobs/job-3"]);
  });

  it("stops when told, and after a failed ask says so once", async () => {
    serve(["running"]);
    let n = 0;
    const p = pollJob("job-3", () => void n++, {
      wait: () => new Promise((r) => setTimeout(r, 5)),
    });
    await new Promise((r) => setTimeout(r, 12));
    p.stop();
    const at = n;
    await new Promise((r) => setTimeout(r, 20));
    expect(n).toBe(at);
    await p.finished;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
    const errors: unknown[] = [];
    await pollJob("job-9", () => undefined, {
      wait: async () => undefined,
      onError: (e) => void errors.push(e),
    }).finished;
    expect(errors).toHaveLength(1);
  });
});
