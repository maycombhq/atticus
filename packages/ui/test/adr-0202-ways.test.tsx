import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { all, mount } from "./support/hooks.js";

/**
 * ADR 0202 points 1 to 6, the app's half: Save a support bundle, Stop only while it can take
 * effect, Undo in one click from an error, one repo's rejected facts, a running job found again
 * after a reload, and why a task isn't ready. Each new state is rendered (empty, loading,
 * error), and each works against a server that lacks the new fields and routes (an older
 * command line): Stop while running, the link to the Undo panel, the command to copy. No
 * network (CLAUDE.md rule 5): the API is a stand-in.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
vi.mock("../src/app/flash.js", () => ({ flash: () => undefined }));

type Answer = unknown | (() => unknown);
const calls: { path: string; method?: string; body?: unknown }[] = [];
/** What each path answers, in turn (its last answer stays); a function may throw. */
const answers = new Map<string, Answer[]>();
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  stopJob: async (id: string) =>
    void calls.push({ path: `/api/jobs/${id}/cancel`, method: "POST" }),
  api: async (path: string, o?: { method?: string; body?: unknown }) => {
    calls.push({
      path,
      ...(o?.method ? { method: o.method } : {}),
      ...(o?.body !== undefined ? { body: o.body } : {}),
    });
    const key = o?.method && o.method !== "GET" ? `${o.method} ${path}` : path;
    const list = answers.get(key);
    if (!list) throw new ApiError({ type: "x", title: "Not found", status: 404 });
    const a = list.length > 1 ? list.shift() : list[0];
    return typeof a === "function" ? (a as () => unknown)() : a;
  },
}));
const { COPY } = await import("../src/copy.js");
const { ApiError } = await import("../src/api/client.js");
const { JobFailed, undoAfter, undoWayOf } = await import("../src/app/job.js");
const { cantStopNow, foundRun, FOUND_FOR_MS, JobFoundView, JobProgress, useJobFound, useJobRun } =
  await import("../src/app/job-progress.js");
const { ErrorWaysOn, saveBundle, SupportBundleView, UNDO_HREF, UndoHere, UndoHereView, undoWords } =
  await import("../src/app/ways-on.js");
const { LeftOutWay, rejectedHref } = await import("../src/app/propose.js");
const { rejectedAsked, rejectedPath, RejectedFacts } = await import("../src/screens/map/Trust.js");
const { taskNotReadyWords, taskWaitsWords } = await import("../src/screens/know/Phase.js");

const W = COPY.waysOn;
const J = COPY.app.jobRun;
const JW = COPY.app.jobWait;
const T = COPY.trust;
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (m: { render(): void }) => {
  for (let n = 0; n < 6; n++) await tick();
  m.render();
};
beforeEach(() => {
  calls.length = 0;
  answers.clear();
});

const BUNDLE = {
  file: ".atticus/logs/atticus-support-20261118-100000.zip",
  name: "atticus-support-20261118-100000.zip",
  bytes: 2048,
  files: ["README.txt", "about.json", "counts.json"],
  zip: "UEsDBA==",
};
const WAY = {
  n: 1,
  files: 2,
  plan: "a".repeat(64),
  command: "atticus verify forge-ledger --write",
  at: "2026-11-18T10:00:00.000Z",
  ofThis: false,
};

