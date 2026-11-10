import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, callAsJob } from "../src/api/client.js";

/**
 * Review of beta.23 (API 3.9.0): a slow write (a task run's Done, a live work-tracker sync) runs
 * as a job: the page asks with `job: true`, follows the job, and gets the call's own answer, or
 * its refusal, as before. An editor panel hears no live events, so following is by asking.
 */
afterEach(() => vi.unstubAllGlobals());

type Answer = { status: number; body: unknown };
function serve(answers: (path: string, init: RequestInit | undefined) => Answer) {
  vi.stubGlobal("document", { querySelector: () => null });
  const calls: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const a = answers(path, init);
      return new Response(JSON.stringify(a.body), {
        status: a.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}
const now = async () => undefined;

describe("a write run as a job", () => {
  it("asks for a job, follows it, and gives the call's own answer", async () => {
    let asked = 0;
    const calls = serve((path) =>
      path === "/api/runs/r1/done"
        ? { status: 202, body: { jobId: "job-4" } }
        : ++asked < 3
          ? { status: 200, body: { state: "running", errors: [] } }
          : {
              status: 200,
              body: { state: "done", errors: [], result: { answer: { state: "validated" } } },
            },
    );
    const r = await callAsJob<{ state: string }>("/api/runs/r1/done", {}, now);
    expect(r).toEqual({ state: "validated" });
    expect(calls[0]).toEqual({ path: "/api/runs/r1/done", body: { job: true } });
    expect(calls.filter((c) => c.path === "/api/jobs/job-4")).toHaveLength(3);
  });

  it("throws a refusal the job ended with as the call's own problem, its lines kept", async () => {
    serve((path) =>
      path === "/api/runs/r1/done"
        ? { status: 202, body: { jobId: "job-5" } }
        : {
            status: 200,
            body: {
              state: "failed",
              errors: ["build failed"],
              result: {
                problem: {
                  type: "x",
                  title: "Atticus can't do that yet",
                  status: 422,
                  detail: "build failed",
                  lines: ["build failed"],
                },
                lines: ["build failed"],
              },
            },
          },
    );
    const e = await callAsJob("/api/runs/r1/done", {}, now).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    const p = (e as ApiError).problem as { status: number; lines?: string[] };
    expect(p.status).toBe(422);
    expect(p.lines).toEqual(["build failed"]);
  });

  it("says a job stopped before its answer, and takes an older server's own answer", async () => {
    serve((path) =>
      path === "/api/x"
        ? { status: 202, body: { jobId: "job-6" } }
        : { status: 200, body: { state: "cancelled", errors: [] } },
    );
    const e = await callAsJob("/api/x", {}, now).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/stopped/);
    serve(() => ({ status: 200, body: { state: "validated" } }));
    expect(await callAsJob("/api/runs/r1/done", { confirmation: "c" }, now)).toEqual({
      state: "validated",
    });
  });
});
