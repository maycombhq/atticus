import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/** UX review: a waiting run is finished (Done) or cancelled on its own page, no terminal. */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const posted: string[] = [];
let nextAnswer: unknown = {};
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  api: async (path: string) => {
    posted.push(path);
    return nextAnswer;
  },
}));
const flashed: unknown[] = [];
vi.mock("../src/app/flash.js", () => ({ flash: (f: unknown) => void flashed.push(f) }));
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

it("keeps what Done did, and the next prompt, as a note once the run is validated (round 39)", async () => {
  const m = mount(WaitingActions as never, { runId: "run-2", reload: () => undefined } as never);
  nextAnswer = { lines: ["Wrote proposal.md."], next: "run-3" };
  const done = all(m.tree).find((e) => e.type === "button" && text(e.props.children) === R.done)!;
  (done.props.onClick as () => void)();
  await new Promise((r) => setTimeout(r, 0));
  expect(flashed).toEqual([
    { text: "Wrote proposal.md.", href: "#/runs?run=run-3", link: R.nextPrompt },
  ]);
});
