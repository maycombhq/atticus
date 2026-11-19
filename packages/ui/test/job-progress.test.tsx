import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * Beta.30, slice 2 (the app): a step the app runs as a job says, in the panel that started it,
 * the step it is on (the server's own line), the time so far, that it is still running, Stop
 * where the job hears it, and a Done line that stays. Nothing here is a new route or field: the
 * step is GET /api/jobs/{id}'s `progress.message`, and Stop is POST /api/jobs/{id}/cancel. No
 * network (CLAUDE.md rule 5): the API is a stand-in.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
vi.mock("../src/app/flash.js", () => ({ flash: () => undefined }));

type Poll = Record<string, unknown>;
const calls: { path: string; method?: string }[] = [];
/** What each job answers on each look, in turn; its last answer stays. */
const jobs = new Map<string, Poll[]>();
const starts = new Map<string, string | (() => never)>();
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  // Stop is POST /api/jobs/{id}/cancel (the client's own call, stood in for here).
  stopJob: async (id: string) =>
    void calls.push({ path: `/api/jobs/${id}/cancel`, method: "POST" }),
  api: async (path: string, o?: { method?: string }) => {
    calls.push({ path, ...(o?.method ? { method: o.method } : {}) });
    const start = starts.get(path);
    if (typeof start === "function") return start();
    if (start) return { jobId: start };
    const m = /^\/api\/jobs\/([^/]+)$/.exec(path);
    if (m) {
      const polls = jobs.get(m[1]!)!;
      return polls.length > 1 ? polls.shift() : polls[0];
    }
    if (path.startsWith("/api/propose?"))
      return {
        scope: "answers",
        files: [{ path: "questions/q1.yaml", status: "??" }],
        branch: "propose/answers/2026-11-18-pat",
        title: "Answers to the map's questions",
      };
    if (path === "/api/confirmations") return { confirmation: "c".repeat(43) };
    return {};
  },
}));
const { COPY } = await import("../src/copy.js");
const { ApiError } = await import("../src/api/client.js");
const { followJob, JobFailed } = await import("../src/app/job.js");
const { JobProgress, stillAt, useJobRun } = await import("../src/app/job-progress.js");
const { ApplyAndPropose, Propose } = await import("../src/app/propose.js");
const { EditMapView } = await import("../src/screens/architecture/EditMap.js");
const { RefusalView } = await import("../src/screens/setup/CatalogBuild.js");
const { ErrorWaysOn } = await import("../src/app/ways-on.js");

const J = COPY.app.jobRun;
const W = COPY.app.jobWait;
const P = COPY.propose;
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
const tick = () => new Promise((r) => setTimeout(r, 0));
const now = () => Promise.resolve();
const running = (message: string, more: Poll = {}): Poll => ({
  state: "running",
  errors: [],
  progress: { done: 0, total: 1, message },
  ...more,
});
const done = (lines: string[] = ["ok"]): Poll => ({
  state: "done",
  errors: [],
  result: { code: 0, lines },
});
beforeEach(() => {
  calls.length = 0;
  jobs.clear();
  starts.clear();
});

describe("the time a job has run, in words", () => {
  it("says seconds, then minutes and seconds", () => {
    expect(J.time(0)).toBe("0 s");
    expect(J.time(12_400)).toBe("12 s");
    expect(J.time(60_000)).toBe("1 min");
    expect(J.time(95_000)).toBe("1 min 35 s");
  });
});

