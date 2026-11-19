import { afterEach, describe, expect, it } from "vitest";
import {
  appMemory,
  appMemoryInUse,
  onAppMemoryRelease,
  startAppMemory,
  stopAppMemory,
} from "../src/index.js";

/**
 * ADR 0205 step 4 (the owner's answer of 2026-11-19): what the app's server keeps is let go after
 * ten idle minutes, at once when the heap is three quarters full, and when the last server closes;
 * nothing is kept outside a server.
 */
const was = { ...appMemory };
afterEach(() => {
  while (appMemory.on) stopAppMemory();
  Object.assign(appMemory, was);
});

describe("the app's memory (ADR 0205 step 4)", () => {
  it("keeps nothing outside a server", () => {
    expect(appMemory.on).toBe(false);
    expect(appMemoryInUse()).toBe(false);
  });

  it("lets go after the idle time, each use starting it again", async () => {
    let released = 0;
    onAppMemoryRelease(() => released++);
    startAppMemory();
    appMemory.idleMs = 120;
    expect(appMemoryInUse()).toBe(true);
    await new Promise((r) => setTimeout(r, 70));
    expect(appMemoryInUse()).toBe(true);
    await new Promise((r) => setTimeout(r, 70));
    expect(released).toBe(0);
    await new Promise((r) => setTimeout(r, 120));
    expect(released).toBe(1);
  });

  it("lets go at once when memory runs low, and when the last server closes", () => {
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
});
