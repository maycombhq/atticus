import { afterEach, describe, expect, it } from "vitest";
import {
  appMemory,
  appMemoryApplied,
  appMemoryHeld,
  appMemoryInUse,
  onAppMemoryRelease,
  startAppMemory,
  stopAppMemory,
  systemMemoryOf,
} from "../src/index.js";

/**
 * ADR 0205 step 4 (the owner's answer of 2026-11-19): what the app's server keeps is let go after
 * ten minutes with no Apply, at once when memory runs low (the heap three quarters full, or the
 * machine's or the container's memory nearly used), checked on a timer as well as on each use,
 * and when the last server closes; nothing is kept outside a server.
 */
const was = { ...appMemory };
afterEach(() => {
  while (appMemory.on) stopAppMemory();
  Object.assign(appMemory, was);
  delete appMemory.system;
});

const MB = 1024 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the app's memory (ADR 0205 step 4)", () => {
  it("keeps nothing outside a server", () => {
    expect(appMemory.on).toBe(false);
    expect(appMemoryInUse()).toBe(false);
  });

  it("lets go ten idle minutes after the last Apply: a use that isn't an Apply doesn't count", async () => {
    let released = 0;
    onAppMemoryRelease(() => released++);
    startAppMemory();
    appMemory.idleMs = 150;
    appMemoryApplied();
    await sleep(60);
    // A page's read of a facts file (parseFacts), a preview's build: uses, not Applies.
    expect(appMemoryInUse()).toBe(true);
    await sleep(60);
    expect(appMemoryInUse()).toBe(true);
    await sleep(80);
    expect(released, "let go 150 ms after the Apply, the uses since not counted").toBe(1);
  });

  it("an Apply starts the ten minutes again", async () => {
    let released = 0;
    onAppMemoryRelease(() => released++);
    startAppMemory();
    appMemory.idleMs = 150;
    appMemoryApplied();
    await sleep(90);
    appMemoryApplied();
    await sleep(90);
    expect(released).toBe(0);
    await sleep(120);
    expect(released).toBe(1);
  });

  it("lets go of what was kept with no Apply since, ten minutes after it was kept", async () => {
    let released = 0;
    onAppMemoryRelease(() => released++);
    appMemory.idleMs = 100;
    startAppMemory();
    await sleep(150);
    // Let go once at the start's ten minutes; then a keeper keeps again (a page's read).
    expect(released).toBe(1);
    expect(appMemoryInUse()).toBe(true);
    await sleep(150);
    expect(released).toBe(2);
  });

  it("lets go at once when the heap is three quarters full, and when the last server closes", () => {
    let released = 0;
    onAppMemoryRelease(() => released++);
    startAppMemory();
    startAppMemory();
    appMemory.lowAt = 0;
    expect(appMemoryInUse()).toBe(false);
    expect(released).toBe(1);
    appMemory.lowAt = 0.75;
    stopAppMemory();
    expect(appMemory.on).toBe(true);
    stopAppMemory();
    expect(appMemory.on).toBe(false);
    expect(released).toBe(2);
  });

  it("lets go when the machine's or the container's memory runs low, on use and on its timer", async () => {
    let released = 0;
    onAppMemoryRelease(() => released++);
    let free = 4000 * MB;
    appMemory.system = () => ({ free, total: 8000 * MB });
    appMemory.checkMs = 40;
    startAppMemory();
    expect(appMemoryInUse()).toBe(true);
    // Under a tenth of the memory free: let go on the next use, and kept nothing then.
    free = 500 * MB;
    appMemory.systemEveryMs = 0;
    expect(appMemoryInUse()).toBe(false);
    expect(released).toBe(1);
    // Room again; then low with no use at all: the timer lets go.
    free = 4000 * MB;
    expect(appMemoryInUse()).toBe(true);
    free = 300 * MB;
    await sleep(120);
    expect(released).toBeGreaterThanOrEqual(2);
  });

  it("says what each keeper holds (the measurement in ADR 0205)", () => {
    let held = 3 * MB;
    onAppMemoryRelease(
      () => (held = 0),
      () => ({ "a keeper of the tests": held }),
    );
    expect(appMemoryHeld()["a keeper of the tests"]).toBe(3 * MB);
  });
});