describe("a job's progress in the panel", () => {
  const what = P.applyingTo("forge-ledger");
  it("shows nothing before a job has run", () => {
    expect(html(<JobProgress what={what} run={undefined} />)).toBe("");
  });

  it("says the step now, the time so far and Stop while it runs", () => {
    const out = html(
      <JobProgress
        what={what}
        run={{
          state: "running",
          startedAt: 1_000,
          jobId: "job-1",
          step: "Checking the build's guards… (9 s in)",
        }}
        now={13_000}
        onStop={() => undefined}
      />,
    );
    expect(out).toContain(esc(what));
    expect(out).toContain('role="status"');
    expect(out).toContain('aria-busy="true"');
    // The step is the server's own line, heard as it changes.
    expect(out).toContain('aria-live="polite"');
    // The time is said once: the server's "(9 s in)" is when the step began, so the line shows
    // the step and the page's own clock says the time.
    expect(out).toContain(esc(W.now("Checking the build's guards…")));
    expect(out).not.toContain("9 s in");
    expect(out).toContain(esc(J.soFar(J.time(12_000))));
    // Not long enough yet to say it is still running.
    expect(out).not.toContain(esc(J.still(J.time(0)).slice(0, 13)));
    expect(out).toContain(`aria-label="${esc(W.stopLabel(what))}"`);
    expect(out).toContain(`>${esc(W.stop)}<`);
  });

  it("says it is still running at 30 s, 1 min, 2 min, then every 5 min: not for ever", () => {
    const at = (ms: number) =>
      html(
        <JobProgress
          what={what}
          run={{ state: "running", startedAt: 0, jobId: "job-1" }}
          now={ms}
        />,
      );
    expect(stillAt(29_000)).toBe(0);
    expect(stillAt(31_000)).toBe(30_000);
    expect(stillAt(59_000)).toBe(30_000);
    expect(stillAt(61_000)).toBe(60_000);
    expect(stillAt(119_000)).toBe(60_000);
    expect(stillAt(121_000)).toBe(120_000);
    expect(stillAt(299_000)).toBe(120_000);
    expect(stillAt(301_000)).toBe(300_000);
    expect(stillAt(14 * 60_000)).toBe(600_000);
    expect(at(29_000)).not.toContain(esc(J.still(J.time(0))));
    expect(at(95_000)).toContain(esc(J.still(J.time(60_000))));
    // The time so far is on the screen each second, outside the live line.
    expect(at(95_000)).toContain(esc(J.soFar(J.time(95_000))));
  });

  it("a Stop that came too late says so, and Stop goes: the write finishes whole", () => {
    const out = html(
      <JobProgress
        what={what}
        run={{ state: "running", startedAt: 0, jobId: "j", tooLate: true, step: "Writing…" }}
        now={5_000}
        onStop={() => undefined}
      />,
    );
    expect(out).toContain(esc(J.tooLate));
    expect(J.tooLate).toMatch(/too late/);
    expect(J.tooLate).toMatch(/finishes whole/);
    expect(out).not.toContain(`>${esc(W.stop)}<`);
    expect(out).not.toContain(`>${esc(W.stopping)}<`);
    // The keyboard has somewhere to go once the button is gone.
    expect(out).toMatch(new RegExp(`tabindex="-1"[^>]*>${esc(J.tooLate)}<`));
  });

  it("offers no Stop for a job that doesn't hear one, and says Stopping once asked", () => {
    const bare = html(
      <JobProgress what={what} run={{ state: "running", startedAt: 0, jobId: "j" }} now={5} />,
    );
    expect(bare).not.toContain(`>${esc(W.stop)}<`);
    const stopping = html(
      <JobProgress
        what={what}
        run={{ state: "running", startedAt: 0, jobId: "j", stopping: true }}
        now={5}
        onStop={() => undefined}
      />,
    );
    expect(stopping).toContain(`>${esc(W.stopping)}<`);
    expect(stopping).toContain("disabled");
  });

  it("keeps a line that says how it ended, with the time it took", () => {
    const ended = (state: "done" | "failed" | "stopped") =>
      html(
        <JobProgress
          what={what}
          run={{ state, startedAt: 1_000, endedAt: 43_000, jobId: "job-1" }}
          now={999_000}
          onStop={() => undefined}
        />,
      );
    const ok = ended("done");
    expect(ok).toContain(esc(J.done(J.time(42_000))));
    expect(ok).toContain('role="status"');
    // The Stop it replaced is gone: the line takes the keyboard when nothing else has it.
    expect(ok).toContain('tabindex="-1"');
    expect(ok).not.toContain('aria-busy="true"');
    expect(ok).not.toContain(`>${esc(W.stop)}<`);
    expect(ended("failed")).toContain(esc(J.ended(J.time(42_000))));
    expect(ended("stopped")).toContain(esc(J.stopped(J.time(42_000))));
  });
});

