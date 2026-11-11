import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * The map's own bar (beta.23): corrections drawn on the map and not yet applied show above it,
 * with one Apply for every corrected repo, and it is read again after every write the app makes.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
let applyFirst: string[] | undefined = [];
/** What the server's applyFirst is now; the bar sees it once it reads again (`reload`). */
let served: string[] | undefined = [];
let reloads = 0;
let onFiles: ((events: { type: string; path?: string }[]) => void) | undefined;
/** One reload, as useApi's is (the bar hears the app's writes once, not once a render). */
const reload = () => {
  reloads++;
  applyFirst = served;
};
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useFileChanges: (on: typeof onFiles) => void (onFiles = on),
  useApi: () => ({
    state: "ready",
    data: {
      scope: "work",
      files: [],
      branch: "b",
      title: "t",
      ...(applyFirst ? { applyFirst } : {}),
    },
    reload,
  }),
}));
/** The Apply job, ended by the test when it says. */
let job: { resolve: (r: { code: number; lines: string[] }) => void; reject: (e: Error) => void };
vi.mock("../src/app/job.js", async () => ({
  ...(await vi.importActual<object>("../src/app/job.js")),
  followJob: () =>
    new Promise((resolve, reject) => {
      job = { resolve, reject };
    }),
}));
const { COPY } = await import("../src/copy.js");
const { ApplyAll, ApplyAndPropose, CorrectionsToApply, workChanged } =
  await import("../src/app/propose.js");
const P = COPY.propose;
const settle = () => new Promise((r) => setTimeout(r, 0));

it("says nothing when every correction is applied", () => {
  applyFirst = [];
  const m = mount(CorrectionsToApply as never, {} as never);
  expect(m.tree).toBeNull();
});

it("a line drawn between two repos: names both and offers one Apply for them all", () => {
  applyFirst = ["forge-card-vault", "forge-ledger"];
  const m = mount(CorrectionsToApply as never, {} as never);
  expect(text(m.tree)).toContain(P.onMap("forge-card-vault, forge-ledger"));
  expect(all(m.tree).find((e) => e.type === ApplyAll)?.props.noPropose).toBe(true);
  expect(all(m.tree).some((e) => e.type === ApplyAndPropose)).toBe(false);
});

it("one repo corrected: its own Apply", () => {
  applyFirst = ["forge-ledger"];
  const m = mount(CorrectionsToApply as never, {} as never);
  expect(all(m.tree).find((e) => e.type === ApplyAndPropose)?.props.repo).toBe("forge-ledger");
  expect(all(m.tree).some((e) => e.type === ApplyAll)).toBe(false);
});

// Review of beta.24: a correction the CLI or an assistant writes shows too, by the server's
// file events, not only the app's own writes. Round 3: only for the files the bar is about, and
// not again for the app's own write heard back.
it("is read again when a corrections file changes on the server, and only then", () => {
  applyFirst = served = ["forge-ledger"];
  const m = mount(CorrectionsToApply as never, {} as never);
  reloads = 0;
  onFiles!([{ type: "file.changed", path: "specs/forge-ledger/spec.yaml" }]);
  expect(reloads).toBe(0);
  served = ["forge-ledger", "forge-teller"];
  onFiles!([{ type: "file.changed", path: "facts/forge-teller.corrections.jsonl" }]);
  expect(reloads).toBe(1);
  m.render();
  expect(all(m.tree).some((e) => e.type === ApplyAll)).toBe(true);
  onFiles!([{ type: "file.changed", path: "questions/q-0001.yaml" }]);
  expect(reloads).toBe(2);
  // The app's own write is read at once; its file events, heard back, aren't read again.
  // (Earlier tests' bars hear the write too: the hooks shim runs no clean-up.)
  workChanged();
  expect(reloads).toBeGreaterThan(2);
  const heard = reloads;
  onFiles!([{ type: "file.changed", path: "facts/forge-teller.corrections.jsonl" }]);
  expect(reloads).toBe(heard);
});

// Review of beta.24, round 3: the job's own writes read the bar again while it runs (each repo
// verify writes leaves applyFirst), so it once named one repo, and Apply to every repo's map went
// with its lines and Sync mid-job. It stays while it runs, and with its errors once it failed.
it("keeps Apply to every repo's map through a reload while it runs, and its errors after", async () => {
  applyFirst = served = ["forge-card-vault", "forge-ledger", "forge-teller"];
  const m = mount(CorrectionsToApply as never, {} as never);
  const apply = () => all(m.tree).find((e) => e.type === ApplyAll);
  (apply()!.props.onRun as () => void)();
  m.render();
  expect(apply()?.props.run).toMatchObject({ running: true });
  // verify wrote two repos' maps: the file events read the bar again, and it names one.
  served = ["forge-teller"];
  onFiles!([{ type: "file.changed", path: "facts/forge-ledger.verify.yaml" }]);
  m.render();
  expect(text(m.tree)).toContain(P.onMap("forge-teller"));
  expect(apply()?.props.run).toMatchObject({ running: true });
  expect(all(m.tree).some((e) => e.type === ApplyAndPropose)).toBe(false);
  // It ends: forge-teller has no clone here.
  job.reject(new Error("forge-teller has no clone here: Sync the repos first."));
  await settle();
  m.render();
  expect(apply()?.props.run).toMatchObject({
    running: false,
    lines: ["forge-teller has no clone here: Sync the repos first."],
    note: { ok: false },
  });
  expect(all(m.tree).some((e) => e.type === ApplyAndPropose)).toBe(false);
  // Read again after the job: still kept, until dismissed.
  onFiles!([{ type: "file.changed", path: "facts/forge-teller.corrections.jsonl" }]);
  m.render();
  expect(apply()).toBeDefined();
  const dismiss = all(m.tree).find((e) => e.type === "button" && text(e) === P.dismissErrors)!;
  expect(P.dismissErrors).toBe("Dismiss these errors");
  (dismiss.props.onClick as () => void)();
  m.render();
  expect(all(m.tree).find((e) => e.type === ApplyAndPropose)?.props.repo).toBe("forge-teller");
  expect(apply()).toBeUndefined();
});

// Review of beta.24, round 3: with two repos or more left, Dismiss takes the errors away too
// (they were Apply's own, which stays for the repos left).
it("dismisses the errors with two repos left, and keeps one Apply for them", async () => {
  applyFirst = served = ["forge-card-vault", "forge-ledger", "forge-teller"];
  const m = mount(CorrectionsToApply as never, {} as never);
  const apply = () => all(m.tree).find((e) => e.type === ApplyAll);
  (apply()!.props.onRun as () => void)();
  served = ["forge-ledger", "forge-teller"];
  job.reject(new Error("forge-ledger: the facts file can't be read."));
  await settle();
  m.render();
  expect(apply()?.props.run).toMatchObject({
    lines: ["forge-ledger: the facts file can't be read."],
  });
  const dismiss = all(m.tree).find((e) => e.type === "button" && text(e) === P.dismissErrors)!;
  (dismiss.props.onClick as () => void)();
  m.render();
  expect(apply()?.props.run).toEqual({ running: false });
  expect(all(m.tree).some((e) => e.type === "button" && text(e) === P.dismissErrors)).toBe(false);
  // Applied every repo: the bar says so, and keeps no lines of the run.
  (apply()!.props.onRun as () => void)();
  served = [];
  job.resolve({ code: 0, lines: ["Applied forge-ledger and forge-teller."] });
  await settle();
  m.render();
  expect(text(m.tree)).toContain(P.onMapApplied);
  expect(apply()).toBeUndefined();
});