describe("Save a support bundle (point 1)", () => {
  const noop = () => undefined;
  it("before: the button, and the command below it for a terminal", () => {
    const out = html(<SupportBundleView at={{ state: "idle" }} onSave={noop} />);
    expect(out).toContain(`<button type="button" class="btn">${esc(W.saveBundle)}</button>`);
    expect(out).toContain(esc(W.supportWhy));
    expect(out).toContain(esc(W.bundleTerminal));
    expect(out).toContain(`<code class="mono">${esc(W.supportCommand)}</code>`);
    // In a panel: without the sentence.
    expect(html(<SupportBundleView short at={{ state: "idle" }} onSave={noop} />)).not.toContain(
      esc(W.supportWhy),
    );
  });

  it("while it saves: the button says so and is busy", () => {
    const out = html(<SupportBundleView at={{ state: "saving" }} onSave={noop} />);
    expect(out).toContain('disabled="" aria-busy="true"');
    expect(out).toContain(esc(W.savingBundle));
  });

  it("saved: where it is, that nothing was sent, to read every file, Save a copy… and Copy the path", () => {
    const out = html(
      <SupportBundleView at={{ state: "saved", bundle: BUNDLE }} onSave={noop} canCopy />,
    );
    expect(W.bundleSaved(BUNDLE.file, 3)).toBe(
      "Saved .atticus/logs/atticus-support-20261118-100000.zip (3 files). Nothing was sent anywhere. Read every file before you send it outside your organisation.",
    );
    expect(out).toContain(`role="status"`);
    expect(out).toContain(esc(W.bundleSaved(BUNDLE.file, 3)));
    for (const f of BUNDLE.files) expect(out).toContain(`<li>${f}</li>`);
    expect(out).toContain(`aria-label="${esc(W.saveCopyLabel(BUNDLE.name))}"`);
    expect(out).toContain(`>${esc(W.saveCopy)}<`);
    expect(out).toContain(`aria-label="${esc(W.copyPathLabel(BUNDLE.file))}"`);
    expect(out).toContain(`<code class="mono">${esc(W.supportCommand)}</code>`);
    // Where the page can't hand over a file (an editor's panel), or the zip was too big to
    // send back: the path is there, and no Save a copy.
    const noCopy = html(
      <SupportBundleView at={{ state: "saved", bundle: BUNDLE }} onSave={noop} />,
    );
    expect(noCopy).not.toContain(esc(W.saveCopy));
    const { zip: _z, ...big } = BUNDLE;
    const tooBig = html(
      <SupportBundleView at={{ state: "saved", bundle: big }} onSave={noop} canCopy />,
    );
    expect(tooBig).not.toContain(esc(W.saveCopy));
    expect(tooBig).toContain(esc(W.copyPath));
  });

  it("an error: said as one, with the command to fall back on; the button is there to try again", () => {
    const out = html(
      <SupportBundleView at={{ state: "failed", why: "The disk is full." }} onSave={noop} />,
    );
    expect(out).toContain('role="alert"');
    expect(out).toContain(esc(W.bundleFailed("The disk is full.")));
    expect(out).toContain(`>${esc(W.saveBundle)}<`);
    expect(out).toContain(`<code class="mono">${esc(W.supportCommand)}</code>`);
  });

  it("an older server (no such route): the command to copy, as before, and no button", async () => {
    expect(await saveBundle()).toEqual({ state: "older" });
    expect(calls).toEqual([{ path: "/api/support/bundle", method: "POST" }]);
    const out = html(<SupportBundleView at={{ state: "older" }} onSave={noop} />);
    expect(out).not.toContain(`>${esc(W.saveBundle)}<`);
    expect(out).toContain(esc(W.bundleOlder));
    expect(out).toContain(`aria-label="${esc(W.copySupportLabel(W.supportCommand))}"`);
  });

  it("asks the server with no body, and keeps what it answers or why it failed", async () => {
    answers.set("POST /api/support/bundle", [BUNDLE]);
    expect(await saveBundle()).toEqual({ state: "saved", bundle: BUNDLE });
    expect(calls.at(-1)).toEqual({ path: "/api/support/bundle", method: "POST" });
    answers.set("POST /api/support/bundle", [
      () => {
        throw new ApiError({
          type: "x",
          title: "Failed",
          status: 500,
          detail: "The disk is full.",
        });
      },
    ]);
    expect(await saveBundle()).toEqual({ state: "failed", why: "The disk is full." });
  });
});

