import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/** UX review: in a browser with no model, an AI step is prepared for the person's assistant. */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const posted: unknown[] = [];
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  api: async (_path: string, o: { body: unknown }) => {
    posted.push(o.body);
    return { runId: "run-9" };
  },
}));
const { COPY } = await import("../src/copy.js");
const { HandoffStep } = await import("../src/app/runstep.js");
const T = COPY.runStep;

it("prepares the step as a hand-off and links to its run", async () => {
  const m = mount(HandoffStep as never, { args: ["plan", "stories", "c1"] } as never);
  const b = all(m.tree).find((e) => e.type === "button")!;
  expect(text(b.props.children)).toBe(T.handoffPrepare);
  (b.props.onClick as () => void)();
  await new Promise((r) => setTimeout(r, 0));
  m.render();
  expect(posted).toEqual([{ args: ["plan", "stories", "c1"] }]);
  const link = all(m.tree).find((e) => e.type === "a")!;
  expect(link.props.href).toBe("#/runs?run=run-9");
});
