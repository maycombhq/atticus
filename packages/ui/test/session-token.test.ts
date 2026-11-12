import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Beta.27 review, blocker: after `atticus ui` restarts (a new session token), a page left open
 * got 401 "Missing or wrong session token" on every call, for good. The page now reads the token
 * again the way it first got it (the app's own page, same origin; never a URL), and sends the
 * call again once; when no new token can be had, it says once that the app restarted, with Reload.
 */

const PAGE = (token: string) =>
  `<!doctype html><html><head><meta name="atticus-token" content="${token}" />\n<meta name="atticus-page-key" content="key-${token}" /></head><body></body></html>`;

const REFUSED = {
  type: "about:blank",
  title: "Missing or wrong session token",
  status: 401,
};

type Call = { url: string; token?: string; method?: string; body?: string };

function server(o: { token: string; page?: () => string | Promise<string> }) {
  const calls: Call[] = [];
  let pageReads = 0;
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      ...(headers["X-Atticus-Token"] !== undefined ? { token: headers["X-Atticus-Token"] } : {}),
      ...(init.method ? { method: init.method } : {}),
      ...(typeof init.body === "string" ? { body: init.body } : {}),
    });
    if (!url.startsWith("/api/")) {
      pageReads++;
      const text = o.page ? await o.page() : PAGE(o.token);
      return new Response(text, { status: 200, headers: { "Content-Type": "text/html" } });
    }
    if (headers["X-Atticus-Token"] !== o.token)
      return new Response(JSON.stringify(REFUSED), { status: 401 });
    return new Response(JSON.stringify({ ok: true, url }), { status: 200 });
  });
  return { fetch, calls, pageReads: () => pageReads };
}

describe("a page left open across a restart of atticus ui", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the new token from the app's page and sends the call again, the token never in a URL", async () => {
    const s = server({ token: "new-token" });
    vi.stubGlobal("fetch", s.fetch);
    const c = await import("../src/api/client.js");
    c.setSessionToken("old-token");
    const got = await c.api<{ ok: boolean }>("/api/health");
    expect(got.ok).toBe(true);
    expect(c.token()).toBe("new-token");
    expect(c.renewedPageKey()).toBe("key-new-token");
    // The call refused, the app's page read once, the call again with the new token.
    expect(s.calls.map((x) => x.url)).toEqual(["/api/health", "/", "/api/health"]);
    expect(s.calls[0]!.token).toBe("old-token");
    expect(s.calls[2]!.token).toBe("new-token");
    for (const x of s.calls) expect(x.url).not.toMatch(/token/);
  });

  it("sends a write again with its body, and many calls refused at once read the page once", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const s = server({
      token: "t2",
      page: async () => {
        await gate;
        return PAGE("t2");
      },
    });
    vi.stubGlobal("fetch", s.fetch);
    const c = await import("../src/api/client.js");
    c.setSessionToken("t1");
    const all = Promise.all([
      c.api("/api/a"),
      c.api("/api/b"),
      c.api("/api/c", { method: "POST", body: { x: 1 } }),
    ]);
    await new Promise((r) => setTimeout(r, 10));
    release();
    await all;
    expect(s.pageReads()).toBe(1);
    const again = s.calls.filter((x) => x.url === "/api/c");
    expect(again).toHaveLength(2);
    expect(again[1]!.body).toBe(JSON.stringify({ x: 1 }));
    expect(again[1]!.token).toBe("t2");
  });

  it("a call refused after the token was already read again is only sent again", async () => {
    const s = server({ token: "t2" });
    vi.stubGlobal("fetch", s.fetch);
    const c = await import("../src/api/client.js");
    c.setSessionToken("t1");
    await c.api("/api/a");
    expect(s.pageReads()).toBe(1);
    // Sent with t1 before the renewal, refused after it: no second read of the page.
    expect(await c.retryAfterRefusal("t1")).toBe(true);
    expect(s.pageReads()).toBe(1);
  });

  it("with no new token to be had, fails once and says the app restarted (no loop)", async () => {
    const s = server({ token: "server-token", page: () => PAGE("old") });
    vi.stubGlobal("fetch", s.fetch);
    const c = await import("../src/api/client.js");
    c.setSessionToken("old");
    const heard: string[] = [];
    c.onSession((state) => heard.push(state));
    await expect(c.api("/api/health")).rejects.toThrow(/session token/);
    expect(s.calls.map((x) => x.url)).toEqual(["/api/health", "/"]);
    expect(heard).toEqual(["stale"]);
    expect(c.sessionStale()).toBe(true);
  });

  it("a page that can't be read (the server down again) is no new token", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith("/api/")) return new Response(JSON.stringify(REFUSED), { status: 401 });
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetch);
    const c = await import("../src/api/client.js");
    c.setSessionToken("old");
    expect(await c.renewToken()).toBe(false);
    expect(c.token()).toBe("old");
  });

  it("reads a token only from the app's own meta tag", async () => {
    const c = await import("../src/api/client.js");
    expect(c.tokenOfPage(PAGE("abc_DEF-123"))).toEqual({
      token: "abc_DEF-123",
      pageKey: "key-abc_DEF-123",
    });
    expect(c.tokenOfPage("<html>no meta</html>")).toEqual({});
    expect(c.tokenOfPage('<meta name="atticus-token" content="" />')).toEqual({});
  });
});
