import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * Round 36 (UX review): Compare a prototype from the app. The page lists the repos the manifest
 * types prototype; Compare runs what `atticus change attach <change> --prototype <repo>` runs
 * (POST /api/changes/{id}/prototypes) and says what it printed. Invented Forge names only.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const calls: { path: string; method?: string; body?: unknown }[] = [];
let answer: () => unknown = () => ({
  prototypes: [],
  candidates: [],
  lines: ["Attached inputs/prototype-forge-checkout-prototype.md."],
});
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  api: async (path: string, o?: { method?: string; body?: unknown }) => {
    calls.push({
      path,
      ...(o?.method ? { method: o.method } : {}),
      ...(o?.body ? { body: o.body } : {}),
    });
    return answer();
  },
}));
const { COPY } = await import("../src/copy.js");
const { ComparePrototype } = await import("../src/screens/ChangePrototypes.js");
const { Note } = await import("../src/screens/know/common.js");
const T = COPY.changes;
const tick = () => new Promise((r) => setTimeout(r, 0));

it("compares the picked prototype and says what the command printed", async () => {
  let done = 0;
  const m = mount(
    ComparePrototype as never,
    {
      change: "loyalty-at-checkout",
      candidates: ["forge-checkout-prototype", "forge-kiosk-prototype"],
      onDone: () => done++,
    } as never,
  );
  const select = all(m.tree).find((e) => e.type === "select")!;
  const label = all(m.tree).find((e) => e.type === "label")!;
  expect(label.props.htmlFor).toBe(select.props.id);
  expect(text(label.props.children)).toBe(T.prototypePick);
  (select.props.onChange as (e: unknown) => void)({
    target: { value: "forge-kiosk-prototype" },
  });
  m.render();
  const btn = all(m.tree).find((e) => e.type === "button")!;
  expect(text(btn.props.children)).toBe(T.prototypeCompare);
  (btn.props.onClick as () => void)();
  await tick();
  m.render();
  expect(calls).toEqual([
    {
      path: "/api/changes/loyalty-at-checkout/prototypes",
      method: "POST",
      body: { repo: "forge-kiosk-prototype" },
    },
  ]);
  expect(done).toBe(1);
  const note = all(m.tree).find((e) => e.type === Note)!;
  expect(note.props.note).toEqual({
    ok: true,
    text: "Attached inputs/prototype-forge-checkout-prototype.md.",
  });
});

it("says the refusal in the command's words", async () => {
  calls.length = 0;
  const { ApiError } = await import("../src/api/client.js");
  answer = () => {
    throw new ApiError({
      type: "about:blank",
      title: "Atticus can't do that yet",
      status: 422,
      detail: "forge-checkout-prototype has no verified facts yet.",
    });
  };
  const m = mount(
    ComparePrototype as never,
    { change: "c1", candidates: ["forge-checkout-prototype"], onDone: () => undefined } as never,
  );
  (all(m.tree).find((e) => e.type === "button")!.props.onClick as () => void)();
  await tick();
  m.render();
  const note = all(m.tree).find((e) => e.type === Note)!;
  expect(note.props.note).toMatchObject({ ok: false });
  expect(String((note.props.note as { text: string }).text)).toContain("no verified facts yet");
});

it("says how to type a repo as a prototype when the manifest has none", () => {
  const m = mount(
    ComparePrototype as never,
    { change: "c1", candidates: [], onDone: () => undefined } as never,
  );
  expect(text(m.tree)).toContain(T.prototypeNoCandidates);
  expect(all(m.tree).some((e) => e.type === "button")).toBe(false);
});
