import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * The map's own bar (beta.23): corrections drawn on the map and not yet applied show above it,
 * with one Apply for every corrected repo, and it is read again after every write the app makes.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
let applyFirst: string[] | undefined = [];
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useApi: () => ({
    state: "ready",
    data: {
      scope: "work",
      files: [],
      branch: "b",
      title: "t",
      ...(applyFirst ? { applyFirst } : {}),
    },
    reload: () => undefined,
  }),
}));
const { COPY } = await import("../src/copy.js");
const { ApplyAll, ApplyAndPropose, CorrectionsToApply } = await import("../src/app/propose.js");
const P = COPY.propose;

it("says nothing when every correction is applied", () => {
  applyFirst = [];
  const m = mount(CorrectionsToApply as never, {} as never);
  expect(m.tree).toBeNull();
});

it("a line drawn between two repos: names both and offers one Apply for them all", () => {
  applyFirst = ["forge-card-vault", "forge-ledger"];
  const m = mount(CorrectionsToApply as never, {} as never);
  expect(text(m.tree)).toContain(P.onMap("forge-card-vault, forge-ledger"));
  expect(all(m.tree).find((e) => e.type === ApplyAll)?.props.noPropose).toBe(true);
  expect(all(m.tree).some((e) => e.type === ApplyAndPropose)).toBe(false);
});

it("one repo corrected: its own Apply", () => {
  applyFirst = ["forge-ledger"];
  const m = mount(CorrectionsToApply as never, {} as never);
  expect(all(m.tree).find((e) => e.type === ApplyAndPropose)?.props.repo).toBe("forge-ledger");
  expect(all(m.tree).some((e) => e.type === ApplyAll)).toBe(false);
});

it("after Apply to every repo's map, says so and where to propose it", () => {
  applyFirst = ["forge-card-vault", "forge-ledger"];
  const m = mount(CorrectionsToApply as never, {} as never);
  (all(m.tree).find((e) => e.type === ApplyAll)!.props.onDone as () => void)();
  applyFirst = [];
  m.render();
  expect(text(m.tree)).toContain(P.onMapApplied);
});
