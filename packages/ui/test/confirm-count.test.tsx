import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * ADR 0195 point 4 (ticket CS3): a confirm step changes nothing until it is confirmed, and it
 * confirms exactly the count it listed: Remove stays off until the count shown is typed, a wrong
 * count is said and sends nothing, and only the right one runs the step, once. Dismiss on the
 * cross-check runs its command only on its press.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
vi.mock("../src/api/client.js", () => ({
  api: () => Promise.reject(new Error("no call")),
  ApiError: class extends Error {},
  useApi: () => ({ state: "loading" }),
  useReloadOnFiles: () => undefined,
}));
const { ConfirmDialog } = await import("../src/screens/setup/CatalogBuild.js");
const { COPY } = await import("../src/copy.js");
const B = COPY.catalogBuild;
const tick = () => new Promise((r) => setTimeout(r, 0));

it("runs a removal's confirm only with the count it listed", async () => {
  const ran: number[] = [];
  const m = mount(
    ConfirmDialog as never,
    {
      title: B.removalsTitle(37),
      intro: B.removalsIntro,
      confirm: B.confirmRemove(37),
      count: 37,
      onConfirm: async () => {
        ran.push(37);
      },
      onClose: () => undefined,
      children: "the list",
    } as never,
  );
  const yes = () =>
    all(m.tree).find((e) => e.type === "button" && text(e) === B.confirmRemove(37))!;
  const box = () => all(m.tree).find((e) => e.type === "input")!;
  expect(yes().props.disabled).toBe(true);
  expect(all(m.tree).find((e) => e.props.role === "dialog")!.props["aria-modal"]).toBe("true");
  (box().props.onChange as (e: unknown) => void)({ target: { value: "36" } });
  m.render();
  expect(yes().props.disabled).toBe(true);
  // Enter on a wrong count says so, and runs nothing.
  (box().props.onKeyDown as (e: unknown) => void)({ key: "Enter" });
  await tick();
  m.render();
  expect(ran).toEqual([]);
  expect(text(m.tree)).toContain(B.countWrong(37));
  (box().props.onChange as (e: unknown) => void)({ target: { value: "37" } });
  m.render();
  expect(yes().props.disabled).toBe(false);
  (yes().props.onClick as () => void)();
  await tick();
  expect(ran).toEqual([37]);
});

it("says why a confirmed step stopped, and stays open to try again", async () => {
  const m = mount(
    ConfirmDialog as never,
    {
      title: B.pruneConfirmTitle(1),
      intro: B.pruneConfirmIntro,
      confirm: B.confirmPrune(1),
      onConfirm: () =>
        Promise.reject(new Error("The page listed 1 file to remove; there are 2 now.")),
      onClose: () => undefined,
      children: "the list",
    } as never,
  );
  const yes = all(m.tree).find((e) => e.type === "button" && text(e) === B.confirmPrune(1))!;
  expect(yes.props.disabled).toBe(false);
  (yes.props.onClick as () => void)();
  await tick();
  await tick();
  m.render();
  expect(text(m.tree)).toContain(B.failed("The page listed 1 file to remove; there are 2 now."));
  expect(all(m.tree).some((e) => e.props.role === "dialog")).toBe(true);
});

// The review (S4): an undo or a prune has no count to type, so Enter on the first focus must
// never confirm it: the focus starts on Cancel; with a count, on the field to type it in.
it("starts the focus on Cancel when there is no count to type, else on the count field", () => {
  const first = (count?: number) => {
    const m = mount(
      ConfirmDialog as never,
      {
        title: B.pruneConfirmTitle(1),
        intro: B.pruneConfirmIntro,
        confirm: B.confirmPrune(1),
        ...(count !== undefined ? { count } : {}),
        onConfirm: async () => undefined,
        onClose: () => undefined,
        children: "the list",
      } as never,
    );
    return all(m.tree).filter((e) => e.props["data-first-focus"]);
  };
  const none = first();
  expect(none).toHaveLength(1);
  expect(none[0]!.type).toBe("button");
  expect(text(none[0])).toBe(B.cancel);
  const counted = first(3);
  expect(counted).toHaveLength(1);
  expect(counted[0]!.type).toBe("input");
});
