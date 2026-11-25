import { describe, expect, it } from "vitest";
import { migrateRuntimeV5Text, Runtime } from "../src/index.js";

const base = { assistants: { allowed: ["copilot"], default: "copilot" } };

describe("C6 runtime.yaml version 5: apply.pair (ADR 0210 part 4)", () => {
  it("reads on and off, and leaves it out by default", () => {
    expect(Runtime.parse({ schemaVersion: 5, ...base, apply: { pair: "off" } }).apply).toEqual({
      pair: "off",
    });
    expect(Runtime.parse({ schemaVersion: 5, ...base, apply: {} }).apply).toEqual({ pair: "on" });
    expect(Runtime.parse({ schemaVersion: 5, ...base }).apply).toBeUndefined();
    expect(Runtime.safeParse({ schemaVersion: 5, ...base, apply: { pair: "maybe" } }).success).toBe(
      false,
    );
  });

  it("refuses it below version 5, and the upgrade writes the number", () => {
    const v4 = Runtime.safeParse({ schemaVersion: 4, ...base, apply: { pair: "off" } });
    expect(JSON.stringify(v4.error?.issues)).toMatch(/apply needs schemaVersion 5 \(ADR 0210\)/);
    const text =
      "schemaVersion: 4\nassistants: { allowed: [copilot], default: copilot }\napply: { pair: off }\n";
    expect(migrateRuntimeV5Text(text).text).toMatch(/^schemaVersion: 5\n/);
  });
});
