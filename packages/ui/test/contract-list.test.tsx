import { describe, expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * Review round 31: a large estate's contracts are a page, a count of what is shown, Show more
 * and a filter by id or name, never a silent first 200.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const asked: string[] = [];
vi.mock("../src/api/client.js", async () => {
  const real = await vi.importActual<object>("../src/api/client.js");
  return {
    ...real,
    useApi: (path: string) => {
      asked.push(path);
      return {
        state: "ready",
        data: {
          items: [
            { id: "ledger.get-limit", kind: "Endpoint", confidence: "verified" },
            { id: "ledger.put-limit", kind: "Endpoint", confidence: "inferred" },
          ],
          total: 1240,
          next: "Y3Vyc29y",
        },
        reload: () => undefined,
        refreshing: false,
      };
    },
    useLiveEvents: () => undefined,
    api: async (path: string) => {
      asked.push(path);
      return { items: [{ id: "ledger.zz", kind: "Endpoint" }] };
    },
  };
});
const { COPY } = await import("../src/copy.js");
const { ContractList } = await import("../src/screens/know/Design.js");
const T = COPY.design;
// The hooks runtime renders one component; open the View's render prop by hand.
const inside = (tree: unknown) => {
  const v = all(tree).find((e) => typeof e.props.children === "function" && "of" in e.props)!;
  const of = v.props.of as { data: unknown };
  return (v.props.children as (d: unknown) => unknown)(of.data);
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("a long list of contracts", () => {
  it("says how many it shows of how many, shows more, and filters by id or name", async () => {
    const m = mount(
      ContractList as never,
      { kind: "Endpoint", title: "Endpoints", pick: () => undefined } as never,
    );
    expect(text(inside(m.tree))).toContain(T.showingOf(2, 1240));
    const more = all(inside(m.tree)).find(
      (e) => e.type === "button" && text(e.props.children) === T.showMore,
    )!;
    (more.props.onClick as () => void)();
    await flush();
    m.render();
    expect(asked).toContain("/api/catalog/Endpoint?limit=200&cursor=Y3Vyc29y");
    expect(text(inside(m.tree))).toContain("ledger.zz");
    expect(text(inside(m.tree))).toContain(T.showingOf(3, 1240));
    const field = all(m.tree).find((e) => e.props.id === "contracts-Endpoint-q")!;
    (field.props.onChange as (e: unknown) => void)({ target: { value: "limit" } });
    m.render();
    expect(asked.at(-1)).toBe("/api/catalog/Endpoint?limit=200&q=limit");
  });
});