describe("following a job from a panel", () => {
  it("a job a person stopped fails as stopped", async () => {
    starts.set("/api/x", "job-s");
    jobs.set("job-s", [{ state: "cancelled", errors: [], progress: { message: "Stopped." } }]);
    const e = await followJob("/api/x", {}, now).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(JobFailed);
    expect((e as InstanceType<typeof JobFailed>).stopped).toBe(true);
    starts.set("/api/y", "job-f");
    jobs.set("job-f", [{ state: "failed", errors: ["no"], result: { code: 1, lines: [] } }]);
    const f = await followJob("/api/y", {}, now).catch((x: unknown) => x);
    expect((f as InstanceType<typeof JobFailed>).stopped).toBe(false);
  });

  /** A probe of the hook over polls a test lets through one at a time. */
  const probe = (polls: Poll[]) => {
    starts.set("/api/x", "job-1");
    jobs.set("job-1", polls);
    const waits: (() => void)[] = [];
    const wait = () => new Promise<void>((r) => void waits.push(r));
    const clock = { t: 1_000 };
    const Probe = () => useJobRun({ clock: () => clock.t, wait });
    const m = mount(Probe as never, {} as never);
    const hook = () => m.tree as ReturnType<typeof useJobRun>;
    const next = async () => {
      waits.shift()?.();
      await tick();
      m.render();
    };
    return { m, hook, next, clock };
  };

  it("holds the step, the start and the end, and Stop asks the server", async () => {
    const { m, hook, next, clock } = probe([
      running("Applying to forge-ledger"),
      running("Reading the build's inputs… (3 s in)"),
      running("Stopping…", { stopping: true }),
      { state: "cancelled", errors: [] },
    ]);
    expect(hook().run).toBeUndefined();
    const ended = hook()
      .follow("/api/x", {})
      .catch((e: unknown) => e);
    await tick();
    m.render();
    expect(hook().run).toEqual({
      state: "running",
      startedAt: 1_000,
      jobId: "job-1",
      step: "Applying to forge-ledger",
    });
    await next();
    expect(hook().run?.step).toBe("Reading the build's inputs… (3 s in)");
    // Stop: asked of the server, and said at once.
    hook().stop!();
    await tick();
    m.render();
    expect(hook().run?.stopping).toBe(true);
    expect(calls).toContainEqual({ path: "/api/jobs/job-1/cancel", method: "POST" });
    // The job says it is stopping: so it is, until it ends.
    await next();
    expect(hook().run).toMatchObject({ stopping: true, step: "Stopping…" });
    expect(hook().run?.tooLate).toBeUndefined();
    clock.t = 9_000;
    await next();
    await ended;
    m.render();
    expect(hook().run).toMatchObject({ state: "stopped", startedAt: 1_000, endedAt: 9_000 });
    expect(hook().run?.stopping).toBeUndefined();
    expect(hook().stop).toBeUndefined();
  });

  it("a Stop the job didn't take (its write had started) is said too late, never Stopping… to the end", async () => {
    // Past its commit point the server answers the Stop and carries on: the job never says
    // `stopping`. Two looks after the Stop was heard, the page says it came too late.
    const writing = running("Writing the catalog (1,204 record files)… (41 s in)");
    const { m, hook, next } = probe([writing, writing, writing, writing, done()]);
    const ended = hook().follow("/api/x", {});
    await tick();
    m.render();
    hook().stop!();
    await tick();
    m.render();
    expect(hook().run?.stopping).toBe(true);
    // The look that may have been on its way when Stop was asked decides nothing.
    await next();
    expect(hook().run?.stopping).toBe(true);
    await next();
    expect(hook().run?.stopping).toBeUndefined();
    expect(hook().run?.tooLate).toBe(true);
    // No Stop is offered again: it would only be too late again.
    expect(hook().stop).toBeUndefined();
    await next();
    await next();
    await ended;
    m.render();
    expect(hook().run).toMatchObject({ state: "done" });
    expect(hook().run?.tooLate).toBeUndefined();
  });

  it("a second step asked while one runs doesn't take the first one's progress or Stop", async () => {
    const { m, hook, next } = probe([running("Reading the build's inputs… (3 s in)"), done()]);
    const first = hook().follow("/api/x", {});
    await tick();
    m.render();
    starts.set("/api/y", () => {
      throw new ApiError({ type: "about:blank", title: "Conflict", status: 409, detail: "Busy." });
    });
    await hook()
      .follow("/api/y", {})
      .catch(() => undefined);
    m.render();
    expect(hook().run).toMatchObject({ state: "running", jobId: "job-1" });
    expect(typeof hook().stop).toBe("function");
    await next();
    await first;
  });

  it("a job the server never started leaves no line behind", async () => {
    starts.set("/api/x", () => {
      throw new ApiError({ type: "about:blank", title: "Conflict", status: 409, detail: "Busy." });
    });
    const Probe = () => useJobRun({ wait: now });
    const m = mount(Probe as never, {} as never);
    const hook = () => m.tree as ReturnType<typeof useJobRun>;
    await hook()
      .follow("/api/x", {})
      .catch(() => undefined);
    m.render();
    expect(hook().run).toBeUndefined();
  });
});