describe("Stop only while it can take effect (point 2)", () => {
  const run = (more: object) => ({
    state: "running" as const,
    startedAt: 0,
    jobId: "job-1",
    step: "Writing the catalog…",
    ...more,
  });
  const stopBtn = (what: string) => `aria-label="${esc(JW.stopLabel(what))}"`;

  it("shows Stop while the job says it is stoppable", () => {
    const out = html(
      <JobProgress
        what="Applying to forge-ledger…"
        run={run({ stoppable: true, stopLands: "now" })}
        onStop={() => undefined}
        now={5_000}
      />,
    );
    expect(out).toContain(stopBtn("Applying to forge-ledger…"));
    expect(out).toContain(`>${esc(JW.stop)}</button>`);
    expect(out).not.toContain(esc(J.tooLateNow));
  });

  it("a job of several inside a write: Stop after this repo", () => {
    const out = html(
      <JobProgress
        what="Applying to 7 repos…"
        run={run({ stoppable: true, stopLands: "after-write" })}
        onStop={() => undefined}
        now={5_000}
      />,
    );
    expect(out).toContain(`>${esc(JW.stopAfterRepo)}</button>`);
    expect(out).toContain(`aria-label="${esc(JW.stopAfterRepoLabel("Applying to 7 repos…"))}"`);
  });

  it("once it turns false while the job runs: no Stop, and it says it is too late", () => {
    expect(J.tooLateNow).toBe("Too late to stop: the write has started and finishes whole.");
    const r = run({ stoppable: false });
    expect(cantStopNow(r)).toBe(true);
    const out = html(<JobProgress what="Applying…" run={r} onStop={() => undefined} now={5_000} />);
    expect(out).not.toContain("<button");
    expect(out).toContain(`role="status"`);
    expect(out).toContain(esc(J.tooLateNow));
    // Stopping is not too late: the Stop was taken.
    expect(cantStopNow(run({ stoppable: false, stopping: true }))).toBe(false);
  });

  it("an older server (no stoppable): Stop while it runs, as before", () => {
    const out = html(
      <JobProgress what="Applying…" run={run({})} onStop={() => undefined} now={5_000} />,
    );
    expect(out).toContain(stopBtn("Applying…"));
    expect(out).not.toContain(esc(J.tooLateNow));
  });

  it("the panel's hold on its job offers no Stop once the job says it can't take one", async () => {
    answers.set("POST /api/x", [{ jobId: "job-1" }]);
    const at = (message: string, more: object) => ({
      state: "running",
      errors: [],
      progress: { done: 0, total: 1, message },
      ...more,
    });
    answers.set("/api/jobs/job-1", [
      at("Committing 1 file to propose/answers/x…", { stoppable: true, stopLands: "now" }),
      at("Pushing propose/answers/x…", { stoppable: false }),
      { state: "done", errors: [], stoppable: false, result: { code: 0, lines: ["ok"] } },
    ]);
    let steps: (() => void)[] = [];
    const wait = () => new Promise<void>((r) => steps.push(r));
    let hook!: ReturnType<typeof useJobRun>;
    const m = mount(() => {
      hook = useJobRun({ clock: () => 1_000, wait });
      return null;
    }, {});
    const next = async () => {
      const go = steps;
      steps = [];
      for (const g of go) g();
      await settle(m);
    };
    const ended = hook.follow("/api/x", {});
    await settle(m);
    expect(hook.run).toMatchObject({ stoppable: true, stopLands: "now" });
    expect(typeof hook.stop).toBe("function");
    await next();
    expect(hook.run).toMatchObject({ step: "Pushing propose/answers/x…", stoppable: false });
    expect(hook.run?.stopLands).toBeUndefined();
    expect(hook.stop).toBeUndefined();
    await next();
    await ended;
    m.render();
    expect(hook.run?.state).toBe("done");
  });
});

