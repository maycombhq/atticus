import { expect, it, vi } from "vitest";

/**
 * Beta.28.4: a page that follows a job hears how far it is (the job's own progress, as GET
 * /api/jobs/{id} gives it), so an Apply over several repos can say which repo it is on. No
 * network (CLAUDE.md rule 5): the API is a stand-in.
 */
const polls = [
  {
    state: "running",
    errors: [],
    progress: { done: 1, total: 3, message: "Repo 1 of 3: forge-atlas…" },
  },
  { state: "running", errors: [] },
  {
    state: "running",
    errors: [],
    progress: { done: 2, total: 3, message: "Loading the catalog…" },
  },
  {
    state: "running",
    errors: [],
    stopping: true,
    progress: { done: 2, total: 3, message: "Stopping after this repo…" },
  },
  {
    state: "done",
    errors: [],
    progress: { done: 1, total: 1, message: "Done" },
    result: { code: 0, lines: ["ok"] },
  },
];
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  api: async (path: string) =>
    path === "/api/facts/apply-all" ? { jobId: "job-1" } : polls.shift(),
}));
const { followJob } = await import("../src/app/job.js");

it("tells the page the running job's progress on each look, and not its end", async () => {
  const heard: unknown[] = [];
  const r = await followJob(
    "/api/facts/apply-all",
    { repos: ["forge-atlas", "forge-ledger", "forge-zeta"] },
    () => Promise.resolve(),
    undefined,
    (p) => heard.push(p),
  );
  expect(r.lines).toEqual(["ok"]);
  expect(heard).toEqual([
    { done: 1, total: 3, message: "Repo 1 of 3: forge-atlas…" },
    { done: 2, total: 3, message: "Loading the catalog…" },
    // Stop was asked: the page hears the job is stopping.
    { done: 2, total: 3, message: "Stopping after this repo…", stopping: true },
  ]);
});
