import { describe, expect, it, vi } from "vitest";
import { all, mount } from "./support/hooks.js";

/**
 * The sketch panel's own states (review round 20): while the strokes load it says it is loading,
 * never "none drawn yet"; when the component types can't be read it says so with a retry and the
 * form still draws. The local API is a stub.
 */

vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const answers = new Map<string, unknown>();
vi.mock("../src/api/client.js", async () => {
  const real = await vi.importActual<object>("../src/api/client.js");
  return {
    ...real,
    useApi: (path: string) => answers.get(path) ?? { state: "loading" },
    useReloadOnFiles: () => undefined,
  };
});

const { SketchForm, SketchPanel } = await import("../src/screens/work/Sketch.js");
const { LoadError, View } = await import("../src/app/ui.js");
const SKETCH = "/api/changes/add-fraud-check/sketch";

describe("the sketch panel", () => {
  it("says it is loading while the strokes load, never that none are drawn", () => {
    answers.clear();
    const m = mount(SketchPanel as never, { change: "add-fraud-check" } as never);
    // The shared loading state (skeleton lines, aria-busy), and no form saying none are drawn.
    expect((m.tree as { type: unknown }).type).toBe(View);
    expect(all(m.tree).some((e) => e.type === SketchForm)).toBe(false);
  });

  it("says the types couldn't be read, with a retry, and still shows the form", () => {
    answers.clear();
    answers.set(SKETCH, {
      state: "ready",
      data: { drawn: [], fingerprint: "f1", written: [], planned: [] },
      reload: () => undefined,
    });
    answers.set("/api/component-types", {
      state: "error",
      error: "The local API stopped.",
      reload: () => undefined,
    });
    const m = mount(SketchPanel as never, { change: "add-fraud-check" } as never);
    const els = all(m.tree);
    expect(els.find((e) => e.type === LoadError)?.props.error).toBe("The local API stopped.");
    expect(els.find((e) => e.type === SketchForm)?.props.types).toEqual([]);
  });
});
