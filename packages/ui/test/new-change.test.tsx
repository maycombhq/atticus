import { expect, it, vi } from "vitest";
import { all, mount } from "./support/hooks.js";

/** UX review: a change starts in the app, with a title, an id from it and a type. */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const posted: { path: string; body: unknown }[] = [];
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useApi: (path?: string) =>
    path
      ? {
          state: "ready",
          data: [
            { id: "feature", name: "Feature" },
            { id: "fix", name: "Fix" },
          ],
          reload: () => undefined,
        }
      : { state: "loading", reload: () => undefined },
  api: async (path: string, o: { body: unknown }) => {
    posted.push({ path, body: o.body });
    return {};
  },
}));
const { COPY } = await import("../src/copy.js");
const { NewChange, changeIdOf } = await import("../src/screens/work/NewChange.js");

it("makes an id from the title", () => {
  expect(changeIdOf("Raise the daily transfer limit!")).toBe("raise-the-daily-transfer-limit");
});

it("starts the change with its title, id and the first type", async () => {
  const made: string[] = [];
  const m = mount(
    NewChange as never,
    { open: true, onCreated: (id: string) => made.push(id) } as never,
  );
  const title = all(m.tree).find(
    (e) => e.type === "input" && e.props.placeholder === COPY.newChange.titleHint,
  )!;
  (title.props.onChange as (e: unknown) => void)({ target: { value: "Raise the limit" } });
  m.render();
  const form = all(m.tree).find((e) => e.type === "form")!;
  (form.props.onSubmit as (e: unknown) => void)({ preventDefault: () => undefined });
  await new Promise((r) => setTimeout(r, 0));
  expect(posted).toEqual([
    {
      path: "/api/changes",
      body: { id: "raise-the-limit", title: "Raise the limit", type: "feature" },
    },
  ]);
  expect(made).toEqual(["raise-the-limit"]);
});
