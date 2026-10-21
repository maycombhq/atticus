import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DEFAULT_GATES, Gates, gateRoundLimit, migrateGatesText } from "../src/index.js";

/** ADR 0087: the critic's round limit is a setting per gate, unlimited by default. */
describe("gates.yaml version 2", () => {
  const gate = { id: "design", phase: "design", approvers: ["architect"] };

  it("leaves the round limit out to mean unlimited", () => {
    const g = Gates.parse({ schemaVersion: 2, gates: [gate] });
    expect(gateRoundLimit(g, "design")).toBeUndefined();
  });

  it("keeps a number, or the word unlimited", () => {
    const g = Gates.parse({
      schemaVersion: 2,
      gates: [
        { ...gate, maxAuthorRounds: 7 },
        { ...gate, id: "plan", phase: "plan", maxAuthorRounds: "unlimited" },
      ],
    });
    expect(gateRoundLimit(g, "design")).toBe(7);
    expect(gateRoundLimit(g, "plan")).toBeUndefined();
  });

  it("reads a version 1 file as before: two rounds when the file says nothing", () => {
    const g = Gates.parse({ schemaVersion: 1, gates: [gate] });
    expect(gateRoundLimit(g, "design")).toBe(2);
  });

  it("ships the built-in gates at version 2, so a pack without gates.yaml has no limit", () => {
    expect(DEFAULT_GATES.schemaVersion).toBe(2);
    expect(gateRoundLimit(DEFAULT_GATES, "design")).toBeUndefined();
  });

  it("migrates a version 1 file to 2, writing each gate's old limit so nothing loosens", () => {
    const v1 = [
      "# Gates of the Forge pack",
      "schemaVersion: 1",
      "gates:",
      "  - id: design",
      "    phase: design",
      "    approvers: [architect]",
      "  - id: plan",
      "    phase: plan",
      "    approvers: [team-lead]",
      "    maxAuthorRounds: 3",
      "",
    ].join("\n");
    const r = migrateGatesText(v1);
    expect(r.changed).toBe(true);
    expect(r.text).toContain("# Gates of the Forge pack");
    const data = Gates.parse(parse(r.text));
    expect(data.schemaVersion).toBe(2);
    expect(gateRoundLimit(data, "design")).toBe(2);
    expect(gateRoundLimit(data, "plan")).toBe(3);
    expect(migrateGatesText(r.text).changed).toBe(false);
  });
});
