import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Beta.27 review: a page asked the server the same thing several times at once (Brief read its
 * change three times and its status twice, Contracts /api/catalog/Interface three times, Stories
 * /work-items twice). Every GET is now shared: asks in one moment share one read. Beta.27
 * re-review: an ask while a read is under way never takes that read's answer (it may be from
 * before a write, or before the change the asker heard of): it gets the one read queued after
 * it, however many ask meanwhile. No network: fetch is a fake.
 */

type Gate = { path: string; release: (body: unknown) => void };

function server() {
  const sent: string[] = [];
  const gates: Gate[] = [];
  const fetch = vi.fn((url: string, init: RequestInit = {}) => {
    sent.push(`${init.method ?? "GET"} ${url}`);
    return new Promise<Response>((resolve, reject) => {
      init.signal?.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      );
      gates.push({
        path: url,
        release: (body) => resolve(new Response(JSON.stringify(body), { status: 200 })),
      });
    });
  });
  return { fetch, sent, gates };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the app's GETs, shared", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("asks in one moment share one read (a page's parts mounting together)", async () => {
    const s = server();
    vi.stubGlobal("fetch", s.fetch);
    const { api, setSessionToken } = await import("../src/api/client.js");
    setSessionToken("t");
    // Brief: its change three times, its status twice.
    const reads = [
      api("/api/changes/add-transfer-limit"),
      api("/api/changes/add-transfer-limit"),
      api("/api/changes/add-transfer-limit"),
      api("/api/changes/add-transfer-limit/status"),
      api("/api/changes/add-transfer-limit/status"),
    ];
    await tick();
    expect(s.sent).toEqual([
      "GET /api/changes/add-transfer-limit",
      "GET /api/changes/add-transfer-limit/status",
    ]);
    s.gates[0]!.release({ id: "add-transfer-limit" });
    s.gates[1]!.release({ state: "open" });
    const got = await Promise.all(reads);
    expect(got.slice(0, 3)).toEqual([
      { id: "add-transfer-limit" },
      { id: "add-transfer-limit" },
      { id: "add-transfer-limit" },
    ]);
  });

  it("an ask while a read is under way gets the one read after it, never the earlier answer", async () => {
    const s = server();
    vi.stubGlobal("fetch", s.fetch);
    const { api, setSessionToken } = await import("../src/api/client.js");
    setSessionToken("t");
    const first = api<{ n: number }>("/api/trust");
    await tick();
    // The page writes meanwhile; three asks after it.
    const write = api("/api/manifest/repos", { method: "POST", body: { id: "forge-audit" } });
    const later = [api<{ n: number }>("/api/trust"), api<{ n: number }>("/api/trust")];
    await tick();
    later.push(api<{ n: number }>("/api/trust"));
    await tick();
    expect(s.sent).toEqual(["GET /api/trust", "POST /api/manifest/repos"]);
    s.gates[1]!.release({});
    await write;
    s.gates[0]!.release({ n: 1 });
    expect((await first).n).toBe(1);
    await tick();
    // Exactly one more read, sent after the first ended.
    expect(s.sent).toEqual(["GET /api/trust", "POST /api/manifest/repos", "GET /api/trust"]);
    s.gates[2]!.release({ n: 2 });
    expect((await Promise.all(later)).map((x) => x.n)).toEqual([2, 2, 2]);
  });

  it("a file event heard after a read was sent: an ask then waits for the read after it", async () => {
    const s = server();
    vi.stubGlobal("fetch", s.fetch);
    const { api, noteChange, setSessionToken } = await import("../src/api/client.js");
    setSessionToken("t");
    const first = api("/api/trust");
    await tick();
    // Nothing changed: an ask joins the read under way.
    const same = api("/api/trust");
    await tick();
    expect(s.sent).toHaveLength(1);
    // A burst heard (the live socket counts it): the next ask is a read after it.
    noteChange();
    const after = api<{ n: number }>("/api/trust");
    // `after`: the page's own read again after its write, never the read under way.
    const own = api<{ n: number }>("/api/trust", { after: true });
    s.gates[0]!.release({ n: 1 });
    await Promise.all([first, same]);
    await tick();
    expect(s.sent).toHaveLength(2);
    s.gates[1]!.release({ n: 2 });
    expect([(await after).n, (await own).n]).toEqual([2, 2]);
  });

  it("a caller that goes stops waiting; the read stops once no one waits", async () => {
    const s = server();
    vi.stubGlobal("fetch", s.fetch);
    const { api, setSessionToken } = await import("../src/api/client.js");
    setSessionToken("t");
    const a = new AbortController();
    const b = new AbortController();
    const ra = api("/api/catalog/Interface", { signal: a.signal });
    const rb = api("/api/catalog/Interface", { signal: b.signal });
    await tick();
    expect(s.sent).toHaveLength(1);
    a.abort();
    await expect(ra).rejects.toThrow(/Abort/);
    b.abort();
    await expect(rb).rejects.toThrow(/Abort/);
    // A new ask after both went is a read of its own, answered.
    const rc = api<{ ok: boolean }>("/api/catalog/Interface");
    await tick();
    expect(s.sent).toHaveLength(2);
    s.gates[1]!.release({ ok: true });
    expect((await rc).ok).toBe(true);
  });

  it("writes are never shared", async () => {
    const s = server();
    vi.stubGlobal("fetch", s.fetch);
    const { api, setSessionToken } = await import("../src/api/client.js");
    setSessionToken("t");
    void api("/api/questions/q-1/answer", { method: "POST", body: { answer: "yes" } });
    void api("/api/questions/q-1/answer", { method: "POST", body: { answer: "yes" } });
    await tick();
    expect(s.sent).toEqual(["POST /api/questions/q-1/answer", "POST /api/questions/q-1/answer"]);
  });
});
