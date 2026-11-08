import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/** UX review: Raise hand-off waits until nothing blocks the gate, and says why. */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
let blockers: { message: string }[] = [];
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useApi: (path: string) => ({
    state: "ready",
    data: path.endsWith("/status")
      ? { state: "plan", phase: "plan", blockers, reasons: [], next: "build" }
      : { id: "c1", title: "C1", type: "feature", state: "plan" },
    reload: () => undefined,
  }),
  useLiveEvents: () => undefined,
}));
const { COPY } = await import("../src/copy.js");
const { GateHeader } = await import("../src/screens/know/Phase.js");
const T = COPY.phase;

const raise = () => {
  const m = mount(
    GateHeader as never,
    {
      part: "gate",
      id: "c1",
      title: "C1",
      picker: null,
      reload: () => undefined,
    } as never,
  );
  // The gate is a View: open its render prop by hand.
  const v = all(m.tree).find((e) => typeof e.props.children === "function" && "of" in e.props)!;
  const inner = (v.props.children as (d: unknown) => unknown)(
    (v.props.of as { data: unknown }).data,
  );
  return all(inner).find((e) => e.type === "button" && text(e.props.children) === T.raiseHandOff)!;
};

it("is held while something blocks, with how many, and offered when nothing does", () => {
  blockers = [{ message: "a" }, { message: "b" }];
  const held = raise();
  expect(held.props.disabled).toBe(true);
  expect(held.props.title).toBe(T.blockedBy(2));
  blockers = [];
  expect(raise().props.disabled).toBe(false);
});
