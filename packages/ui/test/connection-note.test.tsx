import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { appCommands, ConnectionNote, syncCommand, tourMetarepo } from "../src/app/App.js";
import { COPY } from "../src/copy.js";

/**
 * Beta.27 review: the connection is said once, above the page (the server down, or the app
 * restarted with a session this page couldn't take up), and the first-run tour never opens on a
 * failed health (it opened over the page after a restart, as if the metarepo were new).
 */
const A = COPY.app;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const html = (down: boolean, stale: boolean) =>
  renderToStaticMarkup(<ConnectionNote down={down} stale={stale} inPanel={false} />);

describe("the connection's one note", () => {
  it("is nothing while the server answers with this page's session", () => {
    expect(html(false, false)).toBe("");
  });

  it("says the server isn't answering, with Try again", () => {
    const out = html(true, false);
    expect(out).toContain('role="alert"');
    expect(out).toContain(esc(A.offline));
    expect(out).toContain(A.tryAgain);
    expect(out).not.toContain(esc(A.restarted));
  });

  it("after a restart whose new token couldn't be read: one note, with Reload", () => {
    const out = html(false, true);
    expect(out).toContain('role="alert"');
    expect(out).toContain(esc(A.restarted));
    expect(out).toContain(A.reload);
    expect(out.match(/role="alert"/g)).toHaveLength(1);
  });
});

describe("Ctrl+K's Sync the repos (beta.27 review)", () => {
  it("starts the sync the Console then shows", async () => {
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        sent.push(`${init.method ?? "GET"} ${url}`);
        return new Response(JSON.stringify({ jobId: "job-1" }), { status: 202 });
      }),
    );
    try {
      const c = syncCommand("classic");
      expect(c.label).toBe(COPY.palette.sync.label);
      expect(c.also).toContain("sync");
      c.run();
      await new Promise((r) => setTimeout(r, 10));
      expect(sent).toEqual(["POST /api/workspace/sync"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Ctrl+K's own commands", () => {
  // Beta.27 re-review: a bare folder (no metarepo yet) has no repos to sync.
  it("offers Sync the repos at a metarepo only", () => {
    const labels = (metarepo: boolean) =>
      appCommands("ide", () => undefined, metarepo).map((c) => c.label);
    expect(labels(true)).toContain(COPY.palette.sync.label);
    expect(labels(false)).not.toContain(COPY.palette.sync.label);
    // The rest is there either way.
    expect(labels(false)).toContain(COPY.ide.layout.toClassic);
  });
});

describe("the first-run tour", () => {
  it("is for the metarepo health names, and waits on anything else", () => {
    expect(
      tourMetarepo({
        state: "ready",
        data: { root: "/work/forge", user: "priya", version: "x", apiVersion: "y" } as never,
      }),
    ).toBe("/work/forge");
    expect(tourMetarepo({ state: "loading" })).toBeUndefined();
    // A session token refused after a restart, or the server down: no first run.
    expect(
      tourMetarepo({ state: "error", error: "Missing or wrong session token", status: 401 }),
    ).toBeUndefined();
    expect(tourMetarepo({ state: "error", error: A.offline })).toBeUndefined();
  });
});