describe("one repo's Apply", () => {
  const progressOf = (tree: unknown) => all(tree).find((e) => e.type === JobProgress)!;
  it("shows its step and Stop while it runs, and a Done line that stays", async () => {
    starts.set("/api/facts/forge-ledger/apply", "job-1");
    jobs.set("job-1", [running("Checking the build's guards… (41 s in)")]);
    const m = mount(
      ApplyAndPropose as never,
      { scope: "answers", repo: "forge-ledger", noPropose: true } as never,
    );
    const btn = all(m.tree).find(
      (e) => e.type === "button" && text(e.props.children) === P.apply("forge-ledger"),
    )!;
    (btn.props.onClick as () => void)();
    await tick();
    m.render();
    const p = progressOf(m.tree).props as Parameters<typeof JobProgress>[0];
    expect(p.what).toBe(P.applyingTo("forge-ledger"));
    expect(p.run).toMatchObject({
      state: "running",
      jobId: "job-1",
      step: "Checking the build's guards… (41 s in)",
    });
    // Apply hears Stop until the catalog's write starts.
    expect(typeof p.onStop).toBe("function");
    jobs.set("job-1", [done(["forge-ledger: 12 facts kept"])]);
    await vi.waitFor(
      () => {
        m.render();
        expect(text(m.tree)).toContain("forge-ledger: 12 facts kept");
      },
      { timeout: 20_000 },
    );
    expect((progressOf(m.tree).props as Parameters<typeof JobProgress>[0]).run?.state).toBe("done");
  });

  it("an Apply a person stopped says the catalog wasn't written, not that verify found problems", async () => {
    starts.set("/api/facts/forge-ledger/apply", "job-2");
    jobs.set("job-2", [{ state: "cancelled", errors: [], result: { lines: ["Stopped."] } }]);
    const m = mount(
      ApplyAndPropose as never,
      { scope: "answers", repo: "forge-ledger", noPropose: true } as never,
    );
    const btn = all(m.tree).find(
      (e) => e.type === "button" && text(e.props.children) === P.apply("forge-ledger"),
    )!;
    (btn.props.onClick as () => void)();
    await tick();
    await tick();
    m.render();
    const note = all(m.tree).find(
      (e) => (e.props.note as { text?: string } | undefined)?.text !== undefined,
    )!;
    // What the person asked for is a status, not an alert.
    expect(note.props.note).toEqual({ ok: true, text: P.applyStopped("forge-ledger") });
    expect((progressOf(m.tree).props as Parameters<typeof JobProgress>[0]).run?.state).toBe(
      "stopped",
    );
  });
});

