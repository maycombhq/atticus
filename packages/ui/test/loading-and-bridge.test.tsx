import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, BUSY_EVENT, requestsInFlight } from "../src/api/client.js";
import { makeBridge } from "../src/api/bridge.js";
import { LoadingBar, PanelBar } from "../src/app/loading-bar.js";
import { COPY } from "../src/copy.js";

/**
 * beta.21: the loading bar counts every request a person waits on and none the page makes on its
 * own (quiet); the bridge's saveFile hands a panel's export to the extension and hears how it went.
 */

afterEach(() => vi.unstubAllGlobals());

describe("the loading bar's count", () => {
  it("rises on a call and falls when it ends; a quiet call never moves it", async () => {
    const seen: number[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent<number>).detail);
    const w = { dispatchEvent: (e: Event) => (on(e), true) };
    vi.stubGlobal("window", w);
    vi.stubGlobal("document", { querySelector: () => null });
    let release: () => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise((r) => {
          release = () =>
            r(
              new Response(JSON.stringify({}), { headers: { "content-type": "application/json" } }),
            );
        }),
    );
    const p = api("/api/x");
    expect(requestsInFlight()).toBe(1);
    release();
    await p;
    expect(requestsInFlight()).toBe(0);
    expect(seen).toEqual([1, 0]);
    const q = api("/api/y", { quiet: true });
    expect(requestsInFlight()).toBe(0);
    release();
    await q;
    expect(seen).toEqual([1, 0]);
  });

  it("draws the bar only while something is in flight, and a panel's own bar inline", () => {
    expect(renderToStaticMarkup(<LoadingBar />)).toContain('aria-hidden="true"');
    expect(renderToStaticMarkup(<PanelBar />)).toContain("loading-bar inline on");
    expect(COPY.app.loading).toBeTruthy();
    expect(BUSY_EVENT).toBe("atticus:busy");
  });
});

describe("saving a file through the extension", () => {
  function host() {
    const sent: Record<string, unknown>[] = [];
    const listeners: ((m: unknown) => void)[] = [];
    return {
      sent,
      post: (m: Record<string, unknown>) => sent.push(m),
      on: (f: (m: unknown) => void) => listeners.push(f),
      deliver: (m: unknown) => listeners.forEach((f) => f(m)),
    };
  }
  it("asks the extension to save, and says saved, cancelled or failed as it answers", async () => {
    const h = host();
    const b = makeBridge(h.post, h.on);
    const p = b.saveFile("estate.svg", "<svg/>", "utf8");
    expect(h.sent[0]).toEqual({
      type: "save-file",
      id: 1,
      name: "estate.svg",
      data: "<svg/>",
      encoding: "utf8",
    });
    h.deliver({ type: "save-reply", id: 1, state: "saved" });
    expect(await p).toBe("saved");
    const q = b.saveFile("estate.png", "AAAA", "base64");
    h.deliver({ type: "save-reply", id: 2, state: "cancelled" });
    expect(await q).toBe("cancelled");
    const r = b.saveFile("x.mmd", "a", "utf8");
    h.deliver({ type: "save-reply", id: 3, state: "nonsense" });
    expect(await r).toBe("failed");
  });
});

describe("Open in your editor", () => {
  it("is a named button that says when it is finding the file", async () => {
    const { OpenCode } = await import("../src/screens/architecture/OpenCode.js");
    const out = renderToStaticMarkup(<OpenCode repo="forge-ledger" at="src/A.java:3" />);
    expect(out).toContain(COPY.canvasTools.openCode);
    expect(out).toContain("<button");
    expect(COPY.canvasTools.openingCode).toBeTruthy();
  });
});

describe("a change's tabs keep the change", () => {
  it("Release reads the change from ?change= as well as from its path", async () => {
    const { changeOf } = await import("../src/app/screens.js");
    expect(changeOf("#/release?change=forge-b")).toBe("forge-b");
    expect(changeOf("#/changes/forge-a")).toBe("forge-a");
    expect(changeOf("#/release")).toBeUndefined();
    // A mangled hash is a name, never a blank page.
    expect(changeOf("#/changes/100%")).toBe("100%");
    expect(changeOf("#/changes/add%20transfer")).toBe("add transfer");
  });
});
