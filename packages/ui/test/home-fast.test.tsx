import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * beta.23, "Home loads fast": Home's checklist shows the machine's step as checking while its
 * checks run (the server no longer waits for them), and waits for them on its own; a burst of
 * file events reloads the catalog's panels only when the catalog may have changed.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
let reloads = 0;
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useApi: () => ({
    state: "ready",
    data: {
      baselined: false,
      steps: [
        {
          id: "machine",
          label: "This machine has what Atticus needs",
          done: false,
          checking: true,
          detail: "checking this machine (Git, OpenSpec, your assistant)",
        },
        { id: "repos", label: "Repos are listed", done: true, detail: "40 repos" },
      ],
    },
    reload: () => reloads++,
  }),
  useLiveEvents: () => undefined,
  useFileChanges: () => undefined,
}));
const { COPY } = await import("../src/copy.js");
const { SetupChecklist } = await import("../src/screens/CommandCenter.js");
const { catalogMayHaveChanged } = await import("../src/api/client.js");

it("shows the machine's step as checking, and waits for the checks apart from the rest", () => {
  const m = mount(SetupChecklist as never, {} as never);
  const t = text(m.tree);
  expect(t).toContain("This machine has what Atticus needs");
  expect(t).toContain(COPY.commandCenter.checking);
  expect(t).toContain("…");
  expect(t).not.toContain(`This machine has what Atticus needs${COPY.commandCenter.toDo}`);
  const waits = all(m.tree).filter(
    (e) =>
      typeof e.type === "function" && (e.type as { name?: string }).name === "WhenMachineChecked",
  );
  expect(waits).toHaveLength(1);
  (waits[0]!.props.onDone as () => void)();
  expect(reloads).toBe(1);
});

it("reloads the catalog's panels only for a burst that can change the catalog", () => {
  const f = (path?: string) => ({ type: "file.changed", ...(path ? { path } : {}) });
  expect(catalogMayHaveChanged([f("questions/q-1.yaml"), f(".atticus/me.yaml")])).toBe(false);
  expect(catalogMayHaveChanged([{ type: "run.changed", runId: "r", state: "done" }])).toBe(false);
  expect(catalogMayHaveChanged([f("questions/q-1.yaml"), f("catalog/generated/system")])).toBe(
    true,
  );
  expect(catalogMayHaveChanged([f("kb/catalog/curated/x.yaml")])).toBe(true);
  expect(catalogMayHaveChanged([f("org-pack/sources.yaml")])).toBe(true);
  // A top folder (many files at once) or no path at all: it may be.
  expect(catalogMayHaveChanged([f("kb")])).toBe(true);
  expect(catalogMayHaveChanged([f()])).toBe(true);
  expect(catalogMayHaveChanged([{ type: "index.rebuilt", records: 3 }])).toBe(true);
});

it("follows the layout the server names: a file it tags `catalog` is the catalog's", () => {
  const f = (path: string, catalog: boolean) => ({ type: "file.changed", path, catalog });
  expect(catalogMayHaveChanged([f("estate/records/generated/Service/pay.yaml", true)])).toBe(true);
  expect(catalogMayHaveChanged([f("catalog/generated/Service/pay.yaml", false)])).toBe(false);
  expect(catalogMayHaveChanged([f("questions/q-1.yaml", false), f("estate", true)])).toBe(true);
});
