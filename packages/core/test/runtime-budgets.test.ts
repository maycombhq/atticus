import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { migrateRuntimeV5Text, Runtime, RUNTIME_SCHEMA_VERSION } from "../src/index.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/budget");
const base = { assistants: { allowed: ["copilot"], default: "copilot" } };

describe("C6 runtime.yaml version 5: budgets.limits (ADR 0210 part 5)", () => {
  it("reads the fixture's limits a run, a day and a month", async () => {
    expect(RUNTIME_SCHEMA_VERSION).toBe(5);
    const r = Runtime.parse(parse(await readFile(join(FIXTURE, "runtime.yaml"), "utf8")));
    expect(r.budgets).toEqual({
      defaultTokens: 150000,
      perAgent: {},
      limits: [
        { per: "run", sessions: 6 },
        { per: "day", sessions: 10 },
        { per: "month", tokens: 100000 },
      ],
    });
  });

  it("leaves them out by default, and an older file reads as it did", () => {
    expect(Runtime.parse({ schemaVersion: 4, ...base }).budgets).toEqual({
      defaultTokens: 200000,
      perAgent: {},
    });
  });

  it("refuses limits below version 5, a limit with nothing to count and two limits of one period", () => {
    const limits = [{ per: "day", sessions: 3 }];
    const v4 = Runtime.safeParse({ schemaVersion: 4, ...base, budgets: { limits } });
    expect(JSON.stringify(v4.error?.issues)).toMatch(
      /budgets.limits needs schemaVersion 5 \(ADR 0210\): run atticus upgrade/,
    );
    const empty = Runtime.safeParse({
      schemaVersion: 5,
      ...base,
      budgets: { limits: [{ per: "day" }] },
    });
    expect(JSON.stringify(empty.error?.issues)).toMatch(/a limit names sessions, tokens or both/);
    const twice = Runtime.safeParse({
      schemaVersion: 5,
      ...base,
      budgets: { limits: [...limits, { per: "day", tokens: 9 }] },
    });
    expect(JSON.stringify(twice.error?.issues)).toMatch(/one limit a period/);
    expect(
      Runtime.safeParse({
        schemaVersion: 5,
        ...base,
        budgets: { limits: [{ per: "week", sessions: 1 }] },
      }).success,
    ).toBe(false);
  });

  it("upgrade writes the number only, and only for a file that sets limits", () => {
    const text = [
      "# Forge runtime",
      "schemaVersion: 4 # kept",
      "assistants: { allowed: [copilot], default: copilot }",
      "budgets:",
      "  limits: [{ per: day, sessions: 3 }]",
      "",
    ].join("\n");
    const m = migrateRuntimeV5Text(text);
    expect(m).toEqual({
      text: text.replace("schemaVersion: 4", "schemaVersion: 5"),
      changed: true,
    });
    expect(Runtime.safeParse(parse(m.text)).success).toBe(true);
    expect(migrateRuntimeV5Text(m.text).changed).toBe(false);
    expect(
      migrateRuntimeV5Text(
        text.replace("  limits: [{ per: day, sessions: 3 }]\n", "  defaultTokens: 9\n"),
      ).changed,
    ).toBe(false);
  });
});
