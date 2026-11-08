import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "./support/hooks.js";

/**
 * Review round 28: when a page's address changes (another box picked, another change), useApi
 * shows loading until the new answer comes, never the last address's answer as if it were this.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});

const { useApi } = await import("../src/api/client.js");
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.unstubAllGlobals());

describe("useApi when the path changes", () => {
  it("is loading for a new path, and ready with the new path's answer once it comes", async () => {
    vi.stubGlobal("document", { querySelector: () => null });
    const answers: Record<string, unknown> = { "/api/x": { box: "x" }, "/api/y": { box: "y" } };
    let release: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/y") await new Promise<void>((r) => (release = r));
        return new Response(JSON.stringify(answers[path]), { status: 200 });
      }),
    );
    const props = { path: "/api/x" as string | undefined };
    const Probe = (p: { path?: string }) => useApi<{ box: string }>(p.path);
    const m = mount(Probe as never, props as never);
    await flush();
    await flush();
    m.render();
    expect(m.tree).toMatchObject({ state: "ready", data: { box: "x" } });
    props.path = "/api/y";
    m.render();
    expect((m.tree as { state: string }).state).toBe("loading");
    release?.();
    await flush();
    await flush();
    m.render();
    expect(m.tree).toMatchObject({ state: "ready", data: { box: "y" } });
    props.path = undefined;
    m.render();
    expect((m.tree as { state: string }).state).toBe("loading");
  });
});
