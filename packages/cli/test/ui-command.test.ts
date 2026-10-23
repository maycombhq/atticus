import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startUi, untilStopped } from "../src/ui-commands.js";

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");

describe("atticus ui", () => {
  it("serves the built app with its session token and the API on 127.0.0.1", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-ui-cmd-"));
    await cp(join(FORGE, "metarepo"), root, { recursive: true });
    const srv = await startUi(root, { port: 0, user: "pat", version: "1.2.3" });
    try {
      const page = await (await fetch(srv.url + "/")).text();
      expect(page).toContain(`<meta name="atticus-token" content="${srv.token}" />`);
      expect(page).toMatch(/<script type="module"[^>]+src="\.\/assets\/index-[\w-]+\.js"/);
      const h = await fetch(srv.url + "/api/health", { headers: { "X-Atticus-Token": srv.token } });
      expect(await h.json()).toMatchObject({ user: "pat", version: "1.2.3" });
      expect((await fetch(srv.url + "/api/changes", { method: "POST" })).status).toBe(401);
    } finally {
      await srv.close();
    }
  });

  it("--embed vscode lets a VS Code panel frame the app (ADR 0091)", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-ui-cmd-"));
    await cp(join(FORGE, "metarepo"), root, { recursive: true });
    const srv = await startUi(root, { port: 0, user: "pat", embed: "vscode" });
    try {
      const page = await fetch(srv.url + "/");
      expect(page.headers.get("content-security-policy")).toMatch(
        /frame-ancestors vscode-webview:/,
      );
      expect(page.headers.get("x-frame-options")).toBeNull();
    } finally {
      await srv.close();
    }
  });

  it("--embed vscode stops when the extension's pipe on stdin closes, so no window leaves one behind", async () => {
    const stdin = new PassThrough();
    let done = false;
    const stopped = untilStopped(true, stdin).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    stdin.end();
    await stopped;
    expect(done).toBe(true);
  });

  it("without --embed, stdin closing doesn't stop it: only Ctrl+C does", async () => {
    const stdin = new PassThrough();
    let done = false;
    void untilStopped(false, stdin).then(() => (done = true));
    stdin.end();
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
  });
});