describe("Undo from an error, in one click (point 3)", () => {
  it("reads the way from a failed job's result and from a 409's problem; nothing else is one", () => {
    expect(undoWayOf({ undo: WAY })).toEqual(WAY);
    expect(undoWayOf({ undo: { ...WAY, plan: 3 } })).toBeUndefined();
    expect(undoWayOf({})).toBeUndefined();
    const failed = new JobFailed("x", ["x"], undefined, 1, { undo: WAY }, false, true);
    expect(undoAfter(failed)).toEqual({ undo: WAY, known: true });
    // A 3.19 server's job with no build to take back: known, and none.
    expect(undoAfter(new JobFailed("x", ["x"], undefined, 1, {}, false, true))).toEqual({
      known: true,
    });
    // An older server's job: not known, so the link to the Undo panel stays.
    expect(undoAfter(new JobFailed("x", ["x"], undefined, 1, {}))).toEqual({ known: false });
    const conflict = new ApiError({
      type: "x",
      title: "Conflict",
      status: 409,
      undo: WAY,
    } as never);
    expect(undoAfter(conflict)).toEqual({ undo: WAY, known: true });
    expect(undoAfter(new Error("x"))).toEqual({ known: false });
  });

  it("names which build it undoes", () => {
    expect(undoWords({ ...WAY, ofThis: true })).toBe("Undo this build");
    expect(undoWords(WAY)).toBe(
      "Undo the last build (atticus verify forge-ledger --write, 2026-11-18 10:00:00 UTC)",
    );
  });

  it("the error offers the button where the server says which build; none where it says there is none; the link where it can't say", () => {
    const withWay = html(<ErrorWaysOn short undo={WAY} undoKnown />);
    expect(withWay).toContain(`>${esc(undoWords(WAY))}</button>`);
    expect(withWay).not.toContain(`href="${UNDO_HREF}"`);
    const none = html(<ErrorWaysOn short undoKnown />);
    expect(none).not.toContain(esc(W.undoLast));
    expect(none).not.toContain(`href="${UNDO_HREF}"`);
    expect(none).toContain(`>${esc(W.saveBundle)}<`);
    // An older server, or an error that is no job's (a screen that couldn't be shown).
    const link = html(<ErrorWaysOn short />);
    expect(link).toContain(`href="${UNDO_HREF}"`);
    expect(link).toContain(`>${esc(W.undoLast)}<`);
  });

  it("each state of the confirm: listing, asking with the files, undoing, undone, failed", () => {
    const view = (at: Parameters<typeof UndoHereView>[0]["at"]) =>
      html(
        <UndoHereView
          undo={WAY}
          at={at}
          onOpen={() => undefined}
          onUndo={() => undefined}
          onBack={() => undefined}
        />,
      );
    expect(view({ state: "listing" })).toContain(`disabled="" aria-busy="true"`);
    expect(view({ state: "listing" })).toContain(esc(W.undoListing));
    const asking = view({
      state: "asking",
      files: [
        { path: "catalog/generated/table/ledger.yaml", to: "file" },
        { path: "catalog/generated/table/new.yaml", to: "absent" },
      ],
    });
    expect(asking).toContain(`role="group" aria-label="${esc(undoWords(WAY))}"`);
    expect(asking).toContain(esc(W.undoPutsBack(2)));
    expect(asking).toContain("restore catalog/generated/table/ledger.yaml");
    expect(asking).toContain("remove catalog/generated/table/new.yaml");
    expect(asking).toContain(`tabindex="-1">${esc(W.undoAsk)}</p>`);
    expect(asking).toContain(
      `<button type="button" class="btn primary">${esc(W.undoYes)}</button>`,
    );
    expect(asking).toContain(`>${esc(W.undoBack)}</button>`);
    expect(view({ state: "asking", files: [] })).toContain(esc(W.undoPutsBack(0)));
    expect(view({ state: "undoing" })).toContain(esc(W.undoing));
    const undone = view({ state: "undone" });
    expect(undone).toContain(`role="status"`);
    expect(undone).toContain(esc(W.undone));
    expect(undone).not.toContain("<button");
    const failed = view({ state: "failed", why: "the list changed" });
    expect(failed).toContain(`role="alert"`);
    expect(failed).toContain(esc(W.undoFailed("the list changed")));
  });

  it("one click lists the files; nothing is undone without the confirm; Undo sends the error's three values", async () => {
    answers.set("/api/build/undo?n=1", [
      {
        copies: [],
        plan: { n: 1, files: [{ path: "catalog/generated/table/ledger.yaml", to: "file" }] },
      },
    ]);
    answers.set("POST /api/build/undo", [{ jobId: "job-u" }]);
    answers.set("/api/jobs/job-u", [{ state: "done", errors: [], result: { code: 0, lines: [] } }]);
    let done = 0;
    const m = mount(UndoHere as never, { undo: WAY, onDone: () => done++ } as never);
    const view = () =>
      all(m.tree).find((e) => e.type === UndoHereView)!.props as Parameters<typeof UndoHereView>[0];
    expect(view().at).toEqual({ state: "idle" });
    view().onOpen();
    await settle(m);
    expect(view().at).toEqual({
      state: "asking",
      files: [{ path: "catalog/generated/table/ledger.yaml", to: "file" }],
    });
    // Listed, and nothing sent yet.
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    view().onBack();
    m.render();
    expect(view().at).toEqual({ state: "idle" });
    view().onOpen();
    await settle(m);
    view().onUndo();
    await settle(m);
    expect(calls).toContainEqual({
      path: "/api/build/undo",
      method: "POST",
      body: { n: 1, files: 2, plan: "a".repeat(64) },
    });
    expect(view().at).toEqual({ state: "undone" });
    expect(done).toBe(1);
  });

  it("a list that changed meanwhile is refused, and said", async () => {
    answers.set("/api/build/undo?n=1", [{ copies: [], plan: { n: 1, files: [] } }]);
    answers.set("POST /api/build/undo", [
      () => {
        throw new ApiError({
          type: "x",
          title: "Conflict",
          status: 409,
          detail: "Nothing was undone: look at the list again.",
        });
      },
    ]);
    const m = mount(UndoHere as never, { undo: WAY } as never);
    const view = () =>
      all(m.tree).find((e) => e.type === UndoHereView)!.props as Parameters<typeof UndoHereView>[0];
    view().onOpen();
    await settle(m);
    view().onUndo();
    await settle(m);
    expect(view().at).toEqual({
      state: "failed",
      why: "Nothing was undone: look at the list again.",
    });
  });
});

