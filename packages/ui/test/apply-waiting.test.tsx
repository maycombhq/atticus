import { beforeEach, expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * Beta.28.4 (field report, an estate of 40 repos): the map's bar offered only "Apply to every
 * repo's map" once two repos had corrections waiting, and that ran every repo read so far. It
 * now offers each waiting repo its own Apply and one Apply for the repos that wait, which sends
 * exactly those repos. Invented Forge estate (CLAUDE.md rule 3); no network (rule 5).
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
let applyFirst: string[] = [];
let served: string[] = [];
let onFiles: ((events: { type: string; path?: string }[]) => void) | undefined;
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useFileChanges: (on: typeof onFiles) => void (onFiles = on),
  useApi: () => ({
    state: "ready",
    data: { scope: "work", files: [], branch: "b", title: "t", applyFirst },
    reload: () => void (applyFirst = served),
  }),
}));
/** Each job started (its path and body), ended by the test when it says. */
const started: { path: string; body: unknown }[] = [];
let job: {
  resolve: (r: { code: number; lines: string[]; result?: Record<string, unknown> }) => void;
  reject: (e: Error) => void;
};
/** What the page hears of the running job's progress (the repo it is on). */
let progress:
  ((p: { done: number; total: number; message: string; stopping?: boolean }) => void) | undefined;
vi.mock("../src/app/job.js", async () => ({
  ...(await vi.importActual<object>("../src/app/job.js")),
  followJob: (
    path: string,
    body: unknown,
    _wait: unknown,
    _onJob: unknown,
    onProgress?: typeof progress,
  ) =>
    new Promise((resolve, reject) => {
      started.push({ path, body });
      progress = onProgress;
      job = { resolve, reject };
    }),
}));
const { COPY } = await import("../src/copy.js");
const { ApiError } = await import("../src/api/client.js");
const { JobFailed } = await import("../src/app/job.js");
const { ApplyAll, ApplyAndPropose, CorrectionsToApply, runApplyAll } =
  await import("../src/app/propose.js");
const P = COPY.propose;
const T = COPY.appStep;
const settle = () => new Promise((r) => setTimeout(r, 0));
type El = ReturnType<typeof all>[number];
const buttons = (tree: unknown) => all(tree).filter((e) => e.type === "button");
const each = (tree: unknown): El[] => all(tree).filter((e) => e.type === ApplyAndPropose);
const waiting = (tree: unknown): El | undefined => all(tree).find((e) => e.type === ApplyAll);
const THREE = ["forge-card-vault", "forge-ledger", "forge-teller"];

beforeEach(() => {
  started.length = 0;
});

it("one repo waiting: its own Apply, named, and nothing about several repos", () => {
  applyFirst = served = ["forge-ledger"];
  const m = mount(CorrectionsToApply as never, {} as never);
  expect(each(m.tree).map((e) => e.props.repo)).toEqual(["forge-ledger"]);
  expect(waiting(m.tree)).toBeUndefined();
  expect(text(m.tree)).not.toContain(P.oneAtATime);
  // The button itself names the repo (its visible words are its accessible name).
  const one = mount(
    ApplyAndPropose as never,
    { scope: "corrections", repo: "forge-ledger" } as never,
  );
  expect(buttons(one.tree).map((b) => text(b))).toContain("Apply to forge-ledger's map");
});

it("several repos waiting: one Apply for those repos, and each repo's own Apply in a list", () => {
  applyFirst = served = THREE;
  const m = mount(CorrectionsToApply as never, {} as never);
  expect(waiting(m.tree)?.props.repos).toEqual(THREE);
  expect(each(m.tree).map((e) => e.props.repo)).toEqual(THREE);
  expect(each(m.tree).every((e) => e.props.disabled === false)).toBe(true);
  const list = all(m.tree).find((e) => e.type === "ul")!;
  expect(list.props["aria-label"]).toBe(P.onMapEach);
  expect(text(m.tree)).toContain(P.oneAtATime);
  // The bar is named for what it lists, never for every repo.
  const bar = all(m.tree).find((e) => e.type === "section")!;
  expect(bar.props["aria-label"]).toBe("Corrections waiting to be applied");
});

it("the Apply for the repos that wait says how many, and never every repo", () => {
  const m = mount(ApplyAll as never, { noPropose: true, repos: THREE } as never);
  expect(buttons(m.tree).map((b) => text(b))).toEqual(["Apply to the 3 repos waiting"]);
  expect(text(m.tree)).not.toMatch(/every repo/i);
  expect(T.applyWaiting(2)).toBe("Apply to the 2 repos waiting");
  // With no list it is the step a page names as verify --all --write: every repo.
  const every = mount(ApplyAll as never, { noPropose: true } as never);
  expect(buttons(every.tree).map((b) => text(b))).toEqual(["Apply to every repo's map"]);
});

