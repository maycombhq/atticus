import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/** ADR 0183: Apply, then Propose for review: the list first, then exactly the ticked files. */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const calls: { path: string; body?: unknown }[] = [];
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  api: async (path: string, o?: { body?: unknown }) => {
    calls.push({ path, ...(o?.body ? { body: o.body } : {}) });
    if (path.startsWith("/api/propose?"))
      return {
        scope: "answers",
        files: [
          { path: "questions/q1.yaml", status: "??" },
          { path: "facts/forge-ledger.jsonl", status: "M" },
        ],
        branch: "propose/answers/2026-11-08-pat",
        title: "Answers to the map's questions",
      };
    // Round 41: one local step at a time; the server refuses a second with a 409 problem.
    if (path === "/api/facts/forge-busy/apply") {
      const { ApiError } =
        await vi.importActual<typeof import("../src/api/client.js")>("../src/api/client.js");
      throw new ApiError({
        type: "about:blank",
        title: "Conflict",
        status: 409,
        detail:
          "Bringing in what merged is running on this server (job-9): wait for it to finish, then try again.",
      });
    }
    // Apply and Propose run as server jobs: the start answers its id, the job its lines.
    if (path.endsWith("/apply")) return { jobId: "job-1" };
    if (path === "/api/propose") return { jobId: "job-2" };
    if (path === "/api/propose/bring-in") return { jobId: "job-3" };
    if (path === "/api/jobs/job-3")
      return {
        state: "failed",
        errors: [],
        result: { code: 1, lines: ["What merged also changes files you edited: other.md"] },
      };
    if (path === "/api/jobs/job-1")
      return {
        state: "done",
        errors: [],
        result: { code: 0, lines: ["forge-ledger: 12 facts kept"] },
      };
    if (path === "/api/jobs/job-2")
      return {
        state: "done",
        errors: [],
        result: { code: 0, lines: ["PR #7 is open for review: https://git.example.com/pr/7"] },
      };
    return {};
  },
}));
const { COPY } = await import("../src/copy.js");
const { ApplyAndPropose, Propose } = await import("../src/app/propose.js");
const P = COPY.propose;
const tick = () => new Promise((r) => setTimeout(r, 0));

it("applies, lists, lets a file be left out, and proposes the rest", async () => {
  const m = mount(ApplyAndPropose as never, { scope: "answers", repo: "forge-ledger" } as never);
  const btn = (label: string) =>
    all(m.tree).find((e) => e.type === "button" && text(e.props.children) === label)!;
  (btn(P.apply("forge-ledger")).props.onClick as () => void)();
  await tick();
  m.render();
  expect(text(m.tree)).toContain("forge-ledger: 12 facts kept");
  const n = mount(Propose as never, { scope: "answers" } as never);
  const nbtn = (label: string) =>
    all(n.tree).find((e) => e.type === "button" && text(e.props.children) === label)!;
  (nbtn(P.propose).props.onClick as () => void)();
  await tick();
  n.render();
  expect(text(n.tree)).toContain("propose/answers/2026-11-08-pat");
  const boxes = all(n.tree).filter((e) => e.type === "input" && e.props.type === "checkbox");
  (boxes[1]!.props.onChange as (e: unknown) => void)({ target: { checked: false } });
  n.render();
  (nbtn(P.yes(1)).props.onClick as () => void)();
  await tick();
  n.render();
  expect(calls.map((c) => c.path)).toEqual([
    "/api/facts/forge-ledger/apply",
    "/api/jobs/job-1",
    "/api/propose?scope=answers",
    "/api/propose",
    "/api/jobs/job-2",
  ]);
  expect(calls[3]!.body).toEqual({
    scope: "answers",
    files: ["questions/q1.yaml"],
    branch: "propose/answers/2026-11-08-pat",
  });
  expect(text(n.tree)).toContain("PR #7 is open for review");
});

it("an Apply the server won't start says why, not that verify found problems", async () => {
  const m = mount(ApplyAndPropose as never, { scope: "answers", repo: "forge-busy" } as never);
  const btn = all(m.tree).find(
    (e) => e.type === "button" && text(e.props.children) === P.apply("forge-busy"),
  )!;
  (btn.props.onClick as () => void)();
  for (let i = 0; i < 5; i++) await tick();
  m.render();
  const note = all(m.tree).find((e) => e.props.note !== undefined)!.props.note as {
    ok: boolean;
    text: string;
  };
  expect(note).toEqual({
    ok: false,
    text: P.notStarted(
      "Bringing in what merged is running on this server (job-9): wait for it to finish, then try again.",
    ),
  });
  expect(text(m.tree)).not.toContain(P.applyFailed);
});

it("a job that stopped is an error with its lines", async () => {
  const { followJob } = await import("../src/app/propose.js");
  const err = await followJob("/api/propose/bring-in", {}, async () => undefined).catch(
    (e: Error) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe("What merged also changes files you edited: other.md");
});
