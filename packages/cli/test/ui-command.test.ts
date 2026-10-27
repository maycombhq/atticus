import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { readCatalog } from "@maycombhq/scanner";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startedLines, startUi, untilStopped } from "../src/ui-commands.js";

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");

describe("atticus ui", () => {
  it("prints the session token only for an editor that started it, or when asked (ADR 0119)", () => {
    const url = "http://127.0.0.1:4321";
    const said = (o: Parameters<typeof startedLines>[2]) =>
      startedLines(url, "tok-1", o).join("\n");
    expect(said({})).not.toContain("tok-1");
    expect(said({})).toContain("--show-token");
    expect(said({ showToken: true })).toContain("the session token is tok-1");
    // An editor that starts it gives it the token (VS Code) or reads the page (IntelliJ): it is
    // never printed there, so it can't reach the editor's output log, even when asked.
    for (const o of [
      { embed: "vscode" as const },
      { parent: 42 },
      { embed: "vscode" as const, showToken: true },
    ]) {
      expect(said(o)).not.toContain("tok-1");
      expect(said(o)).toContain("session token isn't printed");
    }
  });

  it("takes the session token the editor gives it (ATTICUS_UI_TOKEN), and only a strong one", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-ui-cmd-"));
    await cp(join(FORGE, "metarepo"), root, { recursive: true });
    const given = "editor-made-token-0123456789abcdefghijklmnopqrstuvwxyz";
    const srv = await startUi(root, { port: 0, user: "pat", token: given });
    try {
      expect(srv.token).toBe(given);
      const h = await fetch(srv.url + "/api/health", { headers: { "X-Atticus-Token": given } });
      expect(h.status).toBe(200);
    } finally {
      await srv.close();
    }
    const weak = await startUi(root, { port: 0, user: "pat", token: "short" });
    try {
      expect(weak.token).not.toBe("short");
    } finally {
      await weak.close();
    }
  });

  it("serves the built app with its session token and the API on 127.0.0.1", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-ui-cmd-"));
    await cp(join(FORGE, "metarepo"), root, { recursive: true });
    const srv = await startUi(root, { port: 0, user: "pat", version: "1.2.3" });
    try {
      const page = await (await fetch(srv.url + "/")).text();
      expect(page).toContain(`<meta name="atticus-token" content="${srv.token}" />`);
      expect(page).toMatch(/<script type="module"[^>]+src="\.\/assets\/index-[\w-]+\.js"/);
      const h = await fetch(srv.url + "/api/health", { headers: { "X-Atticus-Token": srv.token } });
      expect(await h.json()).toMatchObject({ user: "pat", version: "1.2.3", full: false });
      expect((await fetch(srv.url + "/api/changes", { method: "POST" })).status).toBe(401);
    } finally {
      await srv.close();
    }
  });

  it("tells the app it was started with --full, so every page is in the menu", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-ui-cmd-"));
    await cp(join(FORGE, "metarepo"), root, { recursive: true });
    const srv = await startUi(root, { port: 0, user: "pat", full: true });
    try {
      const h = await fetch(srv.url + "/api/health", { headers: { "X-Atticus-Token": srv.token } });
      expect(await h.json()).toMatchObject({ full: true });
    } finally {
      await srv.close();
    }
  });

  it("keeps the catalog in memory while it runs, and reads it again when a file changes (ADR 0119)", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-ui-cmd-"));
    await cp(join(FORGE, "metarepo"), root, { recursive: true });
    const dir = join(root, "catalog", "generated", "datastore");
    await mkdir(dir, { recursive: true });
    const store = (type: string) =>
      [
        "schemaVersion: 2",
        "kind: DataStore",
        "id: probe-db",
        "status: current",
        "confidence: verified",
        "evidence:",
        "  - commit: 6ef8ed0f115024e860c495e84875f1926c412036",
        "    extractor: migrations@1.3.0",
        "    line: 1",
        "    path: probe/V1__init.sql",
        "    repo: probe",
        "    scannedAt: 2026-10-20T20:14:16.096Z",
        "    source: migration",
        "ownerComponent: probe",
        `storeType: ${type}`,
        "",
      ].join("\n");
    await writeFile(join(dir, "probe-db.yaml"), store("postgres"));
    const srv = await startUi(root, { port: 0 });
    const typeNow = async () =>
      (
        (await readCatalog(join(root, "catalog", "generated"))).records.find(
          (r) => r.id === "probe-db",
        ) as { storeType?: string } | undefined
      )?.storeType;
    try {
      expect(await typeNow()).toBe("postgres");
      await writeFile(join(dir, "probe-db.yaml"), store("h2"));
      // The watcher hears the write and the kept catalog is forgotten.
      let seen: string | undefined;
      for (let i = 0; i < 40 && seen !== "h2"; i++) {
        await new Promise((r) => setTimeout(r, 100));
        seen = await typeNow();
      }
      expect(seen).toBe("h2");
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

  it("--parent <pid> stops when the editor that started it is gone, however it ended", async () => {
    let alive = true;
    let done = false;
    const stopped = untilStopped(false, new PassThrough(), {
      parent: 4242,
      alive: (pid) => pid === 4242 && alive,
      everyMs: 5,
    }).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    alive = false;
    await stopped;
    expect(done).toBe(true);
  });
});
