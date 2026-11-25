import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * ADR 0210 part 7 (review of PR #21): the open items a hand-off goes ahead with, on the change's
 * page, the Phase gate and the Release page: each once, labelled, with an empty state, never
 * holding Raise hand-off.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const ITEM = {
  code: "blocking-finding",
  message: "Blocking finding f1 on the design gate: No retry.",
};
const RELEASE = {
  change: { id: "c1", title: "C1", type: "feature", state: "release-ready", owners: {} },
  status: {
    state: "release-ready",
    nextStep: "",
    risk: { level: "low", score: 1 },
    blockers: [],
    reasons: [],
  },
  openFindings: { blocking: 0, gap: 0, risk: 0, idea: 0 },
  requests: { total: 0, filed: 0, toFile: 0, list: [] },
  repos: [],
  conflicts: [],
  archive: { pass: true, blockers: [], notes: [] },
  evidence: [],
};
let openItems: { code: string; message: string }[] | undefined = [ITEM, ITEM];
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useApi: (path: string) => ({
    state: "ready",
    data: path.startsWith("/api/release/")
      ? RELEASE
      : path.endsWith("/status")
        ? { state: "design", phase: "design", blockers: [], reasons: [], openItems, next: "plan" }
        : /\/(tasks|runs)$|^\/api\/findings/.test(path)
          ? []
          : { id: "c1", title: "C1", type: "feature", state: "design", artifacts: [] },
    reload: () => undefined,
  }),
  useLiveEvents: () => undefined,
}));
const { COPY } = await import("../src/copy.js");
const { OpenItems } = await import("../src/app/open-items.js");
const T = COPY.openItems;
type El = { type: unknown; props: Record<string, unknown> };

const rendered = (items?: { message: string }[], quiet?: boolean) =>
  all(mount(OpenItems as never, { items, ...(quiet ? { quiet } : {}) } as never).tree) as El[];

it("lists each open item once, under a label the list is named by", () => {
  const els = rendered([ITEM, ITEM, { message: "Task 1.1 isn't merged." }]);
  const section = els.find((e) => e.type === "section")!;
  const label = els.find((e) => e.type === "p")!;
  expect(section.props["aria-labelledby"]).toBe(label.props.id);
  expect(text(label.props.children)).toContain(T.title);
  expect(text(label.props.children)).toContain(T.said(2));
  const items = els.filter((e) => e.type === "li");
  expect(items.map((e) => text(e.props.children))).toEqual([
    ITEM.message,
    "Task 1.1 isn't merged.",
  ]);
  expect(els.some((e) => e.type === "button")).toBe(false);
});

it("says none where there are none, unless quiet; shows nothing for a server without the field", () => {
  expect(rendered([]).map((e) => text(e.props.children))).toContain(T.none);
  expect(rendered([], true)).toEqual([]);
  expect(rendered(undefined)).toEqual([]);
});

it("the Phase gate shows them, and Raise hand-off isn't held by them", async () => {
  const { GateHeader, RaiseHandoff } = await import("../src/screens/know/Phase.js");
  openItems = [ITEM];
  const m = mount(
    GateHeader as never,
    { part: "gate", id: "c1", title: "C1", picker: null, reload: () => undefined } as never,
  );
  const v = all(m.tree).find((e) => typeof e.props.children === "function" && "of" in e.props)!;
  const inner = all(
    (v.props.children as (d: unknown) => unknown)((v.props.of as { data: unknown }).data),
  ) as El[];
  expect(inner.find((e) => e.type === OpenItems)?.props.items).toEqual([ITEM]);
  expect(inner.find((e) => e.type === RaiseHandoff)?.props.blockers).toBe(0);
});

it("the Release page shows them in what stops it, which isn't empty for them", async () => {
  const { Detail } = await import("../src/screens/run/Release.js");
  const { View } = await import("../src/app/ui.js");
  const m = mount(Detail as never, { id: "c1" } as never);
  const panel = (all(m.tree) as El[]).find(
    (e) => e.type === View && e.props.emptyText === COPY.release.nothingStopsThisChange,
  )!;
  const data = { status: { blockers: [], reasons: [], openItems: [ITEM] } };
  expect((panel.props.empty as (d: unknown) => boolean)(data)).toBe(false);
  const inner = all((panel.props.children as (d: unknown) => unknown)(data)) as El[];
  expect(inner.find((e) => e.type === OpenItems)?.props.items).toEqual([ITEM]);
  expect(inner.some((e) => e.type === "ul")).toBe(false);
});

it("the change's page shows them beside Raise hand-off, which they don't hold, keyed once each", async () => {
  const { Detail } = await import("../src/screens/Changes.js");
  const { View } = await import("../src/app/ui.js");
  openItems = [ITEM, ITEM];
  const tree = all(mount(Detail as never, { id: "c1" } as never).tree) as El[];
  const summary = tree.find((e) => e.type === View)!;
  const d = { id: "c1", title: "C1", type: "feature", state: "design", artifacts: [] };
  const inner = all((summary.props.children as (x: unknown) => unknown)(d)) as El[];
  const statusView = inner.find((e) => e.type === View)!;
  const s = {
    state: "design",
    phase: "design",
    nextStep: "Ready to raise.",
    risk: { level: "low", score: 1 },
    blockers: [],
    reasons: [],
    openItems,
  };
  const card = all((statusView.props.children as (x: unknown) => unknown)(s)) as El[];
  const list = card.find((e) => e.type === OpenItems)!;
  expect(list.props).toMatchObject({ items: openItems, quiet: true });
  const raise = card.find(
    (e) => e.type === "button" && text(e.props.children).includes(COPY.changes.raiseHandOff),
  )!;
  expect(raise.props.disabled).toBe(false);
  // Each listed once (the component dedupes; keys are by index).
  const lis = (all(mount(OpenItems as never, list.props as never).tree) as El[]).filter(
    (e) => e.type === "li",
  );
  expect(lis).toHaveLength(1);
});
