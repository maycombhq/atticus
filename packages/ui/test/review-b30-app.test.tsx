import { afterEach, describe, expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * Beta.30, slice 2, after its review: a link to a panel of Catalog builds (`?at=undo`,
 * `?at=upgrade`) scrolls to it and gives it the keyboard, on arrival once the page has loaded
 * and when the address changes on the page (both layouts hand the page its address the same
 * way); Build again holds Build now; a step a person stopped is not an alert and never says the
 * job's raw state; a copy button's timer goes with it.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const { COPY } = await import("../src/copy.js");
const { JobFailed } = await import("../src/app/job.js");
const { hashParam } = await import("../src/app/screens.js");
const { View } = await import("../src/app/ui.js");
const { ErrorWaysOn, refusalWay } = await import("../src/app/ways-on.js");
const { JobProgress } = await import("../src/app/job-progress.js");
const { CopyButton } = await import("../src/screens/run/shared.js");
const { applyStaged } = await import("../src/screens/architecture/EditMap.js");
const { CatalogBuildsPage, panelAsked, UNDO_PANEL, UPGRADE_PANEL, useShowPanel, whyStopped } =
  await import("../src/screens/setup/CatalogBuild.js");

const B = COPY.catalogBuild;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const tick = () => new Promise((r) => setTimeout(r, 0));
const stopped = () => new JobFailed("cancelled", [], undefined, undefined, undefined, true);

/** A page whose panels' headings can be scrolled to and focused, recording each. */
function page(ids: string[]) {
  const did: string[] = [];
  const el = (id: string) => {
    const section = { scrollIntoView: () => void did.push(`scroll ${id}`) };
    return {
      closest: () => section,
      setAttribute: (k: string, v: string) => void did.push(`${k}=${v} ${id}`),
      focus: (o?: { preventScroll?: boolean }) =>
        void did.push(`focus ${id}${o?.preventScroll ? " (no scroll)" : ""}`),
    };
  };
  vi.stubGlobal("document", {
    getElementById: (id: string) => (ids.includes(id) ? el(id) : null),
  });
  return did;
}

describe("the address names a panel of Catalog builds", () => {
  it("reads one value of an address, once for every page that takes one", () => {
    expect(hashParam("#/catalog-builds?at=undo", "at")).toBe("undo");
    expect(hashParam("#/trust?repo=forge%20x&at=y", "repo")).toBe("forge x");
    expect(hashParam("#/trust", "repo")).toBeUndefined();
    expect(panelAsked("#/catalog-builds?at=undo")).toBe(UNDO_PANEL);
    expect(panelAsked("#/catalog-builds?at=upgrade")).toBe(UPGRADE_PANEL);
    expect(panelAsked("#/catalog-builds?at=else")).toBeUndefined();
  });

  it("on arrival it waits for the page to load, then scrolls to the panel and gives it the keyboard, once", () => {
    const did = page([UNDO_PANEL]);
    const props = { hash: "#/catalog-builds?at=undo", ready: false };
    const Probe = (p: typeof props) => useShowPanel(p.hash, p.ready);
    const m = mount(Probe as never, props as never);
    // Still loading: the panels above would push it away again.
    expect(did).toEqual([]);
    props.ready = true;
    m.render();
    expect(did).toEqual([
      `tabindex=-1 ${UNDO_PANEL}`,
      `scroll ${UNDO_PANEL}`,
      `focus ${UNDO_PANEL} (no scroll)`,
    ]);
    // A reload of the page's data doesn't take the person back there.
    props.ready = false;
    m.render();
    props.ready = true;
    m.render();
    expect(did).toHaveLength(3);
  });

  it("already on the page, a link that changes the address scrolls there; and again after going away", () => {
    const did = page([UNDO_PANEL, UPGRADE_PANEL]);
    const props = { hash: "#/catalog-builds", ready: true };
    const Probe = (p: typeof props) => useShowPanel(p.hash, p.ready);
    const m = mount(Probe as never, props as never);
    expect(did).toEqual([]);
    props.hash = "#/catalog-builds?at=undo";
    m.render();
    expect(did.filter((x) => x.startsWith("scroll"))).toEqual([`scroll ${UNDO_PANEL}`]);
    props.hash = "#/catalog-builds?at=upgrade";
    m.render();
    expect(did.filter((x) => x.startsWith("scroll"))).toEqual([
      `scroll ${UNDO_PANEL}`,
      `scroll ${UPGRADE_PANEL}`,
    ]);
    props.hash = "#/catalog-builds";
    m.render();
    props.hash = "#/catalog-builds?at=undo";
    m.render();
    expect(did.filter((x) => x.startsWith("scroll"))).toHaveLength(3);
  });

  it("a panel that isn't on the page (nothing to upgrade) is asked for again when it comes", () => {
    const none = page([]);
    const props = { hash: "#/catalog-builds?at=upgrade", ready: true };
    const Probe = (p: typeof props) => useShowPanel(p.hash, p.ready);
    const m = mount(Probe as never, props as never);
    expect(none).toEqual([]);
    const did = page([UPGRADE_PANEL]);
    props.ready = false;
    m.render();
    props.ready = true;
    m.render();
    expect(did.filter((x) => x.startsWith("scroll"))).toEqual([`scroll ${UPGRADE_PANEL}`]);
  });
});

describe("Build now and Build again on Catalog builds", () => {
  const ready = <T,>(data: T) => ({ state: "ready" as const, data });
  const build = {
    sources: [],
    pending: { upToDate: false, removals: [], plan: "a".repeat(64) },
    orphaned: [],
    problems: [],
  };
  const setup = (run: () => Promise<void>) => {
    const m = mount(
      CatalogBuildsPage as never,
      {
        build: ready(build),
        undo: ready({ copies: [] }),
        prune: ready({ files: [] }),
        run,
        plan: async () => ({}),
      } as never,
    );
    /** The next build's panel, as its View draws it for the loaded build. */
    const pending = () => {
      const views = all(m.tree).filter((e) => e.type === View);
      return (views[0]!.props.children as (v: unknown) => unknown)(build);
    };
    const buildNow = () =>
      all(pending()).find(
        (e) =>
          e.type === "button" && [B.build, B.building].includes(text(e.props.children) as never),
      )!;
    return { m, pending, buildNow };
  };

  it("a build that failed offers Build again, which holds Build now while it runs", async () => {
    const runs: { fail?: (e: unknown) => void }[] = [];
    const { m, pending, buildNow } = setup(
      () => new Promise<void>((_ok, fail) => void runs.push({ fail })),
    );
    (buildNow().props.onClick as () => void)();
    m.render();
    expect(buildNow().props.disabled).toBe(true);
    runs[0]!.fail!(new JobFailed("The write failed.", ["The write failed."]));
    await tick();
    m.render();
    expect(buildNow().props.disabled).toBe(false);
    const alert = all(pending()).find((e) => e.props.role === "alert")!;
    expect(text(alert)).toBe(B.failed("The write failed."));
    const ways = all(pending()).find((e) => e.type === ErrorWaysOn)!;
    (ways.props.onAgain as () => void)();
    m.render();
    // Build again is the same build: Build now waits for it, so no second one is asked.
    expect(runs).toHaveLength(2);
    expect(buildNow().props.disabled).toBe(true);
    expect(all(pending()).some((e) => e.props.role === "alert")).toBe(false);
  });

  it("a build a person stopped is no alert and never says the job's state word", async () => {
    const runs: { fail?: (e: unknown) => void }[] = [];
    const { m, pending, buildNow } = setup(
      () => new Promise<void>((_ok, fail) => void runs.push({ fail })),
    );
    (buildNow().props.onClick as () => void)();
    m.render();
    runs[0]!.fail!(stopped());
    await tick();
    m.render();
    expect(all(pending()).some((e) => e.props.role === "alert")).toBe(false);
    expect(all(pending()).some((e) => e.type === ErrorWaysOn)).toBe(false);
    expect(JSON.stringify(text(pending()))).not.toContain("cancelled");
    // Its own line says it stopped (JobProgress, from the job's run).
    expect(all(pending()).some((e) => e.type === JobProgress)).toBe(true);
    expect(buildNow().props.disabled).toBe(false);
  });

  it("why a step stopped is in the copy's words when a person stopped it", () => {
    expect(whyStopped(stopped())).toBe(COPY.app.jobRun.youStopped);
    expect(whyStopped(new JobFailed("x", ["It broke."]))).toBe("It broke.");
  });
});

describe("Edit the map's Apply a person stopped", () => {
  it("goes back to the list (nothing was saved), with no failure said", async () => {
    const s = await applyStaged([], async () => {
      throw stopped();
    });
    expect(s).toEqual({ state: "idle" });
  });
});

describe("a refusal's one way on, by its reasons, wherever it is shown", () => {
  it("is the first of: newer Atticus, upgrade, build again, hand edits, removals, read", () => {
    expect(refusalWay(["hand-edits", "large-removals"])).toBe("edits");
    expect(refusalWay(["large-removals"])).toBe("removals");
    expect(refusalWay(["unexplained-removals", "empty"])).toBe("again");
    expect(refusalWay(["empty"])).toBe("read");
    expect(refusalWay(["nothing-read"])).toBe("read");
    expect(refusalWay(["not-upgraded", "hand-edits"])).toBe("upgrade");
    expect(refusalWay(["newer-atticus", "not-upgraded"])).toBe("newer");
    expect(refusalWay([])).toBeUndefined();
  });
});

describe("a copy button that goes", () => {
  it("takes its timer with it", () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { clipboard: { writeText: () => Promise.resolve() } });
    const m = mount(
      CopyButton as never,
      { text: "atticus support bundle", label: "Copy" } as never,
    );
    const btn = all(m.tree).find((e) => e.type === "button")!;
    (btn.props.onClick as () => void)();
    expect(vi.getTimerCount()).toBe(1);
    m.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
