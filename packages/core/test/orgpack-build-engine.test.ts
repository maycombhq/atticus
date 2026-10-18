import { describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME, Runtime } from "../src/index.js";

/** ADR 0030 point 5 (build engine) and ADR 0032 (manual adapters): additive C6 fields. */
const base = { schemaVersion: 1, assistants: { allowed: ["copilot"], default: "copilot" } };

describe("runtime.yaml buildEngine", () => {
  it("is optional, so existing packs and the defaults are unchanged", () => {
    expect(Runtime.parse(base).buildEngine).toBeUndefined();
    expect(Runtime.parse(DEFAULT_RUNTIME).buildEngine).toBeUndefined();
  });

  it("takes speckit or atticus, defaults to speckit, with per-repo overrides", () => {
    expect(Runtime.parse({ ...base, buildEngine: {} }).buildEngine).toEqual({
      default: "speckit",
      perRepo: {},
    });
    expect(
      Runtime.parse({
        ...base,
        buildEngine: { default: "atticus", perRepo: { "forge-ledger": "speckit" } },
      }).buildEngine,
    ).toEqual({ default: "atticus", perRepo: { "forge-ledger": "speckit" } });
  });

  it("refuses an unknown engine, a bad repo id and unknown keys", () => {
    expect(Runtime.safeParse({ ...base, buildEngine: { default: "openspec" } }).success).toBe(
      false,
    );
    expect(
      Runtime.safeParse({ ...base, buildEngine: { perRepo: { "Forge Ledger": "atticus" } } })
        .success,
    ).toBe(false);
    expect(Runtime.safeParse({ ...base, buildEngine: { engine: "atticus" } }).success).toBe(false);
  });
});

describe("runtime.yaml manual adapters", () => {
  it("accepts type manual for every external system", () => {
    const manual = { type: "manual" };
    const r = Runtime.parse({
      ...base,
      adapters: {
        workTracker: manual,
        serviceDesk: manual,
        gitHost: manual,
        wiki: manual,
        notify: manual,
        design: manual,
      },
    });
    expect(Object.values(r.adapters).map((a) => a?.type)).toEqual(Array(6).fill("manual"));
  });

  it("has no manual model adapter: hand-off mode is the manual way to run AI", () => {
    expect(Runtime.safeParse({ ...base, adapters: { model: { type: "manual" } } }).success).toBe(
      false,
    );
    expect(
      Runtime.parse({ ...base, adapters: { model: { type: "mock" } } }).adapters.model,
    ).toEqual({ type: "mock", settings: {} });
  });
});
