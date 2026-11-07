import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * ADR 0179: a change drawn on the canvas. The form says a stroke; Preview shows the lines it
 * writes; Draw it writes only what was previewed; Undo takes a stroke back. A person approves
 * every write (CLAUDE.md, rule 6).
 */

vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});

const { COPY } = await import("../src/copy.js");
const { EMPTY_FORM, SketchForm, strokeOf } = await import("../src/screens/work/Sketch.js");
const S = COPY.sketch;

const un = (h: string) =>
  h
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const flush = () => new Promise((r) => setTimeout(r, 0));
const button = (tree: unknown, label: string) =>
  all(tree).find((e) => e.type === "button" && text(e.props.children) === label)!;
const click = async (m: { tree: unknown; render(): void }, label: string) => {
  (button(m.tree, label).props.onClick as () => void)();
  await flush();
  m.render();
};
const inputs = (tree: unknown) =>
  all(tree).filter(
    (e) => e.type === "input" && e.props.type !== "radio" && e.props.type !== "checkbox",
  );
const type = (m: { tree: unknown; render(): void }, n: number, v: string) => {
  (inputs(m.tree)[n]!.props.onChange as (e: unknown) => void)({ target: { value: v } });
  m.render();
};

describe("the form says a stroke", () => {
  it("a call from a component to another's API, or what is missing", () => {
    expect(strokeOf({ ...EMPTY_FORM, component: "forge-orders" })).toEqual({
      missing: S.missing.to,
    });
    expect(
      strokeOf({
        ...EMPTY_FORM,
        component: " forge-orders ",
        toComponent: "northwind-pay",
        toEntry: "POST /v1/screenings",
        toNew: true,
        what: "Screens the order.",
      }),
    ).toEqual({
      stroke: {
        kind: "call",
        from: { component: "forge-orders" },
        to: { component: "northwind-pay", entry: "POST /v1/screenings", new: true },
        what: "Screens the order.",
      },
    });
  });

  it("a new flow gets an id from its name; a step taken out needs the step and why", () => {
    const r = strokeOf({
      ...EMPTY_FORM,
      kind: "table",
      component: "forge-fraud",
      newFlow: true,
      newName: "An order is screened",
      triggerWhat: "POST /screen is called",
      op: "write",
      table: "forge-fraud-db.verdicts",
      columns: "verdict, score",
      tableNew: true,
    });
    expect(r).toEqual({
      stroke: {
        kind: "table",
        from: {
          component: "forge-fraud",
          newFlow: {
            id: "forge-fraud.an-order-is-screened",
            name: "An order is screened",
            trigger: { kind: "endpoint", what: "POST /screen is called" },
          },
        },
        op: "write",
        table: "forge-fraud-db.verdicts",
        columns: ["verdict", "score"],
        new: true,
      },
    });
    expect(strokeOf({ ...EMPTY_FORM, kind: "remove", flow: "f", step: "0" })).toEqual({
      missing: S.missing.step,
    });
    expect(strokeOf({ ...EMPTY_FORM, kind: "remove", flow: "f", step: "2" })).toEqual({
      missing: S.missing.why,
    });
    expect(
      strokeOf({
        ...EMPTY_FORM,
        kind: "retarget",
        flow: "forge-orders.place-order",
        step: "2",
        toComponent: "forge-inventory",
        toEntry: "POST /holds",
        why: "Inventory takes over.",
      }),
    ).toMatchObject({ stroke: { kind: "retarget", step: 2, to: { new: false } } });
  });
});

