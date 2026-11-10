import { describe, expect, it, vi } from "vitest";
import { APP_START_BACKOFF_MS, Service } from "../src/service";

/**
 * Review round 46: the app (`atticus ui --embed vscode`) is started once per window, with the
 * atticus that atticus.path named and the metarepo open then. A new atticus.path, or another
 * metarepo, starts it again: the old one is stopped and the next call starts the new one.
 */
const state = vi.hoisted(() => ({
  path: "atticus",
  started: [] as { atticusPath: string; cwd: string; stopped: boolean }[],
  fail: false,
}));

vi.mock("vscode", () => {
  class EventEmitter {
    event = () => ({ dispose: () => undefined });
    fire() {}
  }
  return {
    EventEmitter,
    window: {
      createOutputChannel: () => ({
        appendLine: () => undefined,
        append: () => undefined,
        show: () => undefined,
        dispose: () => undefined,
      }),
    },
    workspace: {
      workspaceFolders: [],
      getConfiguration: () => ({
        get: <T>(key: string, fallback: T): T => (key === "path" ? (state.path as T) : fallback),
      }),
    },
    lm: { selectChatModels: async () => [] },
  };
});

vi.mock("../src/app-panel", () => ({
  startApp: async (o: { atticusPath: string; cwd: string }) => {
    const app = { atticusPath: o.atticusPath, cwd: o.cwd, stopped: false };
    state.started.push(app);
    if (state.fail) throw new Error("atticus ui exited with code 1");
    return {
      url: "http://127.0.0.1:1",
      token: "t",
      stop: () => {
        app.stopped = true;
      },
      onExit: () => undefined,
    };
  },
}));

describe("the app the extension started", () => {
  it("starts again for a new atticus.path or another metarepo, stopping the one before", async () => {
    const svc = new Service();
    await svc.runningApp("/m1");
    await svc.runningApp("/m1");
    expect(state.started).toHaveLength(1);
    state.path = "/opt/atticus/bin/atticus";
    await svc.runningApp("/m1");
    expect(state.started.map((a) => [a.atticusPath, a.cwd, a.stopped])).toEqual([
      ["atticus", "/m1", true],
      ["/opt/atticus/bin/atticus", "/m1", false],
    ]);
    await svc.runningApp("/m2");
    expect(state.started.map((a) => [a.cwd, a.stopped])).toEqual([
      ["/m1", true],
      ["/m1", true],
      ["/m2", false],
    ]);
    expect(svc.appStale("/m2")).toBe(false);
    expect(svc.appStale("/m3")).toBe(true);
  });

  it("after a failed start, doesn't start it again on every call, only when asked or after a while (review of beta.23)", async () => {
    state.started.length = 0;
    state.path = "atticus";
    state.fail = true;
    const svc = new Service();
    let t = 1_000_000;
    svc.now = () => t;
    await expect(svc.runningApp("/m9")).rejects.toThrow(/exited with code 1/);
    // The Console's polls and the page's calls: no new start, the same reason said.
    await expect(svc.runningApp("/m9")).rejects.toThrow(/exited with code 1/);
    await expect(svc.api("/m9")).rejects.toThrow(/exited with code 1/);
    expect(state.started).toHaveLength(1);
    // Open the app (an explicit retry) starts it again.
    await expect(svc.runningApp("/m9", { retry: true })).rejects.toThrow();
    expect(state.started).toHaveLength(2);
    // And so does a call after the back-off.
    t += APP_START_BACKOFF_MS + 1;
    state.fail = false;
    await svc.runningApp("/m9");
    expect(state.started).toHaveLength(3);
    // Started: calls use it, nothing starts again.
    await svc.runningApp("/m9");
    expect(state.started).toHaveLength(3);
  });
});
