import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * UX review: an initiative starts, is planned and has its commitments recorded in the app, and
 * each save offers Propose for review (ADR 0183). The command stays beside it.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const posted: { path: string; body: unknown }[] = [];
let list: { state: string; data?: unknown; error?: string } = { state: "ready", data: [] };
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useApi: () => ({ ...list, reload: () => undefined }),
  useLiveEvents: () => undefined,
  api: async (path: string, o: { body: unknown }) => {
    posted.push({ path, body: o.body });
    return path === "/api/initiatives"
      ? { initiative: "northwind-pay-v3-migration", lines: ["Started"] }
      : { lines: ["ok"] };
  },
}));
const { COPY } = await import("../src/copy.js");
const { NewInitiative, PlanInitiative, CommitmentState } =
  await import("../src/screens/know/InitiativeForms.js");
const { Initiatives } = await import("../src/screens/know/Design.js");
const { Propose } = await import("../src/app/propose.js");
const T = COPY.design;
const tick = () => new Promise((r) => setTimeout(r, 0));
type El = { type: unknown; props: Record<string, unknown> };
const field = (tree: unknown, id: string) =>
  all(tree).find(
    (e) =>
      (e.type === "input" || e.type === "select" || e.type === "textarea") && e.props.id === id,
  ) as El;
const labelled = (tree: unknown) =>
  all(tree)
    .filter((e) => e.type === "input" || e.type === "select" || e.type === "textarea")
    .every((e) => all(tree).some((l) => l.type === "label" && l.props.htmlFor === e.props.id));
const submit = (tree: unknown) =>
  (all(tree).find((e) => e.type === "form")!.props.onSubmit as (e: unknown) => void)({
    preventDefault: () => undefined,
  });
const change = (el: El, value: string) =>
  (el.props.onChange as (e: unknown) => void)({ target: { value } });

it("starts an initiative with its title, id, journey and release, then offers to propose it", async () => {
  posted.length = 0;
  const made: string[] = [];
  const m = mount(
    NewInitiative as never,
    { open: true, onCreated: (id: string) => made.push(id) } as never,
  );
  expect(labelled(m.tree)).toBe(true);
  change(field(m.tree, "id-title"), "Northwind Pay v3 migration");
  m.render();
  change(field(m.tree, "id-journey"), "vendor-api-change");
  change(field(m.tree, "id-release"), "2027-03-01");
  m.render();
  expect(field(m.tree, "id-id").props.value).toBe("northwind-pay-v3-migration");
  submit(m.tree);
  await tick();
  m.render();
  expect(posted).toEqual([
    {
      path: "/api/initiatives",
      body: {
        title: "Northwind Pay v3 migration",
        id: "northwind-pay-v3-migration",
        journey: "vendor-api-change",
        release: "2027-03-01",
      },
    },
  ]);
  expect(made).toEqual(["northwind-pay-v3-migration"]);
  expect(all(m.tree).some((e) => e.type === Propose && e.props.scope === "initiatives")).toBe(true);
});

it("plans an initiative from the system it is about", async () => {
  posted.length = 0;
  const m = mount(
    PlanInitiative as never,
    { initiative: "pay-v3", onSaved: () => undefined } as never,
  );
  expect(labelled(m.tree)).toBe(true);
  change(field(m.tree, "id-target"), "northwind-pay");
  change(field(m.tree, "id-systems"), "ledger, gateway");
  m.render();
  submit(m.tree);
  await tick();
  m.render();
  expect(posted).toEqual([
    {
      path: "/api/initiatives/pay-v3/plan",
      body: { target: "northwind-pay", systems: ["ledger", "gateway"] },
    },
  ]);
  expect(all(m.tree).some((e) => e.type === Propose && e.props.scope === "initiatives")).toBe(true);
});

it("records a commitment's state with a note, and shows the command as the alternative", async () => {
  posted.length = 0;
  const m = mount(
    CommitmentState as never,
    {
      commitment: { id: "pay-v3.vendor-spec", what: "Vendor spec", recorded: "open" },
      onSaved: () => undefined,
    } as never,
  );
  expect(labelled(m.tree)).toBe(true);
  expect(text(m.tree)).toContain(T.commitCommand("pay-v3.vendor-spec"));
  const state = field(m.tree, "id-state");
  expect(all(state.props.children).map((o) => o.props.value)).toEqual([
    "open",
    "at-risk",
    "done",
    "slipped",
  ]);
  change(state, "slipped");
  change(field(m.tree, "id-note"), "The vendor missed the date.");
  m.render();
  submit(m.tree);
  await tick();
  m.render();
  expect(posted).toEqual([
    {
      path: "/api/commitments/pay-v3.vendor-spec/status",
      body: { status: "slipped", note: "The vendor missed the date." },
    },
  ]);
  const note = all(m.tree).find((e) => e.props.note !== undefined)!.props.note as { text: string };
  expect(note.text).toBe(T.recorded("pay-v3.vendor-spec", T.commitmentStates.slipped!));
  expect(all(m.tree).some((e) => e.type === Propose && e.props.scope === "initiatives")).toBe(true);
});

it("offers New initiative on the Initiatives page, empty or not", () => {
  list = { state: "ready", data: [] };
  const m = mount(Initiatives as never, { hash: "#/initiatives" } as never);
  expect(all(m.tree).some((e) => e.type === NewInitiative)).toBe(true);
});
