import { describe, expect, it, vi } from "vitest";
import { all, mount } from "./support/hooks.js";

/**
 * Review round 30: Enter in "Reason to skip" skips the step with the reason. It used to submit
 * the Mark done form, recording the step done (merged, by you) and losing the reason.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const sent: { path: string; body?: unknown }[] = [];
vi.mock("../src/api/client.js", async () => {
  const real = await vi.importActual<object>("../src/api/client.js");
  return {
    ...real,
    api: async (path: string, o?: { body?: unknown }) => {
      sent.push({ path, body: o?.body });
      return {};
    },
  };
});
const { StepDetail } = await import("../src/screens/run/Todo.js");
const flush = () => new Promise((r) => setTimeout(r, 0));

const STEP = {
  id: "merge-pr-1",
  system: "git-host",
  action: "merge-pull-request",
  state: "open",
  title: "Merge the pull request",
  where: "forge-ledger",
  fields: [],
  instructions: [],
  result: [{ name: "mergedBy", label: "Merged by", required: false, type: "text" }],
  waitsFor: [],
  runs: [],
  executors: [],
};

describe("a Todo step's reason to skip", () => {
  it("skips with the reason when Enter is pressed in it, and Mark done stays its own form", async () => {
    const m = mount(StepDetail as never, { step: STEP, done: () => undefined } as never);
    (
      all(m.tree).find((e) => e.props.id === "skip-merge-pr-1")!.props.onChange as (
        e: unknown,
      ) => void
    )({
      target: { value: "merged under another PR" },
    });
    m.render();
    const forms = all(m.tree).filter((e) => e.type === "form");
    expect(forms).toHaveLength(2);
    // The form holding the reason is the one Enter submits.
    const skipForm = forms.find((f) => all(f).some((e) => e.props.id === "skip-merge-pr-1"))!;
    (skipForm.props.onSubmit as (e: unknown) => void)({ preventDefault: () => undefined });
    await flush();
    expect(sent.at(-1)).toMatchObject({
      path: "/api/todo/merge-pr-1/done",
      body: { skip: true, note: "merged under another PR" },
    });
  });
});