describe("the machine's and the container's memory (ADR 0205 step 4)", () => {
  const os = { freemem: () => 6000 * MB, totalmem: () => 8000 * MB };
  const files =
    (f: Record<string, string>) =>
    (p: string): string | undefined =>
      f[p];

  it("is the machine's where no cgroup limits it (Windows, macOS, a Linux without a limit)", () => {
    expect(systemMemoryOf(files({}), os)).toEqual({ free: 6000 * MB, total: 8000 * MB });
    expect(
      systemMemoryOf(
        files({
          "/sys/fs/cgroup/memory.max": "max\n",
          "/sys/fs/cgroup/memory.current": `${100 * MB}\n`,
        }),
        os,
      ),
    ).toEqual({ free: 6000 * MB, total: 8000 * MB });
  });

  it("is the container's where its cgroup's limit is lower (cgroup v2, and v1)", () => {
    expect(
      systemMemoryOf(
        files({
          "/sys/fs/cgroup/memory.max": `${2000 * MB}\n`,
          "/sys/fs/cgroup/memory.current": `${1500 * MB}\n`,
        }),
        os,
      ),
    ).toEqual({ free: 500 * MB, total: 2000 * MB });
    expect(
      systemMemoryOf(
        files({
          "/sys/fs/cgroup/memory/memory.limit_in_bytes": `${3000 * MB}\n`,
          "/sys/fs/cgroup/memory/memory.usage_in_bytes": `${1000 * MB}\n`,
        }),
        os,
      ),
    ).toEqual({ free: 2000 * MB, total: 3000 * MB });
    // A v1 limit of "no limit" is a huge number: the machine's.
    expect(
      systemMemoryOf(
        files({
          "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n",
          "/sys/fs/cgroup/memory/memory.usage_in_bytes": `${1000 * MB}\n`,
        }),
        os,
      ),
    ).toEqual({ free: 6000 * MB, total: 8000 * MB });
  });

  it("is the process's own cgroup's, nested, and the lowest limit above it (the review of cbab428f)", () => {
    // cgroup v2 without its own namespace (a systemd slice, a container run with the host's):
    // the root's files are the machine's; the process's cgroup, from /proc/self/cgroup, limits it.
    expect(
      systemMemoryOf(
        files({
          "/proc/self/cgroup": "0::/user.slice/atticus.scope\n",
          "/sys/fs/cgroup/user.slice/atticus.scope/memory.max": "max\n",
          "/sys/fs/cgroup/user.slice/atticus.scope/memory.current": `${1200 * MB}\n`,
          "/sys/fs/cgroup/user.slice/atticus.scope/memory.stat": `inactive_file ${200 * MB}\n`,
          "/sys/fs/cgroup/user.slice/memory.max": `${3000 * MB}\n`,
          "/sys/fs/cgroup/user.slice/memory.current": `${2500 * MB}\n`,
        }),
        os,
      ),
    ).toEqual({ free: 500 * MB, total: 3000 * MB });
    // cgroup v1: the memory controller's line.
    expect(
      systemMemoryOf(
        files({
          "/proc/self/cgroup": "12:cpu,cpuacct:/docker/abc\n4:memory:/docker/abc\n",
          "/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes": `${2000 * MB}\n`,
          "/sys/fs/cgroup/memory/docker/abc/memory.usage_in_bytes": `${500 * MB}\n`,
        }),
        os,
      ),
    ).toEqual({ free: 1500 * MB, total: 2000 * MB });
    // Inside its own namespace the process's cgroup is the root: as before.
    expect(
      systemMemoryOf(
        files({
          "/proc/self/cgroup": "0::/\n",
          "/sys/fs/cgroup/memory.max": `${2000 * MB}\n`,
          "/sys/fs/cgroup/memory.current": `${1500 * MB}\n`,
        }),
        os,
      ),
    ).toEqual({ free: 500 * MB, total: 2000 * MB });
  });

  it("is the machine's free memory when that is less than the container's room", () => {
    expect(
      systemMemoryOf(
        files({
          "/sys/fs/cgroup/memory.max": `${7000 * MB}\n`,
          "/sys/fs/cgroup/memory.current": `${100 * MB}\n`,
        }),
        os,
      ),
    ).toEqual({ free: 6000 * MB, total: 7000 * MB });
  });
});