it("sends exactly the repos waiting, and says it applied those", async () => {
  let held: { running?: boolean; note?: { ok: boolean; text: string } } = {};
  const set = (s: unknown) => {
    held =
      typeof s === "function" ? (s as (w: typeof held) => typeof held)(held) : (s as typeof held);
  };
  const ran = runApplyAll(set as never, THREE);
  await settle();
  expect(started).toEqual([{ path: "/api/facts/apply-all", body: { repos: THREE } }]);
  job.resolve({ code: 0, lines: ["Verified 3 repos: 3 passed."], result: { applied: THREE } });
  expect(await ran).toBe(true);
  expect(held.note).toEqual({ ok: true, text: T.appliedWaiting(3) });
  expect(T.appliedWaiting(3)).not.toMatch(/every repo/i);
  // No list: the body is empty, as before, and the words are every repo's.
  const all = runApplyAll(set as never);
  await settle();
  expect(started[1]).toEqual({ path: "/api/facts/apply-all", body: {} });
  job.resolve({ code: 0, lines: [] });
  await all;
  expect(held.note).toEqual({ ok: true, text: T.appliedAll });
});

it("while the run for the repos waiting goes, no repo's own Apply can start", () => {
  applyFirst = served = THREE;
  const m = mount(CorrectionsToApply as never, {} as never);
  (waiting(m.tree)!.props.onRun as () => void)();
  m.render();
  expect(started[0]?.body).toEqual({ repos: THREE });
  expect(waiting(m.tree)?.props.run).toMatchObject({ running: true });
  expect(each(m.tree).every((e) => e.props.disabled === true)).toBe(true);
  // A repo applied leaves the list while the run goes on; the others stay, still held.
  served = ["forge-ledger", "forge-teller"];
  onFiles!([{ type: "file.changed", path: "facts/forge-card-vault.verify.yaml" }]);
  m.render();
  expect(each(m.tree).map((e) => [e.props.repo, e.props.disabled])).toEqual([
    ["forge-ledger", true],
    ["forge-teller", true],
  ]);
  job.resolve({ code: 0, lines: [] });
});

it("while one repo's own Apply goes, the others and the Apply for them all are held", () => {
  applyFirst = served = THREE;
  const m = mount(CorrectionsToApply as never, {} as never);
  const ledger = () => each(m.tree).find((e) => e.props.repo === "forge-ledger")!;
  (ledger().props.onStart as () => void)();
  m.render();
  expect(each(m.tree).map((e) => e.props.disabled)).toEqual([true, false, true]);
  expect(waiting(m.tree)?.props.disabled).toBe(true);
  (ledger().props.onEnd as () => void)();
  m.render();
  expect(each(m.tree).map((e) => e.props.disabled)).toEqual([false, false, false]);
  expect(waiting(m.tree)?.props.disabled).toBe(false);
});

it("a held Apply is a disabled button, the repo's and the one for them all", () => {
  const one = mount(
    ApplyAndPropose as never,
    { scope: "corrections", repo: "forge-ledger", noPropose: true, disabled: true } as never,
  );
  expect(buttons(one.tree)[0]?.props.disabled).toBe(true);
  const m = mount(ApplyAll as never, { noPropose: true, repos: THREE, disabled: true } as never);
  expect(buttons(m.tree)[0]?.props.disabled).toBe(true);
});

it("applied some: says how many, names the repos it didn't, and keeps their own Apply", async () => {
  applyFirst = served = THREE;
  const m = mount(CorrectionsToApply as never, {} as never);
  (waiting(m.tree)!.props.onRun as () => void)();
  served = ["forge-teller"];
  job.reject(
    new JobFailed(
      "forge-teller: 2 facts were rejected.",
      ["forge-teller: 2 facts were rejected."],
      undefined,
      1,
      {
        code: 1,
        applied: ["forge-card-vault", "forge-ledger"],
        notApplied: ["forge-teller"],
      },
    ),
  );
  await settle();
  m.render();
  const run = waiting(m.tree)!.props.run as {
    note: { ok: boolean; text: string };
    lines: string[];
  };
  expect(run.note).toEqual({
    ok: false,
    text: "Applied 2 of 3 repos. Not applied: forge-teller. Why is listed below; each repo not applied keeps its own Apply button.",
  });
  expect(run.lines).toEqual(["forge-teller: 2 facts were rejected."]);
  expect(each(m.tree).map((e) => [e.props.repo, e.props.disabled])).toEqual([
    ["forge-teller", false],
  ]);
  // With one repo left there is no "Apply to the 1 repos waiting": its own button is the way on.
  const left = mount(ApplyAll as never, { noPropose: true, repos: ["forge-teller"], run } as never);
  expect(buttons(left.tree)).toEqual([]);
  expect(text(all(m.tree).filter((e) => e.type === "button"))).toContain(P.dismissErrors);
});