describe("the panel", () => {
  it("names each stroke kind, lists the strokes drawn with Undo, and offers the stage for the rest", () => {
    const out = un(
      renderToStaticMarkup(
        <SketchForm
          change="add-fraud-check"
          drawn={[
            {
              flow: "forge-orders.place-order",
              index: 0,
              what: "call-out → northwind-pay POST /v1/screenings",
            },
          ]}
          commit="git commit"
          post={async () => ({ written: false, files: [], drawn: [], commit: "" })}
        />,
      ),
    );
    expect(out).toContain(S.title);
    expect(out).toContain(S.intro);
    for (const k of Object.values(S.kinds)) expect(out).toContain(k);
    expect(out).toContain("call-out → northwind-pay POST /v1/screenings");
    expect(out).toContain(`>${S.undo}<`);
    expect(out).toContain("atticus change architecture add-fraud-check");
    expect(out).not.toContain(S.drawnNone);
  });

  it("Draw it is off until Preview, off again after a change, and writes what was previewed", async () => {
    const sent: { stroke: { kind: string }; preview?: boolean }[] = [];
    const m = mount(
      SketchForm as never,
      {
        change: "add-fraud-check",
        drawn: [],
        post: async (b: { stroke: { kind: string }; preview?: boolean }) => {
          sent.push(b);
          return {
            written: !b.preview,
            files: [
              {
                file: "openspec/changes/add-fraud-check/target-flows/f.yaml",
                changes: [{ now: "+ line" }],
              },
            ],
            drawn: [{ flow: "forge-orders.place-order", index: 0, what: "call-out → x" }],
            commit: "git commit",
          };
        },
      } as never,
    );
    const draw = () => all(m.tree).find((e) => e.props.className === "btn primary")!;
    expect(draw().props.disabled).toBe(true);
    // Preview with nothing said: told what's missing, nothing sent.
    await click(m, S.preview);
    expect(sent).toEqual([]);
    expect(all(m.tree).some((e) => e.props.role === "alert" && text(e) === S.missing.from)).toBe(
      true,
    );
    type(m, 0, "forge-orders");
    type(m, 2, "northwind-pay");
    type(m, 3, "POST /v1/screenings");
    await click(m, S.preview);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ stroke: { kind: "call" }, preview: true });
    expect(draw().props.disabled).toBe(false);
    const diff = all(m.tree).find((e) => typeof e.type === "function" && e.type.name === "Diff")!;
    expect((diff.props.r as { files: { changes: unknown[] }[] }).files[0]!.changes).toEqual([
      { now: "+ line" },
    ]);
    // A change after Preview: previewed again before it writes.
    type(m, 3, "POST /v2/screenings");
    expect(draw().props.disabled).toBe(true);
    await click(m, S.preview);
    await click(m, S.draw);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({
      stroke: { kind: "call", to: { entry: "POST /v2/screenings" } },
    });
    expect(sent[2]!.preview).toBeUndefined();
    expect(text(m.tree)).toContain(S.written);
    expect(text(m.tree)).toContain("call-out → x");
    // Undo sends the stroke back by flow and index.
    await click(m, S.undo);
    expect(sent[3]).toEqual({
      stroke: { kind: "undo", flow: "forge-orders.place-order", index: 0 },
    });
  });

  it("a failed write turns Draw it off until the stroke is previewed again, and sends the preview's fingerprint", async () => {
    let fail = false;
    const sent: { expect?: string; preview?: boolean }[] = [];
    const m = mount(
      SketchForm as never,
      {
        change: "c",
        drawn: [],
        post: async (b: { expect?: string; preview?: boolean }) => {
          sent.push(b);
          if (fail && !b.preview) throw new Error("c's target flows changed since the preview");
          return { written: !b.preview, files: [], drawn: [], commit: "", fingerprint: "abc" };
        },
      } as never,
    );
    type(m, 0, "forge-orders");
    type(m, 2, "northwind-pay");
    type(m, 3, "POST /v1/screenings");
    await click(m, S.preview);
    const draw = () => all(m.tree).find((e) => e.props.className === "btn primary")!;
    expect(draw().props.disabled).toBe(false);
    fail = true;
    await click(m, S.draw);
    expect(sent[1]).toMatchObject({ expect: "abc" });
    expect(
      all(m.tree).some((e) => e.props.role === "alert" && text(e).includes("changed since")),
    ).toBe(true);
    expect(draw().props.disabled).toBe(true);
  });

  it("a problem from the server is said and keeps Draw it off; the flows to pick from become a select", async () => {
    const m = mount(
      SketchForm as never,
      {
        change: "c",
        drawn: [],
        post: async () => ({
          written: false,
          files: [],
          problem: "forge-stock has 2 flows: say which the stroke is on.",
          pick: {
            flows: [
              { id: "forge-stock.reserve", name: "Reserve" },
              { id: "forge-stock.release", name: "Release" },
            ],
          },
          drawn: [],
          commit: "",
        }),
      } as never,
    );
    type(m, 0, "forge-stock");
    type(m, 2, "forge-orders");
    type(m, 3, "GET /orders/{id}");
    await click(m, S.preview);
    expect(text(m.tree)).toContain("forge-stock has 2 flows");
    expect(all(m.tree).find((e) => e.props.className === "btn primary")!.props.disabled).toBe(true);
    const sel = () => all(m.tree).find((e) => e.type === "select")!;
    expect(all(sel().props.children).map((o) => o.props.value)).toEqual([
      "",
      "forge-stock.reserve",
      "forge-stock.release",
    ]);
    // Picking a flow keeps the select (the problem is cleared, the choice stays).
    (sel().props.onChange as (e: unknown) => void)({ target: { value: "forge-stock.reserve" } });
    m.render();
    expect(sel().props.value).toBe("forge-stock.reserve");
    expect(all(m.tree).some((e) => e.props.role === "alert")).toBe(false);
  });
});
