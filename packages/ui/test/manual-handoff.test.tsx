import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * Sixth UX walk: on a manual Git host, Raise hand-off leaves opening the PR to a person, as a
 * step on Home. Until then the change's pages say so, with a link there, never a manual:// link
 * dressed as an open PR.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const URL = "manual://git-host/forge/forge-gq/pull/2";
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useApi: (path: string) => ({
    state: "ready",
    data: path.endsWith("/status")
      ? {
          state: "define",
          phase: "define",
          blockers: [],
          reasons: [],
          nextStep: `Merge PR #2 once it is approved (${URL}); syncing then moves the change on.`,
          handoff: { pr: { number: 2, url: URL }, state: "open", phase: "define" },
          risk: { level: "medium", score: 4 },
        }
      : {
          id: "c1",
          title: "C1",
          type: "feature",
          state: "define",
          artifacts: [],
          handoff: { phase: "define", pr: URL, state: "open" },
        },
    reload: () => undefined,
  }),
  useLiveEvents: () => undefined,
}));
const { COPY } = await import("../src/copy.js");
const { GateHeader } = await import("../src/screens/know/Phase.js");
const { ManualHandoff } = await import("../src/screens/know/task-pr.js");
const T = COPY.phase;

const part = (which: "gate" | "hero") => {
  const m = mount(
    GateHeader as never,
    { part: which, id: "c1", title: "C1", picker: null, reload: () => undefined } as never,
  );
  const v = all(m.tree).find((e) => typeof e.props.children === "function" && "of" in e.props)!;
  return (v.props.children as (d: unknown) => unknown)((v.props.of as { data: unknown }).data);
};

it("the gate says opening the PR waits on a manual step, not 'Merge PR #2 (manual://…)'", () => {
  const gate = part("gate");
  expect(all(gate).some((e) => e.type === ManualHandoff && e.props.phase === "define")).toBe(true);
  expect(text(gate)).not.toContain("manual://");
  expect(text(gate)).not.toContain(T.approvalMerge);
  const step = mount(ManualHandoff as never, { phase: "define" } as never);
  expect(text(step.tree)).toContain(T.handOffWaitsManual("define"));
  expect(all(step.tree).find((e) => e.type === "a")?.props.href).toBe("#/todo");
});

it("the hero names the hand-off as waiting on a manual step, not OPEN", () => {
  const hero = text(part("hero"));
  expect(hero).toContain(T.handOffManual("define"));
  expect(hero).not.toContain("open");
});
