import { describe, expect, it } from "vitest";
import { makeBridge } from "../src/api/bridge.js";
import { usableWorkerUrl } from "../src/app/layout/worker-url.js";

/**
 * ADR 0097: the app inside a VS Code panel, loaded from the extension's own files. It has no
 * server of its own there: every API call goes to the extension as a message and the answer
 * comes back the same way; live events and "go to this view" arrive as messages too.
 */

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

describe("the app's calls through the extension (ADR 0097)", () => {
  it("sends each call as a message and resolves it with the extension's answer", async () => {
    const h = host();
    const b = makeBridge(h.post, h.on);
    const p = b.call("/api/specs", { method: "GET" });
    expect(h.sent).toEqual([{ type: "api", id: 1, method: "GET", path: "/api/specs" }]);
    h.deliver({ type: "api-reply", id: 1, status: 200, body: { repos: [] } });
    expect(await p).toEqual({ status: 200, body: { repos: [] } });
  });

  it("carries a body, and keeps answers apart by id", async () => {
    const h = host();
    const b = makeBridge(h.post, h.on);
    const a = b.call("/api/graph/layout/x", { method: "PUT", body: { positions: {} } });
    const c = b.call("/api/changes", { method: "GET" });
    expect(h.sent[0]).toMatchObject({ id: 1, method: "PUT", body: { positions: {} } });
    h.deliver({ type: "api-reply", id: 2, status: 200, body: [] });
    h.deliver({ type: "api-reply", id: 1, status: 404, body: { title: "Not found", status: 404 } });
    expect(await c).toEqual({ status: 200, body: [] });
    expect(await a).toEqual({ status: 404, body: { title: "Not found", status: 404 } });
  });

  it("passes on live events and navigation, and ignores anything else", () => {
    const h = host();
    const b = makeBridge(h.post, h.on);
    const events: unknown[] = [];
    const hashes: string[] = [];
    b.onEvent((e) => events.push(e));
    b.onNavigate((x) => hashes.push(x));
    h.deliver({ type: "event", event: { type: "file.changed", path: "specs/forge-web/a.yaml" } });
    h.deliver({ type: "navigate", hash: "#/flows?repo=forge-web" });
    h.deliver({ type: "something-else" });
    h.deliver("not even an object");
    expect(events).toEqual([{ type: "file.changed", path: "specs/forge-web/a.yaml" }]);
    expect(hashes).toEqual(["#/flows?repo=forge-web"]);
  });

  it("refuses a navigation that isn't to one of the app's own screens", () => {
    const h = host();
    const b = makeBridge(h.post, h.on);
    const hashes: string[] = [];
    b.onNavigate((x) => hashes.push(x));
    h.deliver({ type: "navigate", hash: "javascript:alert(1)" });
    h.deliver({ type: "navigate", hash: "https://example.com" });
    expect(hashes).toEqual([]);
  });
});

describe("the layout worker, wherever the page comes from", () => {
  it("uses the worker's own address when it is on the page's origin", async () => {
    expect(
      await usableWorkerUrl(
        "/assets/elk-worker.js",
        "http://127.0.0.1:4321/#/architecture",
        async () => {
          throw new Error("not fetched");
        },
      ),
    ).toBe("http://127.0.0.1:4321/assets/elk-worker.js");
  });

  it("makes a same-origin copy when the files come from elsewhere (a VS Code panel)", async () => {
    const got: string[] = [];
    const url = await usableWorkerUrl(
      "https://file+.vscode-resource.vscode-cdn.net/ext/media/app/assets/elk-worker.js",
      "vscode-webview://abc/index.html",
      async (u) => {
        got.push(u);
        return "self.onmessage = () => {};";
      },
      (text) => `blob:copy-of-${text.length}`,
    );
    expect(got).toEqual([
      "https://file+.vscode-resource.vscode-cdn.net/ext/media/app/assets/elk-worker.js",
    ]);
    expect(url).toBe("blob:copy-of-26");
  });
});