describe("one repo's rejected facts (point 4)", () => {
  const row = (rejected: object[]) =>
    ({
      factsDir: "facts",
      problems: [],
      repos: [
        { repo: "forge-ledger", lists: { rejected, excluded: [], asked: [], unverified: [] } },
      ],
    }) as never;

  it("the refusal's link goes to the repo's rejected facts", () => {
    expect(rejectedHref("forge-ledger")).toBe("#/trust?repo=forge-ledger&rejected=1");
    expect(rejectedAsked("#/trust?repo=forge-ledger&rejected=1")).toBe("forge-ledger");
    expect(rejectedAsked("#/trust?repo=forge-ledger")).toBeUndefined();
    expect(rejectedAsked("#/trust?rejected=1")).toBeUndefined();
    expect(rejectedPath("forge-ledger")).toBe("/api/trust?repo=forge-ledger&rejected=1");
    const way = html(<LeftOutWay repo="forge-ledger" n={3} />);
    expect(way).toContain('href="#/trust?repo=forge-ledger&amp;rejected=1"');
    expect(way).toContain(esc(W.rejectedOnTrust(3)));
  });

  it("lists each under its heading, with its place, code, reason and Drop", () => {
    const out = html(
      <RejectedFacts
        repo="forge-ledger"
        of={{
          state: "ready",
          data: row([
            {
              fact: "e-post-entry",
              file: "src/main/java/forge/ledger/EntryController.java",
              line: 22,
              code: "claim-not-on-line",
              message: "line 22 doesn't say /entries",
            },
            { code: "bad-question", message: "no options" },
          ]),
        }}
      />,
    );
    expect(T.rejectedTitle(2, "forge-ledger")).toBe("2 rejected facts in forge-ledger");
    expect(out).toContain(`tabindex="-1">2 rejected facts in forge-ledger</h2>`);
    expect(out).toContain("src/main/java/forge/ledger/EntryController.java:22");
    expect(out).toContain(esc(T.rejectedLine("claim-not-on-line", "line 22 doesn't say /entries")));
    expect(out).toContain(esc(T.dropFact));
    expect(out).toContain(esc(T.rejectedNoLine));
    expect(out).toContain(`<a href="#/trust">${esc(T.rejectedAll)}</a>`);
  });

  it("empty, loading and error states", () => {
    const empty = html(
      <RejectedFacts repo="forge-ledger" of={{ state: "ready", data: row([]) }} />,
    );
    expect(T.rejectedNone("forge-ledger")).toBe("No fact of forge-ledger is rejected now.");
    expect(empty).toContain(esc(T.rejectedNone("forge-ledger")));
    const loading = html(<RejectedFacts repo="forge-ledger" of={{ state: "loading" }} />);
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain(esc(T.rejectedLoading("forge-ledger")));
    const error = html(
      <RejectedFacts
        repo="forge-nowhere"
        of={{ state: "error", error: "There is no repo forge-nowhere on Map › Trust." }}
      />,
    );
    expect(error).toContain('role="alert"');
    expect(error).toContain("There is no repo forge-nowhere");
    expect(error).not.toContain("0 rejected facts");
  });

  it("an older server answers every repo: the repo's row is read from it all the same", () => {
    const all = {
      factsDir: "facts",
      problems: [],
      repos: [
        { repo: "forge-events", lists: { rejected: [{ code: "x", message: "other" }] } },
        { repo: "forge-ledger", lists: { rejected: [{ code: "y", message: "mine" }] } },
      ],
    } as never;
    const out = html(<RejectedFacts repo="forge-ledger" of={{ state: "ready", data: all }} />);
    expect(out).toContain("1 rejected fact in forge-ledger");
    expect(out).toContain("y: mine");
    expect(out).not.toContain("x: other");
  });
});

