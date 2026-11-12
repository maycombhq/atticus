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
    // An Apply with no clone here: the job's next is Sync the repos (review of beta.23).
    if (path === "/api/facts/forge-noclone/apply") return { jobId: "job-5" };
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
    // ADR 0195 point 4: an Apply whose build would remove more than the limit refuses, listing
    // the removals; the same Apply with their count confirms them.
    if (path === "/api/facts/forge-small/apply")
      return {
        jobId: (o?.body as { allowRemovals?: number }).allowRemovals === 2 ? "job-7" : "job-6",
      };
    if (path === "/api/jobs/job-6")
      return {
        state: "done",
        errors: [],
        result: {
          code: 1,
          lines: ["Nothing written: catalog/generated and every slot are as they were."],
          refused: {
            reasons: ["large-removals"],
            message: "This would remove 2 records (2 of forge-small's 12).",
            removals: [
              {
                path: "catalog/generated/interface/if-web-api.yaml",
                kind: "Interface",
                id: "if-web-api",
                repos: ["forge-small"],
                explainedBy: ["an input changed (facts/*.corrections.jsonl)"],
                reasons: ["input"],
              },
              {
                path: "catalog/generated/capability/feature.notes.yaml",
                kind: "Capability",
                id: "feature.notes",
                repos: ["forge-small"],
                explainedBy: ["an input changed (facts/*.corrections.jsonl)"],
                reasons: ["input"],
              },
            ],
            allowRemovals: 2,
            command: "atticus verify forge-small --write --allow-removals 2",
          },
        },
      };
    if (path === "/api/jobs/job-7")
      return { state: "done", errors: [], result: { code: 0, lines: ["forge-small: applied"] } };
    // Apply and Propose run as server jobs: the start answers its id, the job its lines.
    if (path.endsWith("/apply")) return { jobId: "job-1" };
    if (path === "/api/propose") return { jobId: "job-2" };
    // ADR 0186: the Yes asks for the person's confirmation first.
    if (path === "/api/confirmations") return { confirmation: "c".repeat(43) };
    if (path === "/api/propose/bring-in") return { jobId: "job-3" };
    // Review of beta.23: a sync that failed says why in its errors, its lines empty.
    if (path === "/api/workspace/sync") return { jobId: "job-4" };
    if (path === "/api/jobs/job-4")
      return {
        state: "failed",
        errors: ["Not in any repos.manifest.yaml: nope"],
        result: { code: 2, lines: [] },
      };
    if (path === "/api/jobs/job-5")
      return {
        state: "failed",
        errors: ["No checkout of forge-noclone on this machine: Sync the repos to clone it."],
        result: {
          code: 2,
          lines: ["No checkout of forge-noclone on this machine: Sync the repos to clone it."],
          next: { step: "sync", repos: ["forge-noclone"] },
        },
      };
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
const { ApplyAndPropose, onWorkChanged, Propose } = await import("../src/app/propose.js");
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
    "/api/confirmations",
    "/api/propose",
    "/api/jobs/job-2",
  ]);
  expect(calls[3]!.body).toEqual({ write: "propose", target: "answers", pageKey: "" });
  expect(calls[4]!.body).toEqual({
    scope: "answers",
    files: ["questions/q1.yaml"],
    branch: "propose/answers/2026-11-08-pat",
    confirmation: "c".repeat(43),
  });
  expect(text(n.tree)).toContain("PR #7 is open for review");
});

it("an Apply that ended says so, so the map's bar and Home's list read again", async () => {
  const m = mount(
    ApplyAndPropose as never,
    { scope: "corrections", repo: "forge-ledger" } as never,
  );
  let heard = 0;
  const off = onWorkChanged(() => void heard++);
  const btn = all(m.tree).find(
    (e) => e.type === "button" && text(e.props.children) === P.apply("forge-ledger"),
  )!;
  (btn.props.onClick as () => void)();
  await tick();
  off();
  expect(heard).toBe(1);
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

it("a sync that failed says why: its errors, when its lines say nothing", async () => {
  const { followJob } = await import("../src/app/propose.js");
  const err = await followJob("/api/workspace/sync", { repos: ["nope"] }, async () => undefined)
    .then(() => undefined)
    .catch((e: Error) => e);
  expect(err?.message).toBe("Not in any repos.manifest.yaml: nope");
});

it("an Apply with no clone here offers Sync the repos for it", async () => {
  const { SyncFirst } = await import("../src/app/sync-first.js");
  const m = mount(ApplyAndPropose as never, { scope: "answers", repo: "forge-noclone" } as never);
  const btn = all(m.tree).find(
    (e) => e.type === "button" && text(e.props.children) === P.apply("forge-noclone"),
  )!;
  (btn.props.onClick as () => void)();
  for (let i = 0; i < 5; i++) await tick();
  m.render();
  const sync = all(m.tree).find((e) => e.type === SyncFirst);
  expect(sync?.props.repos).toEqual(["forge-noclone"]);
});

it("Sync the repos syncs exactly the repos with no clone", async () => {
  const { SyncFirst } = await import("../src/app/sync-first.js");
  const m = mount(SyncFirst as never, { repos: ["forge-ok"] } as never);
  expect(text(m.tree)).toContain(COPY.appStep.syncFirstSay("forge-ok"));
  const btn = all(m.tree).find(
    (e) => e.type === "button" && text(e.props.children) === COPY.appStep.sync,
  )!;
  calls.length = 0;
  (btn.props.onClick as () => void)();
  for (let i = 0; i < 5; i++) await tick();
  m.render();
  expect(calls[0]).toEqual({ path: "/api/workspace/sync", body: { repos: ["forge-ok"] } });
});

it("an Apply whose build waits for a confirm lists the removals, and confirms them with their count", async () => {
  const { RefusalView } = await import("../src/screens/setup/CatalogBuild.js");
  const m = mount(ApplyAndPropose as never, { scope: "corrections", repo: "forge-small" } as never);
  const btn = all(m.tree).find(
    (e) => e.type === "button" && text(e.props.children) === P.apply("forge-small"),
  )!;
  calls.length = 0;
  (btn.props.onClick as () => void)();
  await vi.waitFor(() => {
    m.render();
    expect(all(m.tree).find((e) => e.type === RefusalView)).toBeDefined();
  });
  const view = all(m.tree).find((e) => e.type === RefusalView)!;
  const refused = view.props.refused as { allowRemovals: number; removals: unknown[] };
  expect(refused.allowRemovals).toBe(2);
  expect(refused.removals).toHaveLength(2);
  expect((view.props.confirmLabel as (n: number) => string)(2)).toBe(P.confirmApply(2));
  // Confirmed with the count listed: the same Apply again, with --allow-removals 2.
  await (view.props.onAllowRemovals as (n: number) => Promise<void>)(2);
  m.render();
  expect(calls.filter((c) => c.path === "/api/facts/forge-small/apply")).toEqual([
    { path: "/api/facts/forge-small/apply", body: {} },
    { path: "/api/facts/forge-small/apply", body: { allowRemovals: 2 } },
  ]);
  expect(all(m.tree).find((e) => e.type === RefusalView)).toBeUndefined();
  expect(text(m.tree)).toContain("forge-small: applied");
});
