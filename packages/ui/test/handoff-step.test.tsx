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
    // Review of beta.23: a read of a repo this machine has no clone of.
    const args = (o.body as { args?: string[] }).args ?? [];
    if (args[1] === "forge-gateway") {
      const { ApiError } =
        await vi.importActual<typeof import("../src/api/client.js")>("../src/api/client.js");
      throw new ApiError({
        type: "about:blank",
        title: "The step wasn't prepared",
        status: 422,
        detail: "No checkout of forge-gateway on this machine: Sync the repos to clone it.",
        next: { step: "sync", repos: ["forge-gateway"] },
      });
    }
    return { runId: "run-9" };
  },
}));
const { COPY } = await import("../src/copy.js");
const { HandoffStep } = await import("../src/app/runstep.js");
const { SyncFirst } = await import("../src/app/sync-first.js");

it("offers Sync the repos when the repo to read has no clone here", async () => {
  const m = mount(HandoffStep as never, { args: ["map", "forge-gateway"] } as never);
  const b = all(m.tree).find((e) => e.type === "button")!;
  (b.props.onClick as () => void)();
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  posted.length = 0;
  m.render();
  const sync = all(m.tree).find((e) => e.type === SyncFirst);
  expect(sync?.props.repos).toEqual(["forge-gateway"]);
  expect(text(m.tree)).not.toContain("atticus workspace sync");
});
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
