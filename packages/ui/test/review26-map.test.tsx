import { afterEach, describe, expect, it, vi } from "vitest";
import { all, mount } from "./support/hooks.js";

/**
 * Beta.26 second review (the map's canvas): a link picked from the keyboard with the details
 * closed opens them in the same render, so its heading can take the focus; the canvas measures
 * its height again when what is above it changes, and fits the picture to that height until the
 * person moves it; Esc closes the tools' drawer from a checkbox, a radio or a select.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useApi: () => ({ state: "loading", reload: () => undefined }),
  useLiveEvents: () => undefined,
  useReloadOnFiles: () => undefined,
}));

const { DiagramFrame, useAvailableHeight, useFitOnResize } = await import("../src/app/viewer.js");
const { CanvasTools } = await import("../src/screens/architecture/Tools.js");
const { ALL_LAYERS } = await import("../src/screens/architecture/canvas-tools.js");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the details beside the canvas", () => {
  it("open in the very render a new reveal arrives in, not an effect later", () => {
    const props: Record<string, unknown> = {
      title: "Estate",
      full: false,
      height: 600,
      toolbar: null,
      children: null,
      aside: "details",
      asideBeside: true,
      onKeyAction: () => undefined,
    };
    // Each pass's tree, before its effects run.
    const passes: unknown[] = [];
    const Probe = (p: never) => {
      const t = (DiagramFrame as (p: never) => unknown)(p);
      passes.push(t);
      return t;
    };
    const m = mount(Probe as never, props as never);
    const aside = (t: unknown) => all(t).find((e) => e.type === "aside")!;
    const close = all(m.tree).find(
      (e) => e.type === "button" && e.props["aria-expanded"] === true,
    )!;
    (close.props.onClick as () => void)();
    m.render();
    expect(aside(m.tree).props.hidden).toBe(true);
    passes.length = 0;
    props.reveal = "l-1";
    m.render();
    expect(aside(passes[0]).props.hidden).toBe(false);
    // The same reveal again doesn't open details the person closed.
    const close2 = all(m.tree).find(
      (e) => e.type === "button" && e.props["aria-expanded"] === true,
    )!;
    (close2.props.onClick as () => void)();
    m.render();
    expect(aside(m.tree).props.hidden).toBe(true);
  });
});

describe("the canvas's height", () => {
  it("is measured again when anything round it (the map's panel, the page) changes size", () => {
    const observed: unknown[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(x: unknown) {
          observed.push(x);
        }
        disconnect() {}
      },
    );
    vi.stubGlobal("window", {
      innerHeight: 900,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    const rect =
      (top: number, bottom = top + 10) =>
      () => ({ top, bottom });
    const scroller = { id: "main", getBoundingClientRect: rect(40, 760) };
    const page = { id: "page", parentElement: scroller };
    const section = { id: "arch-work", parentElement: page };
    const parent = { id: "stage", parentElement: section };
    const frame = { id: "frame", parentElement: parent, getBoundingClientRect: rect(200) };
    vi.stubGlobal("document", { body: {} });
    vi.stubGlobal("getComputedStyle", (x: { id: string }) => ({
      overflowY: x.id === "main" ? "auto" : "visible",
    }));
    const ref = { current: frame };
    const Probe = () => useAvailableHeight(ref as never);
    const m = mount(Probe as never, {} as never);
    expect(observed).toEqual(expect.arrayContaining([parent, section, page, scroller]));
    // 760 - 40 high, the frame 160 into it, less the margin.
    expect(m.tree).toBe(760 - 40 - 160 - 24);
  });

  it("fits the picture to the height measured, until the person moves the view", () => {
    const frames: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (f: () => void) => frames.push(f));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const fitView = vi.fn();
    const rf = { current: { fitView } };
    const moved = { current: false };
    const props = { height: 560, ready: false, full: false };
    const Probe = (p: typeof props) => useFitOnResize(rf as never, { ...p, moved });
    const m = mount(Probe as never, props as never);
    expect(frames).toHaveLength(0);
    props.ready = true;
    m.render();
    props.height = 610;
    m.render();
    for (const f of frames.splice(0)) f();
    expect(fitView).toHaveBeenCalled();
    expect(fitView.mock.calls.at(-1)![0]).toMatchObject({ minZoom: 0.6 });
    fitView.mockClear();
    moved.current = true;
    props.height = 640;
    m.render();
    for (const f of frames.splice(0)) f();
    expect(fitView).not.toHaveBeenCalled();
  });
});

describe("the tools' drawer", () => {
  it("closes on Esc from a checkbox, a radio or a select; a text field keeps its Esc", () => {
    const onClose = vi.fn();
    const m = mount(
      CanvasTools as never,
      {
        graph: { boxes: [], links: [] },
        allBoxes: 0,
        state: { layers: ALL_LAYERS, mismatches: false, filter: "", overlay: "none" },
        onChange: () => undefined,
        onSelect: () => undefined,
        labelOf: (id: string) => id,
        placed: () => undefined,
        lens: "architecture",
        node: "estate",
        onSnapshot: () => undefined,
        name: "architecture.estate",
        drawer: { open: true, bodyId: "tools-body", onClose },
      } as never,
    );
    const drawer = all(m.tree).find((e) => e.type === "section")!;
    const key = (target: object) =>
      (drawer.props.onKeyDown as (e: unknown) => void)({
        key: "Escape",
        target: { isContentEditable: false, ...target },
        preventDefault: () => undefined,
      });
    key({ tagName: "INPUT", type: "checkbox" });
    key({ tagName: "INPUT", type: "radio" });
    key({ tagName: "SELECT" });
    expect(onClose).toHaveBeenCalledTimes(3);
    key({ tagName: "INPUT", type: "search" });
    key({ tagName: "TEXTAREA" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
