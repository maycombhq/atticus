import { expect, it, vi } from "vitest";
import { all, mount } from "./support/hooks.js";

/**
 * UX review: an outcome measured after release is recorded on the Release screen (POST
 * /api/release/{id}/outcomes, the same as `atticus outcome record`), then proposed for review.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const posted: { path: string; body: unknown }[] = [];
const OUTCOMES = {
  measures: [
    {
      id: "no-over-limit",
      n: 1,
      measure: "No transfer over a limit",
      source: "brief.md",
      values: [],
    },
  ],
  orphans: [],
  canRecord: true,
  gaps: [],
};
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useApi: (path: string) => ({
    state: "ready",
    data: path.startsWith("/api/outcomes") ? OUTCOMES : { user: "pat" },
    reload: () => undefined,
  }),
  api: async (path: string, o: { body: unknown }) => {
    posted.push({ path, body: o.body });
    return { lines: [] };
  },
}));
const { OutcomesPanel } = await import("../src/screens/run/ReleaseViews.js");
const { View } = await import("../src/app/ui.js");
const { Propose } = await import("../src/app/propose.js");
const tick = () => new Promise((r) => setTimeout(r, 0));

it("records an outcome as the signed-in person and offers to propose it", async () => {
  const m = mount(OutcomesPanel as never, { id: "add-transfer-limit", tick: 0 } as never);
  const body = () => {
    const v = all(m.tree).find((e) => e.type === View)!;
    return (v.props.children as (d: unknown) => unknown)(OUTCOMES);
  };
  const byId = (id: string) => all(body()).find((e) => e.props.id === id)!;
  (byId("om-add-transfer-limit").props.onChange as (e: unknown) => void)({
    target: { value: "no-over-limit" },
  });
  (byId("ov-add-transfer-limit").props.onChange as (e: unknown) => void)({
    target: { value: "None in October" },
  });
  m.render();
  expect(all(body()).some((e) => e.type === Propose)).toBe(false);
  const form = all(body()).find((e) => e.type === "form")!;
  (form.props.onSubmit as (e: unknown) => void)({ preventDefault: () => undefined });
  await tick();
  m.render();
  expect(posted).toEqual([
    {
      path: "/api/release/add-transfer-limit/outcomes",
      body: { measure: "no-over-limit", value: "None in October" },
    },
  ]);
  expect(all(body()).some((e) => e.type === Propose && e.props.scope === "outcomes")).toBe(true);
});
