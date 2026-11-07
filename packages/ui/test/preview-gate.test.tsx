import { describe, expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * A person approves every write (CLAUDE.md, rule 6): on the canvas's forms the write is of what
 * was previewed. A change after Preview turns the write off until it is previewed again.
 */

vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});

const { Pairing } = await import("../src/screens/architecture/Connect.js");
const { AddBoxForm } = await import("../src/screens/architecture/Declare.js");
const { OwnerForm } = await import("../src/screens/architecture/Owner.js");

const flush = () => new Promise((r) => setTimeout(r, 0));
const button = (tree: unknown, label: string) =>
  all(tree).find((e) => e.type === "button" && text(e.props.children) === label)!;
const click = async (m: { tree: unknown; render(): void }, label: string) => {
  (button(m.tree, label).props.onClick as () => void)();
  await flush();
  m.render();
};

describe("a write is of what was previewed", () => {
  it("Connect: a call unticked after Preview turns Confirm off until previewed again", async () => {
    const call = (fact: string, api: string) => ({
      fact,
      callType: "rest",
      method: "GET",
      path: `/${fact}`,
      at: "x:1",
      status: "left",
      suggestion: { api, score: 0.9, why: "same-path" },
      confident: true,
    });
    const view = {
      from: "forge-billing",
      to: { repo: "gw" },
      toName: "gw",
      calls: [call("a", "e1"), call("b", "e2")],
      apis: [
        { id: "e1", kind: "route", path: "/a" },
        { id: "e2", kind: "route", path: "/b" },
      ],
    };
    const sent: { pairs: unknown[]; preview?: boolean }[] = [];
    const m = mount(
      Pairing as never,
      {
        from: "forge-billing",
        box: { repo: "gw" },
        cands: { state: "ready", data: view },
        post: async (b: { pairs: unknown[] }) => {
          sent.push(b);
          return { file: "f", lines: ["l"], verify: "v", commit: "c" };
        },
      } as never,
    );
    await click(m, "Preview");
    const confirm = () => all(m.tree).find((e) => e.props.className === "btn primary")!;
    expect(confirm().props.disabled).toBe(false);
    const boxes = all(m.tree).filter((e) => e.type === "input" && e.props.type === "checkbox");
    (boxes[1]!.props.onChange as (e: unknown) => void)({ target: { checked: false } });
    m.render();
    expect(confirm().props.disabled).toBe(true);
    await click(m, "Preview");
    (confirm().props.onClick as () => void)();
    await flush();
    expect(sent.map((s) => s.pairs.length)).toEqual([2, 1, 1]);
  });

  it("Add to the picture: a rename after Preview turns Add it off", async () => {
    const m = mount(
      AddBoxForm as never,
      {
        of: { state: "ready", data: { repos: [], systems: [], teams: [] } },
        onClose: () => undefined,
        post: async () => ({ files: [], verify: "v", commit: "c" }),
      } as never,
    );
    const field = (n: number) => all(m.tree).filter((e) => e.type === "input")[n]!;
    const type = (n: number, value: string) => {
      (field(n).props.onChange as (e: unknown) => void)({ target: { value } });
      m.render();
    };
    type(0, "harbor-audit");
    type(1, "Harbor");
    await click(m, "Preview");
    expect(button(m.tree, "Add it").props.disabled).toBe(false);
    type(0, "other-thing");
    expect(button(m.tree, "Add it").props.disabled).toBe(true);
  });

  it("Owner: a new team's id typed after Preview turns Write it off", async () => {
    const m = mount(
      OwnerForm as never,
      {
        repo: "forge-billing",
        view: {
          state: "ready",
          data: {
            repo: "forge-billing",
            file: "m.yaml",
            owner: "t1",
            teams: [{ id: "t1", name: "t1" }],
            systems: [],
          },
        },
        onClose: () => undefined,
        put: async () => ({ files: [], verify: "v", commit: "c" }),
      } as never,
    );
    (all(m.tree).filter((e) => e.type === "select")[0]!.props.onChange as (e: unknown) => void)({
      target: { value: "\u0000add" },
    });
    m.render();
    const field = (n: number) => all(m.tree).filter((e) => e.type === "input")[n]!;
    const type = (n: number, value: string) => {
      (field(n).props.onChange as (e: unknown) => void)({ target: { value } });
      m.render();
    };
    type(0, "team-a");
    type(1, "Team A");
    await click(m, "Preview");
    expect(button(m.tree, "Write it").props.disabled).toBe(false);
    type(0, "team-b");
    expect(button(m.tree, "Write it").props.disabled).toBe(true);
  });
});
