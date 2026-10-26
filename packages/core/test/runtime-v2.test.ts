import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  DEFAULT_RUNTIME,
  migrateRuntimeText,
  Runtime,
  RUNTIME_SCHEMA_VERSION,
  STEP_CLASSES,
  stepModelsOf,
} from "../src/index.js";

/** ADR 0121 addendum: runtime.yaml version 2 names a model per kind of step. */
describe("runtime.yaml version 2", () => {
  const base = { assistants: { allowed: ["copilot"], default: "copilot" } };

  it("has the five kinds of step", () => {
    expect(STEP_CLASSES).toEqual(["read", "draft", "critic", "knowledge", "quick"]);
    expect(RUNTIME_SCHEMA_VERSION).toBe(2);
  });

  it("reads a version 1 file as before: no step names a model of its own", () => {
    const r = Runtime.parse({ schemaVersion: 1, ...base });
    expect(stepModelsOf(r)).toEqual({});
    expect(r.models).toEqual({ allowed: [], recommended: {} });
  });

  it("takes a model per kind of step only in version 2", () => {
    const models = {
      draft: "claude-opus-5-5",
      critic: "copilot/claude-sonnet-4.5",
      quick: "claude-haiku-4-5",
    };
    const v1 = Runtime.safeParse({ schemaVersion: 1, ...base, models });
    expect(v1.success).toBe(false);
    expect(JSON.stringify(v1.error?.issues)).toMatch(/models\.draft needs schemaVersion 2/);
    const v2 = Runtime.parse({ schemaVersion: 2, ...base, models });
    expect(stepModelsOf(v2)).toEqual(models);
    expect(v2.models.allowed).toEqual([]);
  });

  it("refuses a kind it doesn't know, and a model with spaces", () => {
    expect(
      Runtime.safeParse({ schemaVersion: 2, ...base, models: { huge: "claude-opus-5-5" } }).success,
    ).toBe(false);
    expect(
      Runtime.safeParse({ schemaVersion: 2, ...base, models: { read: "Claude Opus" } }).success,
    ).toBe(false);
  });

  it("is what atticus init writes", () => {
    expect(DEFAULT_RUNTIME.schemaVersion).toBe(2);
    expect(stepModelsOf(DEFAULT_RUNTIME)).toEqual({});
  });

  it("migrates version 1 to 2 by its number only, keeping comments and order", () => {
    const v1 = [
      "# How AI runs here",
      "schemaVersion: 1",
      "assistants:",
      "  allowed: [copilot]",
      "  default: copilot",
      "models:",
      "  allowed: [claude-opus-5-5]",
      "  recommended:",
      "    critic: claude-sonnet-4-5 # the critic's family",
      "",
    ].join("\n");
    const r = migrateRuntimeText(v1);
    expect(r.changed).toBe(true);
    expect(r.text).toBe(v1.replace("schemaVersion: 1", "schemaVersion: 2"));
    const after = Runtime.parse(parse(r.text));
    expect(after.schemaVersion).toBe(2);
    // Nothing moves into a kind of step: recommended stays a hint, as it was.
    expect(stepModelsOf(after)).toEqual({});
    expect(after.models.recommended).toEqual({ critic: "claude-sonnet-4-5" });
    expect(migrateRuntimeText(r.text)).toEqual({ text: r.text, changed: false });
    expect(migrateRuntimeText("not: [yaml").changed).toBe(false);
  });
});
