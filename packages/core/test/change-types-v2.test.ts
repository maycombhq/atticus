import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  briefSize,
  CHANGE_TYPES_SCHEMA_VERSION,
  ChangeTypes,
  DEFAULT_CHANGE_TYPES,
  DEFAULT_GATES,
  fastGateOf,
  fastPathOf,
  loadOrgPack,
  migrateChangeTypesText,
} from "../src/index.js";

/** ADR 0113: a change type (or a size the brief states) can take the fast path. */
describe("change-types.yaml version 2", () => {
  const standard = {
    id: "config-change",
    name: "Configuration change",
    phases: ["define", "plan", "build", "release"],
    artifacts: ["proposal", "tasks"],
  };
  const small = {
    id: "small-change",
    name: "Small change",
    size: "small",
    phases: ["plan", "build", "release"],
    artifacts: ["brief", "proposal", "design", "stories", "tasks"],
  };

  it("reads a version 1 file as before: every type is standard", () => {
    const t = ChangeTypes.parse({ schemaVersion: 1, types: [standard] });
    expect(fastPathOf(t.types[0]!, "Size: small").fast).toBe(false);
  });

  it("takes the new fields only in version 2", () => {
    const r = ChangeTypes.safeParse({ schemaVersion: 1, types: [small] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/schemaVersion 2/);
    expect(ChangeTypes.safeParse({ schemaVersion: 2, types: [small] }).success).toBe(true);
  });

  it("refuses a small type with more than one phase before build", () => {
    const r = ChangeTypes.safeParse({
      schemaVersion: 2,
      types: [{ ...small, phases: ["define", "plan", "build"] }],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/one phase before build/);
  });

  it("puts a small type on the fast path, and a brief may ask for the full one", () => {
    const t = ChangeTypes.parse({ schemaVersion: 2, types: [small] }).types[0]!;
    expect(fastPathOf(t, "# Fix the label\n\nThe button says Sumbit.")).toEqual({
      fast: true,
      why: "type",
    });
    expect(fastPathOf(t, "Size: standard\n").fast).toBe(false);
  });

  it("lets a brief that says it is small take the fast path where the type allows it", () => {
    const allows = ChangeTypes.parse({
      schemaVersion: 2,
      types: [{ ...standard, smallWhenBriefSays: true }],
    }).types[0]!;
    expect(fastPathOf(allows, "## Size\n\nSize: small").fast).toBe(true);
    expect(fastPathOf(allows, "**Size:** Small").why).toBe("brief");
    expect(fastPathOf(allows, "---\nsize: small\n---\n# Fix").fast).toBe(true);
    expect(fastPathOf(allows, "Nothing about size here.").fast).toBe(false);
    const not = ChangeTypes.parse({ schemaVersion: 2, types: [standard] }).types[0]!;
    expect(fastPathOf(not, "Size: small")).toEqual({ fast: false, why: "brief-not-allowed" });
  });

  it("reads the size a brief states, and nothing from a comment or the template's hint", () => {
    expect(briefSize("Size: small")).toBe("small");
    expect(briefSize("- Size: standard")).toBe("standard");
    expect(briefSize("<!-- Size: small | standard -->")).toBeUndefined();
    expect(briefSize("The size: small font is hard to read")).toBeUndefined();
  });

  it("runs the fast path's critic at the gate the type names, else its last phase before build", () => {
    const t = ChangeTypes.parse({ schemaVersion: 2, types: [small] }).types[0]!;
    expect(fastGateOf(t, DEFAULT_GATES)).toBe("plan");
    const named = ChangeTypes.parse({
      schemaVersion: 2,
      types: [{ ...standard, smallWhenBriefSays: true, fastGate: "define" }],
    }).types[0]!;
    expect(fastGateOf(named, DEFAULT_GATES)).toBe("define");
    const cfg = ChangeTypes.parse({ schemaVersion: 2, types: [standard] }).types[0]!;
    expect(fastGateOf(cfg, DEFAULT_GATES)).toBe("plan");
  });

  it("ships the built-in types at version 2 with a small change type", () => {
    expect(DEFAULT_CHANGE_TYPES.schemaVersion).toBe(CHANGE_TYPES_SCHEMA_VERSION);
    const s = DEFAULT_CHANGE_TYPES.types.find((t) => t.id === "small-change");
    expect(s?.size).toBe("small");
    expect(fastPathOf(s!, "").fast).toBe(true);
    expect(DEFAULT_CHANGE_TYPES.types.find((t) => t.id === "feature")?.size).toBeUndefined();
  });

  it("migrates a version 1 file to 2 and changes nothing else", () => {
    const v1 = [
      "# Change types of the Forge pack",
      "schemaVersion: 1",
      "types:",
      "  - id: config-change",
      "    name: Configuration change",
      "    phases: [define, plan, build, release]",
      "    artifacts: [proposal, tasks]",
      "",
    ].join("\n");
    const r = migrateChangeTypesText(v1);
    expect(r.changed).toBe(true);
    expect(r.text).toContain("# Change types of the Forge pack");
    const data = ChangeTypes.parse(parse(r.text));
    expect(data.schemaVersion).toBe(2);
    expect(data.types[0]!.size).toBeUndefined();
    expect(migrateChangeTypesText(r.text).changed).toBe(false);
  });

  it("checks a fast gate against gates.yaml and the type's phases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-ct2-"));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "change-types.yaml"),
      [
        "schemaVersion: 2",
        "types:",
        "  - id: small-change",
        "    name: Small change",
        "    size: small",
        "    fastGate: release",
        "    phases: [plan, build]",
        "    artifacts: [proposal, tasks]",
        "  - id: other",
        "    name: Other",
        "    size: small",
        "    fastGate: nowhere",
        "    phases: [plan, build]",
        "    artifacts: [proposal, tasks]",
        "",
      ].join("\n"),
    );
    const op = await loadOrgPack(dir);
    const msgs = op.problems.filter((p) => p.file === "change-types.yaml").map((p) => p.message);
    expect(msgs.join("\n")).toMatch(/release gate is for the release phase, which small-change/);
    expect(msgs.join("\n")).toMatch(/no gate nowhere in gates.yaml/);
  });
});
