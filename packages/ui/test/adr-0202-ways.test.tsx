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
const { cantStopNow, endedRun, FOUND_FOR_MS, JobFound, JobFoundView, JobProgress, useJobRun } =
  await import("../src/app/job-progress.js");
const { stopOffered } = await import("../src/app/job.js");
const { UndoConfirm } = await import("../src/app/confirm-dialog.js");
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
    const r = run({ stoppable: false, couldStop: true });
    expect(cantStopNow(r)).toBe(true);
    const out = html(<JobProgress what="Applying…" run={r} onStop={() => undefined} now={5_000} />);
    expect(out).not.toContain("<button");
    expect(out).toContain(`role="status"`);
    expect(out).toContain(esc(J.tooLateNow));
    // Stopping is not too late: the Stop was taken.
    expect(cantStopNow(run({ stoppable: false, couldStop: true, stopping: true }))).toBe(false);
  });

  it("a job whose work never hears Stop: no Stop from the start, and no word of it being late", () => {
    const r = run({ stoppable: false });
    expect(cantStopNow(r)).toBe(false);
    const out = html(
      <JobProgress what="Upgrading…" run={r} onStop={() => undefined} now={5_000} />,
    );
    expect(out).not.toContain("<button");
    expect(out).not.toContain(esc(J.tooLateNow));
    expect(out).not.toContain(esc(J.tooLate));
  });

  it("one rule says when Stop is offered: the job's word, else what the panel says for an older server", () => {
    expect(stopOffered({ stoppable: true }, false)).toBe(true);
    expect(stopOffered({ stoppable: false }, true)).toBe(false);
    // An older server says nothing: an Apply or a build stops there; Propose and Bring in don't.
    expect(stopOffered({}, true)).toBe(true);
    expect(stopOffered({}, false)).toBe(false);
  });

  it("Propose and Bring in against an older server: no Stop (it would push or bring in all the same)", async () => {
    answers.set("POST /api/propose", [{ jobId: "job-p" }]);
    answers.set("/api/jobs/job-p", [
      { state: "running", errors: [], progress: { done: 0, total: 1, message: "Proposing" } },
      { state: "done", errors: [], result: { code: 0, lines: ["ok"] } },
    ]);
    const steps: (() => void)[] = [];
    const wait = () => new Promise<void>((r) => steps.push(r));
    let hook!: ReturnType<typeof useJobRun>;
    const m = mount(() => {
      hook = useJobRun({ clock: () => 1_000, wait, stopOnlyWhenSaid: true });
      return null;
    }, {});
    const ended = hook.follow("/api/propose", {});
    await settle(m);
    expect(hook.run?.state).toBe("running");
    expect(hook.stop).toBeUndefined();
    for (const g of steps) g();
    await ended;
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

  const PLAN = {
    n: 1,
    takesBack: [{ n: 1, command: "atticus repo rename forge-ledger forge-books" }],
    files: [
      { path: "catalog/generated/table/ledger.yaml", to: "file" as const },
      { path: "catalog/generated/table/new.yaml", to: "absent" as const },
    ],
    hash: "a".repeat(64),
  };
  const view = (at: Parameters<typeof UndoHereView>[0]["at"]) =>
    html(
      <UndoHereView
        undo={WAY}
        at={at}
        onOpen={() => undefined}
        onUndo={async () => undefined}
        onBack={() => undefined}
      />,
    );

  it("each state: listing, asking, undone, failed", () => {
    expect(view({ state: "listing" })).toContain(`aria-disabled="true" aria-busy="true"`);
    expect(view({ state: "listing" })).toContain(esc(W.undoListing));
    const undone = view({ state: "undone" });
    expect(undone).toContain(`role="status"`);
    expect(undone).toContain(esc(W.undone));
    expect(undone).not.toContain("<button");
    const failed = view({ state: "failed", why: "the list changed" });
    expect(failed).toContain(`role="alert"`);
    expect(failed).toContain(esc(W.undoFailed("the list changed")));
  });

  it("asking is Catalog builds' own confirm, titled with which build, naming the builds it takes back, a rename's note and each file", () => {
    const m = mount(
      UndoHereView as never,
      {
        undo: WAY,
        at: { state: "asking", plan: PLAN },
        onOpen: () => undefined,
        onUndo: async () => undefined,
        onBack: () => undefined,
      } as never,
    );
    const c = all(m.tree).find((e) => e.type === UndoConfirm)!;
    expect(c.props).toMatchObject({
      plan: PLAN,
      title: undoWords(WAY),
      ask: W.undoAsk,
      confirm: W.undoYes,
    });
    // Rendered: the dialog says the command and time, the builds it takes back by number and
    // command, how to rename back, every file, and asks.
    const out = html(
      <UndoConfirm
        plan={PLAN}
        title={undoWords(WAY)}
        ask={W.undoAsk}
        confirm={W.undoYes}
        onConfirm={async () => undefined}
        onClose={() => undefined}
      />,
    );
    expect(out).toContain(esc(undoWords(WAY)));
    expect(out).toContain(
      esc(COPY.catalogBuild.undoPlanIntro("1 (atticus repo rename forge-ledger forge-books)")),
    );
    expect(out).toContain(esc(COPY.catalogBuild.undoRename("forge-ledger", "forge-books")));
    expect(out).toContain("restore catalog/generated/table/ledger.yaml");
    expect(out).toContain("remove catalog/generated/table/new.yaml");
    expect(out).toContain(esc(W.undoAsk));
    expect(out).toContain(`>${esc(W.undoYes)}</button>`);
  });

  it("one click lists the plan; nothing is undone without the confirm; Undo sends the error's three values", async () => {
    answers.set("/api/build/undo?n=1", [{ copies: [], plan: PLAN }]);
    answers.set("POST /api/build/undo", [{ jobId: "job-u" }]);
    answers.set("/api/jobs/job-u", [{ state: "done", errors: [], result: { code: 0, lines: [] } }]);
    let done = 0;
    const m = mount(UndoHere as never, { undo: WAY, onDone: () => done++ } as never);
    const props = () =>
      all(m.tree).find((e) => e.type === UndoHereView)!.props as Parameters<typeof UndoHereView>[0];
    expect(props().at).toEqual({ state: "idle" });
    props().onOpen();
    await settle(m);
    expect(props().at).toEqual({ state: "asking", plan: PLAN });
    // Listed, and nothing sent yet.
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    props().onBack();
    m.render();
    expect(props().at).toEqual({ state: "idle" });
    props().onOpen();
    await settle(m);
    await props().onUndo();
    await settle(m);
    expect(calls).toContainEqual({
      path: "/api/build/undo",
      method: "POST",
      body: { n: 1, files: 2, plan: "a".repeat(64) },
    });
    expect(props().at).toEqual({ state: "undone" });
    expect(done).toBe(1);
  });

  it("a list that changed meanwhile is refused, and the confirm says so (nothing is undone)", async () => {
    answers.set("/api/build/undo?n=1", [{ copies: [], plan: PLAN }]);
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
    const props = () =>
      all(m.tree).find((e) => e.type === UndoHereView)!.props as Parameters<typeof UndoHereView>[0];
    props().onOpen();
    await settle(m);
    // The confirm's own Undo: its rejection is what the dialog shows as its error.
    await expect(props().onUndo()).rejects.toThrow("Nothing was undone: look at the list again.");
    await settle(m);
    expect(props().at).toEqual({ state: "asking", plan: PLAN });
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
    kind: "local",
    state: "running",
    errors: [],
    startedAt: "2026-11-18T10:00:00.000Z",
    progress: { done: 0, total: 1, message: "Reading the build's inputs… (12 s in)" },
    stoppable: true,
    stopLands: "now",
    ...more,
  });
  const probe = (action: string, repo: string | undefined, now: { t: number }, skip = false) => {
    let steps: (() => void)[] = [];
    const wait = () => new Promise<void>((r) => steps.push(r));
    let ended = 0;
    const m = mount(
      JobFound as never,
      {
        action,
        repo,
        what: "Applying to forge-ledger…",
        skip,
        onEnd: () => ended++,
        clock: () => now.t,
        wait,
      } as never,
    );
    const view = () =>
      all(m.tree).find((e) => e.type === JobFoundView)?.props as
        Parameters<typeof JobFoundView>[0] | undefined;
    const next = async () => {
      const go = steps;
      steps = [];
      for (const g of go) g();
      await settle(m);
    };
    return { m, view, next, ended: () => ended };
  };

  it("asks for its own action and repo; a running job is followed as one the panel started: its message, the server's start, Stop and its lines, to its end", async () => {
    const q = "/api/jobs?action=apply&repo=forge-ledger";
    answers.set(q, [{ jobs: [job({})] }]);
    answers.set("/api/jobs/job-7", [
      job({}),
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
    ]);
    const now = { t: T0 + 20_000 };
    const p = probe("apply", "forge-ledger", now);
    await settle(p.m);
    expect(calls[0]).toEqual({ path: q });
    expect(p.view()!.run).toMatchObject({
      state: "running",
      startedAt: T0,
      jobId: "job-7",
      step: "Reading the build's inputs… (12 s in)",
      stoppable: true,
      stopLands: "now",
    });
    expect(p.view()!.lines).toEqual(["Reading forge-ledger…", "Verifying 40 facts…"]);
    // The time so far is from the server's start, not from when this page was loaded.
    const shown = html(<JobFoundView {...p.view()!} now={now.t} />);
    expect(shown).toContain(esc(J.found));
    expect(shown).toContain(esc(J.soFar(J.time(20_000))));
    expect(shown).toContain(`aria-label="${esc(JW.stopLabel("Applying to forge-ledger…"))}"`);
    expect(shown).toContain(`aria-label="${esc(J.linesLabel("Applying to forge-ledger…"))}"`);
    // Stop asks the server, and is said at once.
    p.view()!.onStop!();
    await settle(p.m);
    expect(calls).toContainEqual({ path: "/api/jobs/job-7/cancel", method: "POST" });
    expect(p.view()!.run!.stopping).toBe(true);
    // The write had started: the job says a Stop can't take effect, and so says the panel.
    await p.next();
    expect(p.view()!.run).toMatchObject({ step: "Writing the catalog…", stoppable: false });
    expect(cantStopNow(p.view()!.run)).toBe(true);
    expect(p.view()!.onStop).toBeUndefined();
    now.t = T0 + 90_000;
    await p.next();
    expect(p.view()!.run).toMatchObject({ state: "done", startedAt: T0, endedAt: T0 + 90_000 });
    expect(p.ended()).toBe(1);
    expect(html(<JobFoundView {...p.view()!} />)).toContain(esc(J.done(J.time(90_000))));
  });

  it("polls that fail: it tries again, and after three in a row says it lost touch, with Check again and no Stop", async () => {
    const fail = () => {
      throw new ApiError({ type: "x", title: "Unreachable", status: 0, detail: "offline" });
    };
    answers.set("/api/jobs?action=build", [{ jobs: [job({})] }]);
    answers.set("/api/jobs/job-7", [fail, job({}), fail, fail, fail, fail]);
    answers.set("/api/activity/job-7/lines", [{ lines: [] }]);
    const p = probe("build", undefined, { t: T0 + 5_000 });
    await settle(p.m);
    // One failed poll, then an answer: still followed.
    await p.next();
    await p.next();
    expect(p.view()!.run!.state).toBe("running");
    await p.next();
    await p.next();
    await p.next();
    await p.next();
    expect(p.view()!.run!.state).toBe("lost");
    expect(p.view()!.onStop).toBeUndefined();
    const out = html(<JobFoundView {...p.view()!} />);
    expect(J.lost).toBe("Lost touch with the job:");
    expect(out).toContain(esc(J.lost));
    expect(out).toContain(`>${esc(J.checkAgain)}</button>`);
    expect(out).not.toContain(esc(JW.stop));
    // Check again asks for the job again.
    calls.length = 0;
    answers.set("/api/jobs?action=build", [{ jobs: [] }]);
    p.view()!.onAgain!();
    await settle(p.m);
    expect(calls[0]).toEqual({ path: "/api/jobs?action=build" });
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
    expect(p.view()!.run).toMatchObject({ state: "failed", endedAt: T0 + 40_000 });
    expect(p.view()!.onStop).toBeUndefined();
    const out = html(<JobFoundView {...p.view()!} />);
    expect(out).toContain(esc(J.ended(J.time(40_000))));
    expect(out).toContain("The write failed.");
    expect(out).toContain(`>${esc(undoWords(WAY))}</button>`);
    expect(out).toContain(`>${esc(W.saveBundle)}<`);
    // Nothing found again was started here: no end is told to the page.
    expect(p.ended()).toBe(0);
  });

  it("says Refused for one that refused, with the page that confirms it", () => {
    const run = endedRun(
      { ...job({}), state: "failed", finishedAt: "2026-11-18T10:00:08.000Z" } as never,
      T0,
    );
    const out = html(
      <JobFoundView
        what="Building…"
        run={run}
        result={{ code: 1, refused: { reasons: ["hand-edits"] } }}
      />,
    );
    expect(out).toContain(esc(J.refused(J.time(8_000))));
    expect(out).toContain(`href="#/catalog-builds">${esc(J.seeRefusal)}</a>`);
    expect(endedRun({ ...job({}), state: "cancelled" } as never, T0 + 1).state).toBe("stopped");
  });

  it("one that ended more than ten minutes ago, none at all, an older server, and a panel with a job of its own: nothing is said", async () => {
    const old = { ...job({}), state: "done", finishedAt: "2026-11-18T10:00:40.000Z" };
    answers.set("/api/jobs?action=build", [{ jobs: [old] }]);
    const late = probe("build", undefined, { t: T0 + 40_000 + FOUND_FOR_MS + 1 });
    await settle(late.m);
    expect(late.view()?.run).toBeUndefined();
    answers.set("/api/jobs?action=undo", [{ jobs: [] }]);
    const none = probe("undo", undefined, { t: T0 });
    await settle(none.m);
    expect(none.view()?.run).toBeUndefined();
    // No such route (404): as today.
    const older = probe("map-edits", undefined, { t: T0 });
    await settle(older.m);
    expect(older.view()?.run).toBeUndefined();
    expect(html(<JobFoundView what="Building…" run={undefined} />)).toBe("");
    calls.length = 0;
    const own = probe("build", undefined, { t: T0 }, true);
    await settle(own.m);
    expect(calls).toEqual([]);
    expect(own.view()).toBeUndefined();
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