describe("an Apply that failed", () => {
  it("offers Undo the last build and the support bundle's command under its problems", async () => {
    starts.set("/api/facts/forge-ledger/apply", "job-3");
    jobs.set("job-3", [
      { state: "failed", errors: ["The catalog's write failed."], result: { code: 1, lines: [] } },
    ]);
    const m = mount(
      ApplyAndPropose as never,
      { scope: "answers", repo: "forge-ledger", noPropose: true } as never,
    );
    expect(all(m.tree).some((e) => e.type === ErrorWaysOn)).toBe(false);
    const btn = all(m.tree).find(
      (e) => e.type === "button" && text(e.props.children) === P.apply("forge-ledger"),
    )!;
    (btn.props.onClick as () => void)();
    await tick();
    await tick();
    m.render();
    expect(text(m.tree)).toContain("The catalog's write failed.");
    expect(all(m.tree).some((e) => e.type === ErrorWaysOn)).toBe(true);
  });
});

describe("the other waits that follow a job", () => {
  it.each([
    ["says it is stoppable", { stoppable: true, stopLands: "now" }, "function"],
    ["is an older one, which says nothing (it would push anyway)", {}, "undefined"],
  ])(
    "Propose for review says its time and that it is running; Stop when the server %s",
    async (_w, says, stop) => {
      starts.set("/api/propose", "job-p");
      jobs.set("job-p", [running("Proposing for review", says)]);
      const m = mount(Propose as never, { scope: "answers" } as never);
      const btn = (label: string) =>
        all(m.tree).find((e) => e.type === "button" && text(e.props.children) === label)!;
      (btn(P.propose).props.onClick as () => void)();
      await tick();
      m.render();
      (btn(P.yes(1)).props.onClick as () => void)();
      await tick();
      await tick();
      m.render();
      const p = all(m.tree).find((e) => e.type === JobProgress)!.props as Parameters<
        typeof JobProgress
      >[0];
      expect(p.what).toBe(P.proposingSay);
      // ADR 0202 point 2: Stop only while the job itself says it is stoppable (until its push).
      expect(typeof p.onStop).toBe(stop);
    },
  );

  it("Edit the map's Apply shows the job's step where it said only that it was saving", () => {
    const out = html(
      <EditMapView
        staged={[]}
        apply={{ state: "working" }}
        run={{
          state: "running",
          startedAt: 0,
          jobId: "job-9",
          step: "Building the catalog: pass 2 of 5 (the joins)… (18 s in)",
        }}
        onStop={() => undefined}
        onRemove={() => undefined}
        onApply={() => undefined}
        onBack={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    expect(out).toContain(esc(COPY.editMap.working));
    expect(out).toContain(esc(W.now("Building the catalog: pass 2 of 5 (the joins)…")));
    expect(out).toContain(`aria-label="${esc(W.stopLabel(COPY.editMap.working))}"`);
  });

  it("Keep my edits (make them curated) hands the job's step to the refusal that started it", async () => {
    const seen: unknown[] = [];
    const m = mount(
      RefusalView as never,
      {
        refused: {
          reasons: ["hand-edits"],
          message: "Nothing written.",
          edits: [{ path: "catalog/generated/table/ledger-db.account.yaml", how: "changed" }],
          discardEdits: 1,
          command: "atticus catalog edits --curate",
        },
        onAllowRemovals: async () => undefined,
        onCurate: async (_n: number, on?: { onProgress?: (p: unknown) => void }) => {
          seen.push(on);
          on?.onProgress?.({ done: 0, total: 1, message: "Checking the build's guards… (4 s in)" });
          await new Promise(() => undefined);
        },
      } as never,
    );
    const keep = all(m.tree).find(
      (e) => e.type === "button" && text(e.props.children) === COPY.catalogBuild.curate(1),
    )!;
    (keep.props.onClick as () => void)();
    await tick();
    m.render();
    expect(seen).toHaveLength(1);
    const p = all(m.tree).find((e) => e.type === JobProgress)!.props as Parameters<
      typeof JobProgress
    >[0];
    expect(p.what).toBe(COPY.catalogBuild.curating);
    expect(p.run).toMatchObject({
      state: "running",
      step: "Checking the build's guards… (4 s in)",
    });
  });
});
