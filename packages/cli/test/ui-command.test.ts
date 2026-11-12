import { existsSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readCatalog } from "@maycombhq/scanner";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startedLines, startUi, uiRequestLogger, untilStopped } from "../src/ui-commands.js";

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");

describe("atticus ui", () => {
  it("prints the session token only for an editor that started it, or when asked (ADR 0119)", () => {
    const url = "http://127.0.0.1:4321";
    const said = (o: Parameters<typeof startedLines>[2]) =>
      startedLines(url, "tok-1", o).join("\n");
    expect(said({})).not.toContain("tok-1");
    expect(said({})).toContain("--show-token");
    expect(said({ showToken: true })).toContain("the session token is tok-1");
    // ADR 0186: and that it approves no write to a shared system.
    expect(said({ showToken: true })).toMatch(/doesn't approve a write to a shared system/);
    expect(said({ showToken: true })).toMatch(/the session token is tok-1\n/);
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

/**
 * Beta.27 re-review: the app's jobs were kept in the run log where a command run wouldn't be:
 * `atticus ui` in a bare folder made `.atticus/logs/` there, and ATTICUS_RUN_LOG=off was not
 * heard. A sync's job, in a bare folder and with the log off; no network (no repos to clone).
 */
describe("atticus ui and the run log", () => {
  const syncAndWait = async (srv: Awaited<ReturnType<typeof startUi>>) => {
    const h = { "X-Atticus-Token": srv.token, "Content-Type": "application/json" };
    expect((await fetch(srv.url + "/api/health", { headers: h })).status).toBe(200);
    const r = await fetch(srv.url + "/api/workspace/sync", {
      method: "POST",
      headers: h,
      body: "{}",
    });
    const body = (await r.json()) as { jobId?: string };
    for (let i = 0; body.jobId && i < 200; i++) {
      const j = (await (
        await fetch(`${srv.url}/api/jobs/${body.jobId}`, { headers: h })
      ).json()) as { state?: string };
      if (j.state !== "running" && j.state !== "queued") break;
      await new Promise((res) => setTimeout(res, 25));
    }
  };

  it("in a bare folder, makes nothing there", async () => {
    const bare = await mkdtemp(join(tmpdir(), "atticus-ui-bare-"));
    const srv = await startUi(bare, { port: 0, user: "pat", runLog: true });
    try {
      await syncAndWait(srv);
    } finally {
      await srv.close();
    }
    expect(readdirSync(bare)).toEqual([]);
    await rm(bare, { recursive: true, force: true });
  }, 60_000);

  it("with ATTICUS_RUN_LOG=off, keeps no job in the run log", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-ui-cmd-"));
    await cp(join(FORGE, "metarepo"), root, { recursive: true });
    const was = process.env.ATTICUS_RUN_LOG;
    process.env.ATTICUS_RUN_LOG = "off";
    const srv = await startUi(root, { port: 0, user: "pat", runLog: true });
    try {
      await syncAndWait(srv);
    } finally {
      await srv.close();
      if (was === undefined) delete process.env.ATTICUS_RUN_LOG;
      else process.env.ATTICUS_RUN_LOG = was;
    }
    expect(existsSync(join(root, ".atticus", "logs", "running"))).toBe(false);
    await rm(root, { recursive: true, force: true });
  }, 60_000);
});

/**
 * Beta.27 re-review (plumbing): a bare folder keeps no log, so a failed call there went nowhere.
 * Its error, or a 500, is said on standard error instead (redacted as the log is); the metarepo's
 * calls still go to its log, never to the terminal.
 */
describe("a failed call of atticus ui in a bare folder", () => {
  const failed = {
    method: "GET",
    path: "/api/repos",
    status: 500,
    ms: 3,
    error: new Error("can't read https://ci:hunter2secret@git.forge.example/forge-ledger.git"),
  };

  it("is said on standard error, redacted, and nothing is made there", async () => {
    const bare = await mkdtemp(join(tmpdir(), "atticus-ui-bare-err-"));
    const said: string[] = [];
    const on = uiRequestLogger(bare, (l) => said.push(l));
    on(failed);
    on({ method: "GET", path: "/api/health", status: 503, ms: 1 });
    on({ method: "GET", path: "/api/health", status: 200, ms: 1 });
    on({ method: "GET", path: "/api/nope", status: 404, ms: 1 });
    expect(said).toHaveLength(2);
    expect(said[0]).toMatch(/GET \/api\/repos failed \(500\): can't read/);
    expect(said[0]).not.toContain("hunter2secret");
    expect(said[1]).toBe("atticus ui: GET /api/health answered 503");
    expect(readdirSync(bare)).toEqual([]);
    await rm(bare, { recursive: true, force: true });
  });

  it("at a metarepo goes to its log, not to the terminal", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-ui-cmd-err-"));
    await cp(join(FORGE, "metarepo"), root, { recursive: true });
    const said: string[] = [];
    uiRequestLogger(root, (l) => said.push(l))(failed);
    expect(said).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });
});
