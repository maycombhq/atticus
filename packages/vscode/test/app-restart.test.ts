import { describe, expect, it, vi } from "vitest";
import { Service } from "../src/service";

/**
 * Review round 46: the app (`atticus ui --embed vscode`) is started once per window, with the
 * atticus that atticus.path named and the metarepo open then. A new atticus.path, or another
 * metarepo, starts it again: the old one is stopped and the next call starts the new one.
 */
const state = vi.hoisted(() => ({
  path: "atticus",
  started: [] as { atticusPath: string; cwd: string; stopped: boolean }[],
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
});
