import { beforeEach, expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * beta.23 review (Home): a product owner's folded Home still says what their own install needs;
 * the checklist reads again when a step's job ends; Your changes knows the person's roles on
 * every change in flight, not only the five whose questions are shown.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});

const answers: Record<string, unknown> = {};
const reloads: Record<string, number> = {};
let hear: ((e: { type: string } & Record<string, unknown>) => void) | undefined;
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useApi: (path?: string) =>
    path === undefined || !(path.split("?")[0]! in answers)
      ? { state: "loading", reload: () => undefined }
      : {
          state: "ready",
          data: answers[path.split("?")[0]!],
          reload: () => {
            reloads[path] = (reloads[path] ?? 0) + 1;
          },
        },
  useLiveEvents: () => undefined,
  useReloadOnFiles: () => undefined,
  // What a page hears: its handler, and whether a job's end is heard too.
  useFileChanges: (fn: () => void, _quiet?: number, o?: { jobs?: boolean }) => {
    hear = (e) => {
      if (e.type === "job.done" && !o?.jobs) return;
      fn();
    };
  },
}));
const { COPY } = await import("../src/copy.js");
const { OwnInstall, SetupChecklist } = await import("../src/screens/CommandCenter.js");
const { UpgradeOffer } = await import("../src/app/upgrade.js");
const { YourRoleQuestions } = await import("../src/screens/RoleQuestions.js");

const failingMachine = {
  baselined: false,
  steps: [
    {
      id: "machine",
      label: "This machine has what Atticus needs",
      done: false,
      detail: "to fix: Node",
      fix: "Open Settings › This machine, fix what it names, then press Check again: Install Node 22.13.0 or later.",
    },
    { id: "repos", label: "Repos are listed", done: true, detail: "40 repos" },
  ],
};

beforeEach(() => {
  for (const k of Object.keys(answers)) delete answers[k];
  for (const k of Object.keys(reloads)) delete reloads[k];
  hear = undefined;
});

it("shows a folded Home's own install outside the fold: a failing machine and a newer Atticus", () => {
  answers["/api/setup"] = failingMachine;
  const m = mount(OwnInstall as never, {} as never);
  const t = text(m.tree);
  expect(t).toContain("This machine has what Atticus needs");
  expect(t).toContain(COPY.appStep.setupMachine);
  expect(all(m.tree).some((e) => (e.type as { name?: string }).name === "OpenMachine")).toBe(true);
  expect(all(m.tree).some((e) => e.props.role === "alert")).toBe(true);
  const upgrade = all(m.tree).filter((e) => e.type === UpgradeOffer);
  expect(upgrade.map((e) => e.props.part)).toEqual(["newer"]);
  // A machine that has what it needs says nothing there.
  answers["/api/setup"] = {
    ...failingMachine,
    steps: [{ ...failingMachine.steps[0], done: true }],
  };
  expect(text(mount(OwnInstall as never, {} as never).tree)).not.toContain("This machine");
});

it("splits the upgrade offer: the newer-Atticus alert apart from the steps that wait", () => {
  answers["/api/upgrade"] = { newer: true, stamp: "2.1.0", atticus: "2.0.0", pending: [] };
  expect(mount(UpgradeOffer as never, { part: "pending" } as never).tree).toBeNull();
  expect(mount(UpgradeOffer as never, { part: "newer" } as never).tree).not.toBeNull();
  answers["/api/upgrade"] = {
    newer: false,
    pending: [{ id: "runtime-v4", summary: "x", files: [] }],
  };
  expect(mount(UpgradeOffer as never, { part: "newer" } as never).tree).toBeNull();
  expect(mount(UpgradeOffer as never, { part: "pending" } as never).tree).not.toBeNull();
});

it("links the machine's step to Settings › This machine in the checklist", () => {
  answers["/api/setup"] = failingMachine;
  const m = mount(SetupChecklist as never, {} as never);
  expect(text(m.tree)).toContain(COPY.appStep.setupMachine);
  expect(all(m.tree).some((e) => (e.type as { name?: string }).name === "OpenMachine")).toBe(true);
});

it("reads the checklist again when a step's job ends (a Sync clones into workspace/)", () => {
  answers["/api/setup"] = failingMachine;
  mount(SetupChecklist as never, {} as never);
  expect(hear).toBeDefined();
  hear!({ type: "job.done", jobId: "j-1", state: "done" });
  expect(reloads["/api/setup"]).toBe(1);
  hear!({ type: "file.changed", path: "org-pack/pack.yaml", catalog: true });
  expect(reloads["/api/setup"]).toBe(2);
});

it("tells Home the person's roles on every change in flight, past the five shown", () => {
  const changes = [
    ...Array.from({ length: 7 }, (_, k) => ({
      id: `change-${k}`,
      state: "build",
      yourRoles: k % 2 ? ["delivery"] : [],
    })),
    { id: "reviewed", state: "post-release-review", yourRoles: ["product"] },
    { id: "gone", state: "archived", yourRoles: ["product"] },
  ];
  let told: Record<string, string[]> = {};
  const m = mount(
    YourRoleQuestions as never,
    { changes, onRoles: (r: Record<string, string[]>) => (told = { ...r }) } as never,
  );
  expect(told["change-5"]).toEqual(["delivery"]);
  expect(told["change-6"]).toEqual([]);
  expect(told["reviewed"]).toEqual(["product"]);
  expect(told["gone"]).toBeUndefined();
  // Still at most five changes' question panels.
  const panels = all(m.tree).filter(
    (e) =>
      typeof e.type === "function" && (e.type as { name?: string }).name === "ChangeRoleQuestions",
  );
  expect(panels.length).toBeLessThanOrEqual(5);
});
