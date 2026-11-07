import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import type { MapAllOptions } from "../src/map-all.js";
import { uiCopilotRunRoutes, type MapAllStarter } from "../src/ui-api-copilot-runs.js";

/**
 * ADR 0173: an unattended Copilot run started from the app. The run itself is a stand-in that
 * says and reports what `map --all` would (its real events are checked in map-all-acp-cli); here
 * the route: the yes it needs (copilot-acp allowed), one run at a time, the progress and Console
 * tabs it keeps for a reload, the live events, and Stop. No network, no Copilot.
 */

const RUNTIME_ACP = `schemaVersion: 3
assistants: { allowed: [copilot], default: copilot }
modes: { allowed: [hand-off, copilot-acp], default: copilot-acp }
copilotAcp: { command: npx --yes @github/copilot-language-server, model: claude-sonnet-5 }
`;

const metarepo = async (runtime?: string) => {
  const root = await mkdtemp(join(tmpdir(), "atticus-copilot-runs-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  if (runtime) await writeFile(join(root, "org-pack", "runtime.yaml"), runtime);
  return root;
};

let asked: MapAllOptions[] = [];
let release: (() => void) | undefined;

/** Reads forge-ledger in one session, then waits until released or stopped. */
const starter: MapAllStarter = async (o, io, deps) => {
  asked.push(o);
  deps.onEvent?.({ type: "plan", repos: [{ repo: "forge-ledger", kind: "read", parts: 1 }] });
  io.out("The estate at 100,000 tokens a prompt.");
  deps.onEvent?.({ type: "repo", repo: "forge-ledger", index: 1, total: 1, why: "not read" });
  io.out("===== forge-ledger, one session (repo 1 of 1) =====");
  deps.onEvent?.({
    type: "session",
    repo: "forge-ledger",
    label: "one session",
    line: "/atticus-map forge-ledger",
    attempt: 0,
  });
  io.out("  · Read AccountController.java");
  await new Promise<void>((res) => {
    release = res;
    deps.signal?.addEventListener("abort", () => res(), { once: true });
  });
  if (deps.signal?.aborted) {
    deps.onEvent?.({ type: "session.end", repo: "forge-ledger", ended: "stopped (Ctrl+C)" });
    return 130;
  }
  deps.onEvent?.({ type: "session.end", repo: "forge-ledger", ended: "end_turn", tokens: 1200 });
  io.out("forge-ledger: 12 facts kept, 0 rejected; coverage 90%");
  deps.onEvent?.({
    type: "verify",
    repo: "forge-ledger",
    kept: 12,
    rejected: 0,
    coverage: 0.9,
    open: 1,
  });
  return 0;
};

let srv: RunningServer;
let off: RunningServer;
const events: Record<string, unknown>[] = [];

beforeAll(async () => {
  srv = await startServer({
    root: await metarepo(RUNTIME_ACP),
    port: 0,
    user: "pat",
    extend: (r, ctx) => uiCopilotRunRoutes(r, ctx, { start: starter, flushMs: 1 }),
  });
  srv.events.listen((e) => events.push(e as Record<string, unknown>));
  off = await startServer({
    root: await metarepo(),
    port: 0,
    extend: (r, ctx) => uiCopilotRunRoutes(r, ctx, { start: starter }),
  });
});
afterAll(async () => {
  await srv?.close();
  await off?.close();
});

const call = async (s: RunningServer, method: string, path: string, body?: unknown) => {
  const r = await fetch(s.url + path, {
    method,
    headers: { "X-Atticus-Token": s.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const current = async (s = srv) =>
  Api.CopilotRunCurrent.parse((await call(s, "GET", "/api/copilot-runs/current")).body);
const until = async (ok: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("never happened");
};

describe("an unattended Copilot run started from the app (ADR 0173)", () => {
  it("is refused where runtime.yaml doesn't allow copilot-acp, saying how to read instead", async () => {
    const c = await current(off);
    expect(c).toMatchObject({ run: null, allowed: false });
    expect(c.why).toContain("Copilot Chat");
    const r = await call(off, "POST", "/api/copilot-runs", { kind: "stale" });
    expect(r.status).toBe(409);
  });

  it("refuses a body it can't read, and repos with none named (400)", async () => {
    expect((await call(srv, "POST", "/api/copilot-runs", { kind: "soon" })).status).toBe(400);
    expect((await call(srv, "POST", "/api/copilot-runs", { kind: "repos" })).status).toBe(400);
  });

  it("starts, shows progress and a tab per session, refuses a second, and finishes", async () => {
    asked = [];
    const r = await call(srv, "POST", "/api/copilot-runs", {
      kind: "repos",
      repos: ["forge-ledger"],
      force: true,
    });
    expect(r.status).toBe(202);
    const started = Api.CopilotRunView.parse(r.body);
    expect(started).toMatchObject({ state: "running", by: "pat", model: "claude-sonnet-5" });
    expect(asked[0]).toMatchObject({ mode: "copilot-acp", repos: ["forge-ledger"], force: true });
    await until(async () => (await current()).run?.tabs.length === 2);
    const mid = (await current()).run!;
    expect(mid.progress).toMatchObject({
      repos: 1,
      repoIndex: 1,
      repo: "forge-ledger",
      session: "forge-ledger, one session",
      sessions: 1,
    });
    expect(mid.tabs[1]).toMatchObject({ title: "forge-ledger, one session", state: "running" });
    expect(mid.tabs[1]!.lines).toContain("  · Read AccountController.java");
    expect(mid.tabs[0]!.lines).toContain("The estate at 100,000 tokens a prompt.");
    expect((await call(srv, "POST", "/api/copilot-runs", { kind: "stale" })).status).toBe(409);

    release!();
    await until(async () => (await current()).run?.state === "done");
    const end = (await current()).run!;
    expect(end.totals).toEqual({ kept: 12, rejected: 0, tokens: 1200 });
    expect(end.tabs[1]).toMatchObject({ state: "ended", ended: "end_turn" });
    expect(end.tabs[1]!.lines).toContain("forge-ledger: 12 facts kept, 0 rejected; coverage 90%");
    expect(end.tabs[0]!.lines.at(-1)).toBe("The run finished.");
    // A poll can ask for each tab's last lines only, and a tab's lines from a line on.
    const tail = Api.CopilotRunCurrent.parse(
      (await call(srv, "GET", "/api/copilot-runs/current?tail=1")).body,
    ).run!;
    const all = end.tabs[1]!.lines;
    expect(tail.tabs[1]).toMatchObject({ from: all.length - 1, lines: [all.at(-1)] });
    const from1 = await call(srv, "GET", `/api/copilot-runs/${end.runId}/tabs/s1?from=1`);
    expect(from1.body).toMatchObject({ id: "s1", from: 1, lines: all.slice(1) });
    expect((await call(srv, "GET", `/api/copilot-runs/${end.runId}/tabs/s9`)).status).toBe(404);
    expect((await call(srv, "GET", "/api/copilot-runs/copilot-run-x/tabs/s1")).status).toBe(404);
    // The page heard it live.
    const live = events.map((e) => Api.LiveEvent.parse(e));
    expect(live.some((e) => e.type === "copilot-run.state" && e.run.state === "done")).toBe(true);
    const lines = live.filter((e) => e.type === "copilot-run.lines");
    expect(
      lines.some((e) => e.tab === "s1" && e.lines.includes("  · Read AccountController.java")),
    ).toBe(true);
  });

  it("stops a run under way: the session is cancelled and the run says the next carries on", async () => {
    const r = await call(srv, "POST", "/api/copilot-runs", { kind: "stale" });
    expect(r.status).toBe(202);
    const id = String(r.body.runId);
    expect(asked.at(-1)).toMatchObject({ mode: "copilot-acp", stale: true });
    await until(async () => (await current()).run?.tabs.length === 2);
    expect((await call(srv, "POST", "/api/copilot-runs/nope/stop")).status).toBe(404);
    expect((await call(srv, "POST", `/api/copilot-runs/${id}/stop`)).status).toBe(200);
    await until(async () => (await current()).run?.state === "stopped");
    const end = (await current()).run!;
    expect(end.tabs[1]).toMatchObject({ state: "ended", ended: "stopped (Ctrl+C)" });
    expect(end.tabs[0]!.lines.at(-1)).toBe("Stopped. The next run carries on from here.");
    expect((await call(srv, "POST", `/api/copilot-runs/${id}/stop`)).status).toBe(409);
  });

  it("starts only one of two asks that come at once (a double click, or two windows)", async () => {
    const [x, y] = await Promise.all([
      call(srv, "POST", "/api/copilot-runs", { kind: "gaps" }),
      call(srv, "POST", "/api/copilot-runs", { kind: "gaps" }),
    ]);
    expect([x.status, y.status].sort()).toEqual([202, 409]);
    const started = x.status === 202 ? x : y;
    await until(async () => (await current()).run?.tabs.length === 2);
    expect(
      (await call(srv, "POST", `/api/copilot-runs/${String(started.body.runId)}/stop`)).status,
    ).toBe(200);
    await until(async () => (await current()).run?.state === "stopped");
  });
});
