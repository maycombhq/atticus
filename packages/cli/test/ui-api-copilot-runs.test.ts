import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import type { MapAllOptions } from "../src/map-all.js";
import {
  uiCopilotRunRoutes,
  type AssistantFilesCheck,
  type MapAllStarter,
} from "../src/ui-api-copilot-runs.js";

/** beta.27: the assistant files as a check sees them: all current, unless a test says. */
const current0: AssistantFilesCheck = async () => ({
  results: [{ path: ".github/prompts/atticus-map.prompt.md", action: "unchanged", written: false }],
});
/** beta.27: a Copilot-only metarepo names no limit: the dialog's is sent with each start. */
const LIMIT = { maxTokens: 128_000 };

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
    extend: (r, ctx) =>
      uiCopilotRunRoutes(r, ctx, { start: starter, flushMs: 1, assistantFiles: current0 }),
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
      ...LIMIT,
    });
    expect(r.status).toBe(202);
    const started = Api.CopilotRunView.parse(r.body);
    expect(started).toMatchObject({ state: "running", by: "pat", model: "claude-sonnet-5" });
    expect(asked[0]).toMatchObject({
      mode: "copilot-acp",
      repos: ["forge-ledger"],
      force: true,
      maxTokens: 128_000,
    });
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
    expect((await call(srv, "POST", "/api/copilot-runs", { kind: "stale", ...LIMIT })).status).toBe(
      409,
    );

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
    const r = await call(srv, "POST", "/api/copilot-runs", { kind: "stale", ...LIMIT });
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

  it("tells the pages the facts changed when the run fails part-way", async () => {
    const failing = await startServer({
      root: await metarepo(RUNTIME_ACP),
      port: 0,
      extend: (r, ctx) =>
        uiCopilotRunRoutes(r, ctx, {
          flushMs: 1,
          assistantFiles: current0,
          start: async (_o, io, deps) => {
            deps.onEvent?.({
              type: "plan",
              repos: [{ repo: "forge-ledger", kind: "read", parts: 1 }],
            });
            io.out("one repo written");
            throw new Error("the second repo's clone is gone");
          },
        }),
    });
    const seen: Record<string, unknown>[] = [];
    failing.events.listen((e) => seen.push(e as Record<string, unknown>));
    try {
      expect(
        (await call(failing, "POST", "/api/copilot-runs", { kind: "stale", ...LIMIT })).status,
      ).toBe(202);
      await until(async () => (await current(failing)).run?.state === "failed");
      expect(seen.some((e) => e.type === "file.changed" && e.path === "facts")).toBe(true);
    } finally {
      await failing.close();
    }
  });

  it("beta.28: Stop ends the run's view within its grace; a new run waits, named, until the work really ends", async () => {
    // Field report: Stop, then "running" for 50 minutes. Whatever the work is waiting on, the
    // person's Stop ends the run's view; the work still ending keeps a second run from writing
    // facts beside it, and says so, until it has ended.
    let finish: (() => void) | undefined;
    let heard = false;
    let starts = 0;
    const stuck = await startServer({
      root: await metarepo(RUNTIME_ACP),
      port: 0,
      extend: (r, ctx) =>
        uiCopilotRunRoutes(r, ctx, {
          flushMs: 1,
          assistantFiles: current0,
          stopGraceMs: 50,
          start: async (_o, io, deps) => {
            if (++starts > 1) return 0;
            deps.signal?.addEventListener("abort", () => (heard = true));
            deps.onEvent?.({ type: "repo", repo: "forge-ledger", index: 1, total: 1, why: "x" });
            deps.onEvent?.({
              type: "session",
              repo: "forge-ledger",
              label: "part 1 of 6",
              line: "/atticus-map forge-ledger --part 1",
              attempt: 0,
            });
            io.out("waiting on something that never ends");
            await new Promise<void>((res) => (finish = res));
            io.out("the work ended at last");
            return 0;
          },
        }),
    });
    const seen: Record<string, unknown>[] = [];
    stuck.events.listen((e) => seen.push(e as Record<string, unknown>));
    try {
      const r = await call(stuck, "POST", "/api/copilot-runs", { kind: "stale", ...LIMIT });
      const id = String(r.body.runId);
      await until(async () => !!finish);
      expect((await call(stuck, "POST", `/api/copilot-runs/${id}/stop`)).status).toBe(200);
      await until(async () => (await current(stuck)).run?.state === "stopped");
      expect(heard).toBe(true);
      const run = (await current(stuck)).run!;
      // Said as it is: the work is still ending, where it was, and when a new run can start.
      expect(run.tabs[0]!.lines.at(-1)).toBe(
        "The run didn't end within a few seconds of Stop, so it is shown stopped here; it was last in a Copilot session (forge-ledger, part 1 of 6). Its work is still ending: a new run can start once it has.",
      );
      // A new run waits for it, and the refusal names the stopped run.
      const again = await call(stuck, "POST", "/api/copilot-runs", { kind: "stale", ...LIMIT });
      expect(again.status).toBe(409);
      expect(String(again.body.detail)).toBe(
        `The stopped run ${id} is still ending its work (it was last in a Copilot session (forge-ledger, part 1 of 6)): a new run can start once it has.`,
      );
      // The work ends: said, the state and the facts published, and a new run starts.
      const before = seen.length;
      finish!();
      await until(async () =>
        (await current(stuck)).run!.tabs[0]!.lines.includes(
          "The stopped run's work has ended: a new run can start.",
        ),
      );
      const after = (await current(stuck)).run!;
      expect(after.state).toBe("stopped");
      expect(after.tabs[0]!.lines).not.toContain("the work ended at last");
      const late = seen.slice(before);
      expect(late.some((e) => e.type === "copilot-run.state")).toBe(true);
      expect(late.some((e) => e.type === "file.changed" && e.path === "facts")).toBe(true);
      await until(async () => {
        const n = await call(stuck, "POST", "/api/copilot-runs", { kind: "stale", ...LIMIT });
        return n.status === 202;
      });
    } finally {
      finish?.();
      await stuck.close();
    }
  });

  it("starts only one of two asks that come at once (a double click, or two windows)", async () => {
    const [x, y] = await Promise.all([
      call(srv, "POST", "/api/copilot-runs", { kind: "gaps", ...LIMIT }),
      call(srv, "POST", "/api/copilot-runs", { kind: "gaps", ...LIMIT }),
    ]);
    expect([x.status, y.status].sort()).toEqual([202, 409]);
    const started = x.status === 202 ? x : y;
    await until(async () => (await current()).run?.tabs.length === 2);
    expect(
      (await call(srv, "POST", `/api/copilot-runs/${String(started.body.runId)}/stop`)).status,
    ).toBe(200);
    await until(async () => (await current()).run?.state === "stopped");
  });

  it("beta.27: asks for the model's limit where none is known, passes it as --max-tokens and fills it in next time", async () => {
    const root = await metarepo(RUNTIME_ACP);
    const one = await startServer({
      root,
      port: 0,
      extend: (r, ctx) =>
        uiCopilotRunRoutes(r, ctx, { start: starter, flushMs: 1, assistantFiles: current0 }),
    });
    try {
      // No adapters.model and no probe: the dialog asks, with nothing to fill it with yet.
      expect((await current(one)).limit).toEqual({ known: false });
      const no = await call(one, "POST", "/api/copilot-runs", { kind: "all" });
      expect(no.status).toBe(400);
      expect(no.body.code).toBe("limit-unknown");
      expect(String(no.body.detail)).toContain("Your model's limit, in tokens");
      expect(
        (await call(one, "POST", "/api/copilot-runs", { kind: "all", maxTokens: 12 })).status,
      ).toBe(400);
      asked = [];
      const r = await call(one, "POST", "/api/copilot-runs", { kind: "all", maxTokens: 128_000 });
      expect(r.status).toBe(202);
      expect(asked[0]).toMatchObject({ mode: "copilot-acp", maxTokens: 128_000 });
      // Kept on this machine (never the org pack), and offered the next time.
      const kept = JSON.parse(
        await readFile(join(root, ".atticus", "map-all", "limit.json"), "utf8"),
      );
      expect(kept).toMatchObject({ maxTokens: 128_000 });
      expect((await current(one)).limit).toEqual({ known: false, tokens: 128_000, from: "last" });
      await call(one, "POST", `/api/copilot-runs/${String(r.body.runId)}/stop`);
      await until(async () => (await current(one)).run?.state === "stopped");
    } finally {
      await one.close();
    }
    // A limit runtime.yaml names is known: nothing to ask, and the run reads at it.
    const named = await startServer({
      root: await metarepo(
        `${RUNTIME_ACP}adapters: { model: { type: openai-compatible, settings: { maxInput: 64000 } } }\n`,
      ),
      port: 0,
      extend: (r, ctx) =>
        uiCopilotRunRoutes(r, ctx, { start: starter, flushMs: 1, assistantFiles: current0 }),
    });
    try {
      const c = await current(named);
      expect(c.allowed).toBe(true);
      expect(c.limit).toEqual({ known: true, tokens: 64000, from: "runtime.yaml" });
    } finally {
      await named.close();
    }
  });

  it("beta.27: says the assistant files are out of date (the run writes them), and refuses one edited by hand", async () => {
    let results: Awaited<ReturnType<AssistantFilesCheck>>["results"] = [
      { path: ".github/prompts/atticus-map.prompt.md", action: "updated", written: false },
      { path: ".claude/commands/atticus-map.md", action: "updated", written: false },
    ];
    const files = await startServer({
      root: await metarepo(RUNTIME_ACP),
      port: 0,
      extend: (r, ctx) =>
        uiCopilotRunRoutes(r, ctx, {
          start: starter,
          flushMs: 1,
          assistantFiles: async () => ({ results }),
        }),
    });
    try {
      expect((await current(files)).assistantFiles).toEqual({
        upToDate: false,
        stale: [".github/prompts/atticus-map.prompt.md", ".claude/commands/atticus-map.md"],
        edited: [],
      });
      results = [
        { path: ".github/prompts/atticus-map.prompt.md", action: "kept-edited", written: false },
      ];
      const r = await call(files, "POST", "/api/copilot-runs", { kind: "all", ...LIMIT });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("assistant-files-edited");
      expect(String(r.body.detail)).toContain(".github/prompts/atticus-map.prompt.md");
      expect(String(r.body.detail)).toContain("no session was started");
      // And the page's next look says so.
      expect((await current(files)).assistantFiles?.edited).toEqual([
        ".github/prompts/atticus-map.prompt.md",
      ]);
    } finally {
      await files.close();
    }
  });

  it("names the files of a person's that the run adds Atticus's section to", async () => {
    const files = await startServer({
      root: await metarepo(RUNTIME_ACP),
      port: 0,
      extend: (r, ctx) =>
        uiCopilotRunRoutes(r, ctx, {
          start: starter,
          flushMs: 1,
          assistantFiles: async () => ({
            results: [
              {
                path: ".github/copilot-instructions.md",
                action: "updated",
                written: false,
                addsSection: true,
              },
              { path: ".github/prompts/atticus-map.prompt.md", action: "updated", written: false },
            ],
          }),
        }),
    });
    try {
      expect((await current(files)).assistantFiles).toEqual({
        upToDate: false,
        stale: [".github/copilot-instructions.md", ".github/prompts/atticus-map.prompt.md"],
        edited: [],
        shared: [".github/copilot-instructions.md"],
      });
    } finally {
      await files.close();
    }
  });

  it("keeps the limit given only for a run that starts: a step started meanwhile keeps none", async () => {
    const root = await metarepo(RUNTIME_ACP);
    let done: (() => void) | undefined;
    const one = await startServer({
      root,
      port: 0,
      extend: (r, ctx) =>
        uiCopilotRunRoutes(r, ctx, {
          start: starter,
          flushMs: 1,
          // While the start reads the assistant files, an AI step starts on this server.
          assistantFiles: async () => {
            if (!done) ctx.jobs.start("step", () => new Promise<void>((res) => (done = res)));
            return current0(root);
          },
        }),
    });
    try {
      const r = await call(one, "POST", "/api/copilot-runs", { kind: "all", maxTokens: 96_000 });
      expect(r.status).toBe(409);
      expect(String(r.body.detail)).toContain("An AI step started on this server meanwhile");
      await expect(
        readFile(join(root, ".atticus", "map-all", "limit.json"), "utf8"),
      ).rejects.toThrow();
    } finally {
      done?.();
      await one.close();
    }
  });
});
