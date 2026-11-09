import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { CONFIRM_TTL_MS, Confirmations, startServer } from "../src/index.js";

/**
 * Review round 48 (ADR 0186): a write to a shared system from the app needs a person's
 * confirmation. Only the app's page can ask for one (it has the page key, which the server puts
 * in the page and never prints); each is for one write and one target, used once, and expires.
 */
describe("confirmations for writes to shared systems", () => {
  it("is used once, for its own write and target only, and expires", () => {
    let now = 1_000_000;
    const c = new Confirmations(() => now);
    const a = c.issue("handoff", "add-transfer-limit");
    expect(a.confirmation).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(Date.parse(a.expiresAt) - now).toBe(CONFIRM_TTL_MS);
    expect(c.take("handoff", "add-transfer-limit", a.confirmation)).toBe(true);
    // Replayed.
    expect(c.take("handoff", "add-transfer-limit", a.confirmation)).toBe(false);
    // Another target or another write: refused, and the confirmation is spent.
    const b = c.issue("handoff", "add-transfer-limit");
    expect(c.take("handoff", "another-change", b.confirmation)).toBe(false);
    expect(c.take("handoff", "add-transfer-limit", b.confirmation)).toBe(false);
    const d = c.issue("merge", "add-transfer-limit");
    expect(c.take("release-prs", "add-transfer-limit", d.confirmation)).toBe(false);
    // Expired.
    const e = c.issue("merge", "add-transfer-limit");
    now += CONFIRM_TTL_MS + 1;
    expect(c.take("merge", "add-transfer-limit", e.confirmation)).toBe(false);
    // Nothing given, or not a string.
    expect(c.take("merge", "add-transfer-limit", undefined)).toBe(false);
    expect(c.take("merge", "add-transfer-limit", 42)).toBe(false);
  });

  it("gives one only to the app's page: the page key is in the page, never with the session token", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-confirm-"));
    const dir = await mkdtemp(join(tmpdir(), "atticus-ui-dist-"));
    await writeFile(
      join(dir, "index.html"),
      '<!doctype html><html><head><meta name="atticus-token" content="" /><meta name="atticus-page-key" content="" /></head><body></body></html>',
    );
    const s = await startServer({ root, port: 0, staticDir: dir, watch: false });
    const post = (body: unknown) =>
      fetch(`${s.url}/api/confirmations`, {
        method: "POST",
        headers: { "X-Atticus-Token": s.token, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      expect(s.pageKey).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      expect(s.pageKey).not.toBe(s.token);
      const html = await (await fetch(`${s.url}/`)).text();
      expect(html).toContain(`<meta name="atticus-page-key" content="${s.pageKey}" />`);
      // The session token alone: refused, with what to do instead.
      const bare = await post({ write: "handoff", target: "add-transfer-limit" });
      expect(bare.status).toBe(403);
      expect(JSON.stringify(await bare.json())).toMatch(/Atticus app|--approve/);
      const wrong = await post({ write: "handoff", target: "x", pageKey: "nope" });
      expect(wrong.status).toBe(403);
      const ok = await post({ write: "handoff", target: "add-transfer-limit", pageKey: s.pageKey });
      expect(ok.status).toBe(201);
      const v = Api.ConfirmationView.parse(await ok.json());
      expect(v).toMatchObject({ write: "handoff", target: "add-transfer-limit" });
      expect(s.confirmations.take("handoff", "add-transfer-limit", v.confirmation)).toBe(true);
      // A write the server doesn't know.
      expect((await post({ write: "deploy", target: "x", pageKey: s.pageKey })).status).toBe(400);
    } finally {
      await s.close();
    }
  });

  it("takes the editor's page key when it is strong, and an old page without the meta gets it too", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-confirm-"));
    const dir = await mkdtemp(join(tmpdir(), "atticus-ui-dist-"));
    await writeFile(
      join(dir, "index.html"),
      '<!doctype html><html><head><meta name="atticus-token" content="" /></head><body></body></html>',
    );
    const given = "k".repeat(43);
    const s = await startServer({ root, port: 0, staticDir: dir, watch: false, pageKey: given });
    const weak = await startServer({ root, port: 0, watch: false, pageKey: "short" });
    try {
      expect(s.pageKey).toBe(given);
      expect(await (await fetch(`${s.url}/`)).text()).toContain(
        `<meta name="atticus-page-key" content="${given}" />`,
      );
      expect(weak.pageKey).not.toBe("short");
    } finally {
      await s.close();
      await weak.close();
    }
  });
});
