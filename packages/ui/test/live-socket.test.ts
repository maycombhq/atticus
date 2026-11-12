import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Beta.27 review: every part of a page that follows live events opened its own WebSocket to
 * /api/events (11 to 15 a page). The page now has one, whatever the number of listeners; every
 * event reaches each; it is opened again with a backoff when it closes, and closes a moment
 * after the last listener goes.
 */

class FakeSocket {
  static made: FakeSocket[] = [];
  onmessage?: (m: { data: string }) => void;
  onopen?: () => void;
  onclose?: () => void;
  closed = false;
  constructor(readonly url: URL) {
    FakeSocket.made.push(this);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
  // What the server does.
  open() {
    this.onopen?.();
  }
  send(e: unknown) {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
  drop() {
    this.closed = true;
    this.onclose?.();
  }
}

describe("the page's one live socket", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    FakeSocket.made = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", { href: "http://127.0.0.1:4100/#/home" });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens one socket for any number of listeners, and every event reaches each", async () => {
    const c = await import("../src/api/client.js");
    c.setSessionToken("tok");
    const heard: string[][] = [[], [], [], [], [], [], [], [], [], [], [], [], [], [], []];
    const stops = heard.map((h) => c.subscribeLive((e) => h.push(e.type)));
    expect(FakeSocket.made).toHaveLength(1);
    const ws = FakeSocket.made[0]!;
    expect(ws.url.protocol).toBe("ws:");
    expect(ws.url.pathname).toBe("/api/events");
    ws.open();
    ws.send({ type: "file.changed", path: "facts/forge-ledger.jsonl" });
    for (const h of heard) expect(h).toEqual(["file.changed"]);
    // One listener going leaves the socket to the rest.
    stops[0]!();
    vi.advanceTimersByTime(c.LIVE_LINGER_MS * 2);
    expect(ws.closed).toBe(false);
    for (const s of stops.slice(1)) s();
    // A page drawn anew within the moment keeps the same socket.
    const again = c.subscribeLive(() => undefined);
    vi.advanceTimersByTime(c.LIVE_LINGER_MS * 2);
    expect(FakeSocket.made).toHaveLength(1);
    expect(ws.closed).toBe(false);
    again();
    vi.advanceTimersByTime(c.LIVE_LINGER_MS);
    expect(ws.closed).toBe(true);
    // Closed by the page: not opened again.
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.made).toHaveLength(1);
  });

  it("opens it again with a backoff after it drops, and a listener's failure is its own", async () => {
    const c = await import("../src/api/client.js");
    c.setSessionToken("tok");
    const got: string[] = [];
    c.subscribeLive(() => {
      throw new Error("a listener broke");
    });
    c.subscribeLive((e) => got.push(e.type));
    const first = FakeSocket.made[0]!;
    first.open();
    first.send({ type: "job.done", jobId: "job-1", state: "done" });
    expect(got).toEqual(["job.done"]);
    first.drop();
    vi.advanceTimersByTime(c.LIVE_WAIT_MS - 1);
    expect(FakeSocket.made).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.made).toHaveLength(2);
    // Opened, then dropped again: the wait starts over.
    FakeSocket.made[1]!.open();
    FakeSocket.made[1]!.drop();
    vi.advanceTimersByTime(c.LIVE_WAIT_MS);
    expect(FakeSocket.made).toHaveLength(3);
  });

  it("refused before it opened (a restart's new token), reads the token again, then retries", async () => {
    const fetch = vi.fn(async () => new Response('<meta name="atticus-token" content="new" />'));
    vi.stubGlobal("fetch", fetch);
    const c = await import("../src/api/client.js");
    c.setSessionToken("old");
    c.subscribeLive(() => undefined);
    expect(FakeSocket.made[0]!.url.searchParams.get("token")).toBe("old");
    FakeSocket.made[0]!.drop();
    await vi.advanceTimersByTimeAsync(c.LIVE_WAIT_MS);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(FakeSocket.made).toHaveLength(2);
    expect(FakeSocket.made[1]!.url.searchParams.get("token")).toBe("new");
  });
});
