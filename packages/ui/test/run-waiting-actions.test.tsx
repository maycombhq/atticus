import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/** UX review: a waiting run is finished (Done) or cancelled on its own page, no terminal. */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const posted: string[] = [];
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  api: async (path: string) => {
    posted.push(path);
    return {};
  },
}));
const { COPY } = await import("../src/copy.js");
const { WaitingActions } = await import("../src/screens/runs/Runs.js");
const R = COPY.runs;

it("offers Done and Cancel, each posting to the run", async () => {
  let reloaded = 0;
  const m = mount(WaitingActions as never, { runId: "run-1", reload: () => reloaded++ } as never);
  expect(text(m.tree)).toContain(R.waitingSay);
  const button = (label: string) =>
    all(m.tree).find((e) => e.type === "button" && text(e.props.children) === label)!;
  (button(R.done).props.onClick as () => void)();
  await new Promise((r) => setTimeout(r, 0));
  (button(R.cancel).props.onClick as () => void)();
  await new Promise((r) => setTimeout(r, 0));
  expect(posted).toEqual(["/api/runs/run-1/done", "/api/runs/run-1/cancel"]);
  expect(reloaded).toBe(2);
});
