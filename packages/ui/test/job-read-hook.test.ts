import { afterEach, expect, it, vi } from "vitest";
import { mount } from "./support/hooks.js";

/**
 * The hunt of beta.28.1 (S4): useJobRead's Stop is of the job under way. A read of another
 * path forgets the last one's job (its Stop would stop a job nobody waits on), and "Stopping…"
 * is of the job Stop was pressed on, never of the next one. Invented Forge paths.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
afterEach(() => vi.unstubAllGlobals());

const { useJobRead } = await import("../src/api/client.js");

it("a read of another path has no Stop until its own job is named, and isn't stopping", async () => {
  vi.stubGlobal("document", { querySelector: () => null });
  const cancelled = new Set<string>();
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (path.startsWith("/api/links/candidates?from=forge-ledger"))
        return json(202, { jobId: "job-1" });
      // The second read's job isn't named yet.
      if (path.startsWith("/api/links/candidates?from=forge-payments"))
        return new Promise<Response>(() => undefined);
      const id = /\/api\/jobs\/(job-\d+)/.exec(path)?.[1];
      if (id && path.endsWith("/cancel")) {
        cancelled.add(id);
        return json(200, { id, state: "cancelled" });
      }
      if (id)
        return json(200, {
          state: cancelled.has(id) ? "cancelled" : "running",
          errors: [],
          progress: { done: 0, total: 1, message: "Joining the estate's calls and APIs" },
        });
      return json(404, {});
    }),
  );
  const props = { path: "/api/links/candidates?from=forge-ledger&to=forge-gateway" };
  const m = mount((p: typeof props) => useJobRead<unknown>(p.path), props);
  const read = () => m.tree as ReturnType<typeof useJobRead<unknown>>;
  await vi.waitFor(() => {
    m.render();
    expect(read().stop).toBeDefined();
  });
  read().stop!();
  m.render();
  expect(read().stopping).toBe(true);
  props.path = "/api/links/candidates?from=forge-payments&to=forge-gateway";
  m.render();
  expect(read().state).toBe("loading");
  expect(read().stop).toBeUndefined();
  expect(read().stopping).toBe(false);
  expect(calls.filter((c) => c.endsWith("/cancel"))).toEqual(["POST /api/jobs/job-1/cancel"]);
});
