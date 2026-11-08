import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/** UX re-walk: Prepare names a run that still waits, and a stage with nothing left says so. */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
let answer: () => Promise<unknown> = async () => ({});
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  api: () => answer(),
}));
const { ApiError } = await import("../src/api/client.js");
const { COPY } = await import("../src/copy.js");
const { HandoffStep } = await import("../src/app/runstep.js");
const T = COPY.runStep;
const tick = () => new Promise((r) => setTimeout(r, 0));

const press = async () => {
  const m = mount(HandoffStep as never, { args: ["change", "feature", "c1"] } as never);
  (all(m.tree).find((e) => e.type === "button")!.props.onClick as () => void)();
  await tick();
  m.render();
  return m;
};

it("links the run a step still waits on", async () => {
  answer = async () => {
    throw new ApiError({
      title: "The step wasn't prepared",
      status: 422,
      detail: "Run run-20261108-0001 is still waiting for its answer.",
    } as never);
  };
  const m = await press();
  const link = all(m.tree).find((e) => e.type === "a")!;
  expect(link.props.href).toBe("#/runs?run=run-20261108-0001");
  expect(text(link.props.children)).toBe(T.handoffOpenWaiting);
});

it("says what a step with nothing left to hand off did", async () => {
  answer = async () => ({ lines: ["The feature stage is done."] });
  const m = await press();
  expect(text(m.tree)).toContain("The feature stage is done.");
});