it("applied none: the job's own words, with no count of repos applied", async () => {
  let held: { note?: { ok: boolean; text: string } } = {};
  const set = (s: unknown) => {
    held =
      typeof s === "function" ? (s as (w: typeof held) => typeof held)(held) : (s as typeof held);
  };
  const ran = runApplyAll(set as never, THREE);
  await settle();
  job.reject(
    new JobFailed("No checkout of forge-ledger.", ["No checkout of forge-ledger."], undefined, 1, {
      code: 1,
      applied: [],
      notApplied: THREE,
    }),
  );
  expect(await ran).toBe(false);
  expect(held.note).toEqual({ ok: false, text: "No checkout of forge-ledger." });
});

it("another step is running (409): it says it didn't start, in the server's words", async () => {
  let held: { note?: { ok: boolean; text: string } } = {};
  const set = (s: unknown) => {
    held =
      typeof s === "function" ? (s as (w: typeof held) => typeof held)(held) : (s as typeof held);
  };
  const ran = runApplyAll(set as never, THREE);
  await settle();
  const why =
    "Applying to forge-ledger is running on this server (job-4): wait for it to finish, then try again.";
  job.reject(new ApiError({ status: 409, title: "Conflict", detail: why } as never));
  expect(await ran).toBe(false);
  expect(held.note).toEqual({ ok: false, text: P.notStarted(why) });
});

// Beta.28.4: the run said nothing of how far it was. The page says which repo it is on, from the
// job's own count; the Console has each step and the time left.
it("while it runs, says how many repos of how many are done", async () => {
  let held: { running?: boolean; note?: { ok: boolean; text: string; working?: boolean } } = {};
  const set = (s: unknown) => {
    held =
      typeof s === "function" ? (s as (w: typeof held) => typeof held)(held) : (s as typeof held);
  };
  const ran = runApplyAll(set as never, THREE);
  await settle();
  expect(held.note?.text).toBe(COPY.app.working);
  progress!({ done: 0, total: 1, message: "Applying to 3 repos" });
  expect(held.note?.text).toBe(COPY.app.working);
  progress!({ done: 0, total: 3, message: "0 of 3 repos done, applying forge-card-vault" });
  expect(held.note?.text).toBe(
    "0 of 3 repos done. The Console shows the repo being applied, each step and about how long is left.",
  );
  progress!({ done: 2, total: 3, message: "Loading the catalog… (4 s in)" });
  expect(held).toMatchObject({
    running: true,
    note: {
      ok: true,
      working: true,
      text: "2 of 3 repos done. The Console shows the repo being applied, each step and about how long is left.",
    },
  });
  job.resolve({ code: 0, lines: [] });
  await ran;
  expect(held.note?.text).toBe(T.appliedWaiting(3));
});

// Beta.28.4: Stop between two repos. The job ends stopped with what it applied whole; the page
// says so in its own words, and the repos not applied keep their buttons.
it("stopped part way: says how many were applied, names the rest, and keeps their own Apply", async () => {
  applyFirst = served = THREE;
  const m = mount(CorrectionsToApply as never, {} as never);
  (waiting(m.tree)!.props.onRun as () => void)();
  served = ["forge-ledger", "forge-teller"];
  const said = "Stopped after 1 of 3 repos. Not applied: forge-ledger, forge-teller.";
  job.reject(
    new JobFailed(said, [said], undefined, 1, {
      code: 1,
      stopped: true,
      applied: ["forge-card-vault"],
      notApplied: ["forge-ledger", "forge-teller"],
    }),
  );
  await settle();
  m.render();
  const run = waiting(m.tree)!.props.run as { note: { ok: boolean; text: string } };
  expect(run.note).toEqual({
    ok: false,
    text: "Stopped: 1 of 3 repos applied. Not applied: forge-ledger, forge-teller; each keeps its own Apply button.",
  });
  expect(each(m.tree).map((e) => [e.props.repo, e.props.disabled])).toEqual([
    ["forge-ledger", false],
    ["forge-teller", false],
  ]);
  // Stopped before the first repo was applied: none applied, said the same way.
  expect(T.stoppedAfter(0, 2, "forge-ledger, forge-teller")).toBe(
    "Stopped: 0 of 2 repos applied. Not applied: forge-ledger, forge-teller; each keeps its own Apply button.",
  );
});

// Beta.28.4 (the review): Stop asked while a repo is being written looked ignored. The job says
// it is stopping, and the bar says what that means until the run ends.
it("while it is stopping, says the repo being written finishes first", async () => {
  let held: { running?: boolean; note?: { ok: boolean; text: string; working?: boolean } } = {};
  const set = (s: unknown) => {
    held =
      typeof s === "function" ? (s as (w: typeof held) => typeof held)(held) : (s as typeof held);
  };
  const ran = runApplyAll(set as never, THREE);
  await settle();
  progress!({ done: 1, total: 3, message: "Stopping after this repo…", stopping: true });
  expect(held).toMatchObject({
    running: true,
    note: {
      ok: true,
      working: true,
      text: "Stopping: 1 of 3 repos done. A repo being written finishes its write first; the repos after it are not applied.",
    },
  });
  job.resolve({ code: 0, lines: [] });
  await ran;
});