describe("a running job found again (point 5)", () => {
  const T0 = Date.parse("2026-11-18T10:00:00.000Z");
  const job = (more: object) => ({
    id: "job-7",
    state: "running",
    startedAt: "2026-11-18T10:00:00.000Z",
    progress: { done: 0, total: 1, message: "Reading the build's inputs… (12 s in)" },
    stoppable: true,
    stopLands: "now",
    ...more,
  });
  const probe = (action: string, repo: string | undefined, now: { t: number }, skip = false) => {
    let steps: (() => void)[] = [];
    const wait = () => new Promise<void>((r) => steps.push(r));
    let hook!: ReturnType<typeof useJobFound>;
    let ended = 0;
    const m = mount(() => {
      hook = useJobFound(action, repo, {
        clock: () => now.t,
        wait,
        skip,
        onEnd: () => ended++,
      });
      return null;
    }, {});
    const next = async () => {
      const go = steps;
      steps = [];
      for (const g of go) g();
      await settle(m);
    };
    return { m, hook: () => hook, next, ended: () => ended };
  };

  it("asks for its own action and repo; a running job is shown with its message, the server's start, Stop and its lines, to its end", async () => {
    const q = "/api/jobs?action=apply&repo=forge-ledger";
    answers.set(q, [{ jobs: [job({})] }]);
    answers.set("/api/jobs/job-7", [
      job({ progress: { done: 0, total: 1, message: "Writing the catalog…" }, stoppable: false }),
      {
        ...job({}),
        state: "done",
        finishedAt: "2026-11-18T10:01:30.000Z",
        stoppable: false,
        result: { code: 0, lines: [] },
      },
    ]);
    answers.set("/api/activity/job-7/lines", [
      { lines: ["Reading forge-ledger…", "Verifying 40 facts…"] },
      { lines: ["Verifying 40 facts…", "Writing the catalog…"] },
      { lines: ["Writing the catalog…", "Done."] },
    ]);
    const now = { t: T0 + 20_000 };
    const p = probe("apply", "forge-ledger", now);
    await settle(p.m);
    expect(calls[0]).toEqual({ path: q });
    expect(p.hook().found).toEqual({
      run: {
        state: "running",
        startedAt: T0,
        jobId: "job-7",
        step: "Reading the build's inputs… (12 s in)",
        stoppable: true,
        stopLands: "now",
      },
      lines: ["Reading forge-ledger…", "Verifying 40 facts…"],
    });
    // The time so far is from the server's start, not from when this page was loaded.
    const shown = html(
      <JobFoundView
        what="Applying to forge-ledger…"
        found={p.hook().found}
        onStop={p.hook().stop}
        now={now.t}
      />,
    );
    expect(shown).toContain(esc(J.found));
    expect(shown).toContain(esc(J.soFar(J.time(20_000))));
    expect(shown).toContain(`aria-label="${esc(JW.stopLabel("Applying to forge-ledger…"))}"`);
    expect(shown).toContain(`aria-label="${esc(J.linesLabel("Applying to forge-ledger…"))}"`);
    expect(shown).toContain("Verifying 40 facts…");
    // Stop asks the server, and is said at once.
    p.hook().stop!();
    await settle(p.m);
    expect(calls).toContainEqual({ path: "/api/jobs/job-7/cancel", method: "POST" });
    expect(p.hook().found!.run.stopping).toBe(true);
    expect(p.hook().stop).toBeUndefined();
    // The write had started: the job says a Stop can't take effect, and so says the panel.
    await p.next();
    expect(p.hook().found!.run).toMatchObject({ step: "Writing the catalog…", stoppable: false });
    expect(cantStopNow(p.hook().found!.run)).toBe(true);
    now.t = T0 + 90_000;
    await p.next();
    expect(p.hook().found!.run).toEqual({
      state: "done",
      startedAt: T0,
      endedAt: T0 + 90_000,
      jobId: "job-7",
    });
    expect(p.ended()).toBe(1);
    const done = html(<JobFoundView what="Applying…" found={p.hook().found} />);
    expect(done).toContain(esc(J.done(J.time(90_000))));
  });

  it("with none running, the newest finished within ten minutes shows how it ended and its ways on", async () => {
    const failed = {
      ...job({}),
      state: "failed",
      finishedAt: "2026-11-18T10:00:40.000Z",
      stoppable: false,
      result: { code: 1, lines: ["The write failed."], undo: WAY },
    };
    answers.set("/api/jobs?action=build", [{ jobs: [failed] }]);
    answers.set("/api/activity/job-7/lines", [{ lines: ["The write failed."] }]);
    const p = probe("build", undefined, { t: T0 + 5 * 60_000 });
    await settle(p.m);
    expect(p.hook().found!.run).toMatchObject({ state: "failed", endedAt: T0 + 40_000 });
    expect(p.hook().stop).toBeUndefined();
    const out = html(<JobFoundView what="Building…" found={p.hook().found} />);
    expect(out).toContain(esc(J.ended(J.time(40_000))));
    expect(out).toContain("The write failed.");
    expect(out).toContain(`>${esc(undoWords(WAY))}</button>`);
    expect(out).toContain(`>${esc(W.saveBundle)}<`);
    // Nothing found again was started here: no end is told to the page.
    expect(p.ended()).toBe(0);
  });

  it("says Refused for one that refused, with the page that confirms it", () => {
    const run = foundRun(
      {
        ...job({}),
        state: "failed",
        finishedAt: "2026-11-18T10:00:08.000Z",
        result: { code: 1, refused: { reasons: ["hand-edits"] } },
      } as never,
      T0,
    );
    expect(run.state).toBe("refused");
    const out = html(<JobFoundView what="Building…" found={{ run, lines: [] }} />);
    expect(out).toContain(esc(J.refused(J.time(8_000))));
    expect(out).toContain(`href="#/catalog-builds">${esc(J.seeRefusal)}</a>`);
    expect(foundRun({ ...job({}), state: "cancelled" } as never, T0 + 1).state).toBe("stopped");
  });

  it("one that ended more than ten minutes ago, none at all, an older server, and a panel with a job of its own: nothing is said", async () => {
    const old = { ...job({}), state: "done", finishedAt: "2026-11-18T10:00:40.000Z" };
    answers.set("/api/jobs?action=build", [{ jobs: [old] }]);
    const late = probe("build", undefined, { t: T0 + 40_000 + FOUND_FOR_MS + 1 });
    await settle(late.m);
    expect(late.hook().found).toBeUndefined();
    answers.set("/api/jobs?action=undo", [{ jobs: [] }]);
    const none = probe("undo", undefined, { t: T0 });
    await settle(none.m);
    expect(none.hook().found).toBeUndefined();
    // No such route (404): as today.
    const older = probe("map-edits", undefined, { t: T0 });
    await settle(older.m);
    expect(older.hook().found).toBeUndefined();
    expect(html(<JobFoundView what="Building…" found={undefined} />)).toBe("");
    calls.length = 0;
    const own = probe("build", undefined, { t: T0 }, true);
    await settle(own.m);
    expect(calls).toEqual([]);
    expect(own.hook().found).toBeUndefined();
  });
});

describe("why a task isn't ready (point 6)", () => {
  it("says Not ready with the plan's sentence when the task waits for no task", () => {
    const why = "it names task t9 in (after …), which tasks.md doesn't have";
    expect(taskNotReadyWords({ done: false, why })).toBe(
      "Not ready: it names task t9 in (after …), which tasks.md doesn't have.",
    );
    // `waits` says it as before, and `why` is not said twice.
    const waits = { tasks: ["1.1"], sameRepo: ["1.1"] };
    expect(taskNotReadyWords({ done: false, waits, why: "it waits for task 1.1" })).toBeUndefined();
    expect(taskWaitsWords({ done: false, waits })).toBe("Waits for 1.1 (same repo)");
    // Done, or a server that says no why (an older one): nothing.
    expect(taskNotReadyWords({ done: true, why })).toBeUndefined();
    expect(taskNotReadyWords({ done: false })).toBeUndefined();
  });
});
