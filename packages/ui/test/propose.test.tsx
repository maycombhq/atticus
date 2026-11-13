import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/** ADR 0183: Apply, then Propose for review: the list first, then exactly the ticked files. */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const calls: { path: string; body?: unknown }[] = [];
const flashed: { text: string }[] = [];
vi.mock("../src/app/flash.js", () => ({
  flash: (f: { text: string } | undefined) => void (f && flashed.push(f)),
}));
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
        jobId:
          (o?.body as { allowRemovals?: number; plan?: string }).allowRemovals === 2 &&
          (o?.body as { plan?: string }).plan === "a".repeat(64)
            ? "job-7"
            : "job-6",
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
            plan: "a".repeat(64),
          },
        },
      };
    // ADR 0195 point 4: an Apply whose build met a hand edit; Make it curated is offered, as on
    // Catalog builds (the hand edits as GET /api/build lists them, confirmed by its plan).
    if (path === "/api/facts/forge-edited/apply") return { jobId: "job-8" };
    if (path === "/api/jobs/job-8")
      return {
        state: "done",
        errors: [],
        result: {
          code: 1,
          lines: ["Nothing written: catalog/generated and every slot are as they were."],
          refused: {
            reasons: ["hand-edits"],
            message: "1 file under catalog/generated was changed by hand since the last build.",
            edits: [{ path: "catalog/generated/table/ledger-db.account.yaml", how: "changed" }],
            discardEdits: 1,
            command: "atticus catalog edits --curate",
            plan: "b".repeat(64),
          },
        },
      };
    if (path === "/api/build")
      return {
        pending: {
          upToDate: false,
          removals: [],
          refused: {
            reasons: ["hand-edits"],
            message: "1 file under catalog/generated was changed by hand since the last build.",
            edits: [{ path: "catalog/generated/table/ledger-db.account.yaml", how: "changed" }],
            discardEdits: 1,
            command: "atticus catalog edits --curate",
          },
          plan: "c".repeat(64),
        },
      };
    if (path === "/api/build/edits/curate") return { jobId: "job-9" };
    if (path === "/api/jobs/job-9")
      return { state: "done", errors: [], result: { code: 0, lines: ["Wrote catalog/curated/"] } };
    if (path === "/api/jobs/job-7")
      return { state: "done", errors: [], result: { code: 0, lines: ["forge-small: applied"] } };
    // Beta.28.1: an Apply that wrote with rejected facts left out (verify's exit 3).
    if (path === "/api/facts/forge-leftout/apply") return { jobId: "job-10" };
    if (path === "/api/jobs/job-10")
      return {
        state: "done",
        errors: [],
        result: {
          code: 0,
          leftOut: 2,
          lines: [
            "Applied to forge-leftout with 2 facts left out (rejected; none was in the catalog before):",
            "  left out: f-1 (no-quote): fix it in facts/forge-leftout.jsonl, reading src/A.java:3 again",
            "  left out: f-2 (no-quote): fix it in facts/forge-leftout.jsonl, reading src/B.java:9 again",
          ],
        },
      };
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
    // The review of beta.27: with the plan of the list it showed, so another list writes nothing.
    { path: "/api/facts/forge-small/apply", body: { allowRemovals: 2, plan: "a".repeat(64) } },
  ]);
  expect(all(m.tree).find((e) => e.type === RefusalView)).toBeUndefined();
  expect(text(m.tree)).toContain("forge-small: applied");
});

it("an Apply whose build met a hand edit offers Make it curated, as Catalog builds does, and Discard with the plan", async () => {
  const { RefusalView } = await import("../src/screens/setup/CatalogBuild.js");
  const m = mount(
    ApplyAndPropose as never,
    { scope: "corrections", repo: "forge-edited" } as never,
  );
  const btn = all(m.tree).find(
    (e) => e.type === "button" && text(e.props.children) === P.apply("forge-edited"),
  )!;
  calls.length = 0;
  (btn.props.onClick as () => void)();
  await vi.waitFor(() => {
    m.render();
    expect(all(m.tree).find((e) => e.type === RefusalView)).toBeDefined();
  });
  const view = all(m.tree).find((e) => e.type === RefusalView)!;
  // ADR 0195 point 4: Make it curated is the supported way, so a hand edit isn't only Discard.
  expect(view.props.onCurate).toBeTypeOf("function");
  expect(view.props.onDiscard).toBeTypeOf("function");
  await (view.props.onCurate as (n: number) => Promise<void>)(1);
  m.render();
  expect(calls.slice(2)).toEqual([
    { path: "/api/build" },
    { path: "/api/build/edits/curate", body: { count: 1, plan: "c".repeat(64) } },
    { path: "/api/jobs/job-9" },
  ]);
  // The refusal it acted on is gone, and the page says to Apply again.
  expect(all(m.tree).find((e) => e.type === RefusalView)).toBeUndefined();
  expect(text(m.tree)).toContain(P.curatedApplyAgain("forge-edited"));
});

it("Discard on an Apply's refusal sends the refusal's plan with the count", async () => {
  const { RefusalView } = await import("../src/screens/setup/CatalogBuild.js");
  const m = mount(
    ApplyAndPropose as never,
    { scope: "corrections", repo: "forge-edited" } as never,
  );
  const btn = all(m.tree).find(
    (e) => e.type === "button" && text(e.props.children) === P.apply("forge-edited"),
  )!;
  calls.length = 0;
  (btn.props.onClick as () => void)();
  await vi.waitFor(() => {
    m.render();
    expect(all(m.tree).find((e) => e.type === RefusalView)).toBeDefined();
  });
  const view = all(m.tree).find((e) => e.type === RefusalView)!;
  await (view.props.onDiscard as (n: number) => Promise<void>)(1).catch(() => undefined);
  expect(calls.filter((c) => c.path === "/api/facts/forge-edited/apply")).toEqual([
    { path: "/api/facts/forge-edited/apply", body: {} },
    { path: "/api/facts/forge-edited/apply", body: { discardEdits: 1, plan: "b".repeat(64) } },
  ]);
});

it("an Apply that left rejected facts out says it applied, and how many it left out, with their lines", async () => {
  const m = mount(ApplyAndPropose as never, { scope: "answers", repo: "forge-leftout" } as never);
  const btn = all(m.tree).find(
    (e) => e.type === "button" && text(e.props.children) === P.apply("forge-leftout"),
  )!;
  (btn.props.onClick as () => void)();
  await tick();
  await tick();
  m.render();
  // The Note is its own component: what it is given is what it says.
  const note = () =>
    all(m.tree).find((e) => (e.props as { note?: unknown } | undefined)?.note !== undefined)?.props
      .note as { ok: boolean; text: string } | undefined;
  expect(note()).toEqual({ ok: true, text: P.appliedLeftOut("forge-leftout", 2) });
  expect(text(m.tree)).toContain("left out: f-1");
  expect(P.appliedLeftOut("forge-leftout", 1)).toMatch(/1 fact left out/);
});

it("a correction's Apply that left facts out says so in its flash too", async () => {
  const m = mount(
    ApplyAndPropose as never,
    { scope: "corrections", repo: "forge-leftout" } as never,
  );
  const btn = all(m.tree).find(
    (e) => e.type === "button" && text(e.props.children) === P.apply("forge-leftout"),
  )!;
  flashed.length = 0;
  (btn.props.onClick as () => void)();
  await tick();
  await tick();
  m.render();
  expect(flashed.map((f) => f.text)).toEqual([P.appliedFlashLeftOut("forge-leftout", 2)]);
});
