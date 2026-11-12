import { existsSync } from "node:fs";
import { chmod, cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, sharedLockFileOf } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { baseClonePath } from "@maycombhq/workspace";
import { extendUiRoutes } from "../src/ui-commands.js";

/**
 * Beta.27 review (blockers): Stop on a sync answered 200 and the sync ran on; and after the app
 * restarted, the jobs it had started were gone from the Console. Now Stop kills the git under
 * way, takes the half-made clone away and gives its lock back, the Console says "Stopping…" then
 * that it stopped; each job is kept in the run log, so a restarted app lists it, and one still
 * running when the app closed says it stopped then. A fake git that never finishes its clone (on
 * PATH for this test), no network; the Forge metarepo.
 */

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge/metarepo");
const posix = process.platform !== "win32";
let root: string;
let srv: RunningServer;
let path: string | undefined;

const call = async (s: RunningServer, method: string, p: string, body?: unknown) => {
  const r = await fetch(s.url + p, {
    method,
    headers: { "X-Atticus-Token": s.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const start = () =>
  startServer({
    root,
    port: 0,
    user: "pat",
    watch: false,
    runLog: true,
    extend: (r, ctx) => extendUiRoutes(r, ctx),
  });
const until = async (ok: () => boolean | Promise<boolean>, ms = 10_000) => {
  const t = Date.now();
  while (!(await ok()) && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 25));
};

beforeAll(async () => {
  if (!posix) return;
  root = await mkdtemp(join(tmpdir(), "atticus-sync-stop-"));
  await cp(FORGE, root, { recursive: true });
  // A git whose clone makes the folder, then never finishes; anything else is done at once.
  const bin = await mkdtemp(join(tmpdir(), "atticus-fake-git-"));
  await writeFile(
    join(bin, "git"),
    [
      "#!/bin/sh",
      'if [ "$1" = "clone" ]; then',
      "  for last; do :; done",
      '  mkdir -p "$last/.git" && echo half > "$last/half-written.txt"',
      "  sleep 600 &",
      "  wait",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  await chmod(join(bin, "git"), 0o755);
  path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path ?? ""}`;
  srv = await start();
});
afterAll(async () => {
  if (path !== undefined) process.env.PATH = path;
  await srv?.close();
});

describe.runIf(posix)("Stop on a sync, and the app's jobs across a restart", () => {
  it("stops the clone, takes the half-made folder away, gives the lock back, and says so", async () => {
    const started = await call(srv, "POST", "/api/workspace/sync", { repos: ["forge-ledger"] });
    expect(started.status).toBe(202);
    const jobId = String(started.body.jobId);
    const dest = baseClonePath(root, "forge-ledger");
    await until(() => existsSync(join(dest, "half-written.txt")));
    expect(existsSync(sharedLockFileOf(dest))).toBe(true);
    const stop = await call(srv, "POST", `/api/jobs/${jobId}/cancel`);
    expect(stop.status).toBe(200);
    // Heard at once: the job says it is stopping, in the Console too.
    const now = Api.Job.parse((await call(srv, "GET", `/api/jobs/${jobId}`)).body);
    if (now.state === "running") {
      expect(now.stopping).toBe(true);
      const list = Api.ActivityList.parse((await call(srv, "GET", "/api/activity")).body);
      expect(list.entries.find((e) => e.id === jobId)).toMatchObject({ stopping: true });
    }
    const end = await srv.jobs.settle(jobId, 15_000);
    expect(end.state).toBe("cancelled");
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(sharedLockFileOf(dest))).toBe(false);
    const lines = srv.jobs.linesOf(jobId)!.lines;
    expect(lines).toContain("Stopping…");
    expect(lines.join("\n")).toMatch(/forge-ledger: stopped/);
    expect(lines.at(-1)).toBe("Stopped.");
  }, 30_000);

  it("lists the app's jobs after a restart, one running when the app closed as stopped then", async () => {
    const done = Api.ActivityList.parse((await call(srv, "GET", "/api/activity")).body);
    const stopped = done.entries.find((e) => e.kind === "sync" && e.state === "cancelled")!;
    expect(stopped).toBeDefined();
    // Another sync, left running as the app closes.
    const again = await call(srv, "POST", "/api/workspace/sync", { repos: ["forge-ledger"] });
    expect(again.status).toBe(202);
    await until(() => existsSync(join(baseClonePath(root, "forge-ledger"), "half-written.txt")));
    await srv.close();
    srv = await start();
    const list = Api.ActivityList.parse((await call(srv, "GET", "/api/activity")).body);
    const syncs = list.entries.filter((e) => e.kind === "sync");
    expect(syncs).toHaveLength(2);
    for (const e of syncs) {
      expect(e.where).toBe("app");
      expect(e.id).toMatch(/^term-/);
      expect(e.stop).toBeUndefined();
    }
    const [closed, earlier] = syncs;
    expect(earlier!.state).toBe("cancelled");
    expect(closed!.state).toBe("ended");
    // Its lines are read from the run log, the app's close said at the end.
    const l = Api.ActivityLines.parse(
      (await call(srv, "GET", `/api/activity/${closed!.id}/lines`)).body,
    );
    expect(l.lines.at(-1)).toBe("Stopped when the app closed.");
    // This app's own new jobs are listed once (as jobs, not again from the run log).
    const own = srv.jobs.start("work", async () => undefined, { title: "Request" });
    await srv.jobs.settle(own.id);
    const after = Api.ActivityList.parse((await call(srv, "GET", "/api/activity")).body);
    expect(after.entries.filter((e) => e.title === "Request" && e.where === "app")).toHaveLength(1);
  }, 60_000);
});
