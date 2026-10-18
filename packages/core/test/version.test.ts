import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  catalogJsonSchemas,
  deserializeRecord,
  migrateCatalog,
  parseRecord,
  referenceFields,
  serializeRecord,
} from "../src/index.js";
import { EXAMPLES } from "./examples.js";

/** ADR 0031: catalog schema version 2 adds the Capability kind; version-1 files still read. */
describe("catalog schema version 2", () => {
  it("is version 2", () => {
    expect(SCHEMA_VERSION).toBe(2);
  });

  it("reads a version-1 record and returns it as version 2, since no field changed", () => {
    const r = parseRecord({ ...EXAMPLES.System, schemaVersion: 1 });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.record.schemaVersion).toBe(2);
    const back = parseRecord({ ...EXAMPLES.System, schemaVersion: 2 });
    expect(back.ok && back.record).toEqual(r.record);
  });

  it("refuses a version it doesn't know", () => {
    for (const v of [0, 3, "2"]) {
      const r = parseRecord({ ...EXAMPLES.System, schemaVersion: v });
      expect(r.ok, String(v)).toBe(false);
      if (!r.ok) expect(r.issues[0]?.path).toBe("schemaVersion");
    }
  });

  it("always writes version 2", () => {
    const text = serializeRecord({
      ...EXAMPLES.System,
      schemaVersion: 1,
      tags: [],
      accessGroup: "everyone",
    } as never);
    expect(text.startsWith("schemaVersion: 2\nkind: System\n")).toBe(true);
    const decision = parseRecord({ ...EXAMPLES.CuratedDecision, schemaVersion: 1 });
    expect(decision.ok && serializeRecord(decision.record)).toMatch(/^schemaVersion: 2\n/);
  });

  it("names the version in the JSON Schema ids", () => {
    const s = catalogJsonSchemas().Capability as { $id: string };
    expect(s.$id).toBe("https://maycombhq.github.io/atticus/schema/catalog/v2/Capability.json");
  });
});

describe("Capability (shown as Feature)", () => {
  it("has the fields ADR 0031 decides", () => {
    const r = parseRecord(EXAMPLES.Capability);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.record).toMatchObject({
      kind: "Capability",
      name: "Account balance",
      entryPoints: ["portal-bff.get-balance"],
      namedBy: "detected",
      externalRefs: [{ system: "ado", id: "101", title: "Available balance" }],
    });
  });

  it("defaults its lists and leaves owner and description optional", () => {
    const r = parseRecord({
      schemaVersion: 2,
      kind: "Capability",
      id: "feature.x",
      status: "current",
      confidence: "inferred",
      name: "X",
      namedBy: "detected",
      evidence: [{ source: "code", repo: "r", path: "a.java", line: 1 }],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.record).toMatchObject({ entryPoints: [], records: [], tags: [], externalRefs: [] });
  });

  it("refuses an unknown naming source or work-item system", () => {
    expect(parseRecord({ ...EXAMPLES.Capability, namedBy: "guess" }).ok).toBe(false);
    expect(
      parseRecord({ ...EXAMPLES.Capability, externalRefs: [{ system: "trello", id: "1" }] }).ok,
    ).toBe(false);
  });

  it("refers to the records it starts at and spans, so the index can follow them", () => {
    expect(referenceFields("Capability")).toEqual(["entryPoints[]", "records[]"]);
  });
});

describe("migrateCatalog", () => {
  const v1System = [
    "schemaVersion: 1",
    "kind: System",
    "id: ledger",
    "status: current",
    "confidence: verified",
    "boundary: product",
    "evidence:",
    "  - source: config",
    "    repo: forge-ledger",
    "    path: forge.yaml",
    "name: Ledger",
    "",
  ].join("\n");

  async function catalog() {
    const dir = await mkdtemp(join(tmpdir(), "atticus-migrate-"));
    await mkdir(join(dir, "generated/system"), { recursive: true });
    await mkdir(join(dir, "curated/curateddecision"), { recursive: true });
    await writeFile(join(dir, "generated/system/ledger.yaml"), v1System);
    const v2 = parseRecord({ ...EXAMPLES.Component, schemaVersion: 2 });
    if (!v2.ok) throw new Error("bad example");
    await mkdir(join(dir, "generated/component"), { recursive: true });
    await writeFile(join(dir, "generated/component/ledger-api.yaml"), serializeRecord(v2.record));
    await writeFile(
      join(dir, "curated/curateddecision/cur-alias-ledger.yaml"),
      "schemaVersion: 1\nkind: CuratedDecision\nid: cur-alias-ledger\nstatus: current\nconfidence: asserted\ntarget: ledger\naction: alias\nvalue: Ledger Platform\nreason: Name used on the diagram\nby: a.architect\nat: 2026-10-18T10:00:00Z\n",
    );
    await writeFile(join(dir, "generated/system/broken.yaml"), "schemaVersion: 1\nkind: System\n");
    await writeFile(join(dir, "notes.txt"), "not a record");
    return dir;
  }

  it("rewrites version-1 files as canonical version 2 and reports what changed", async () => {
    const dir = await catalog();
    const res = await migrateCatalog(dir);
    expect(res.migrated).toEqual([
      "curated/curateddecision/cur-alias-ledger.yaml",
      "generated/system/ledger.yaml",
    ]);
    expect(res.current).toEqual(["generated/component/ledger-api.yaml"]);
    expect(res.problems).toEqual([
      { file: "generated/system/broken.yaml", message: expect.stringContaining("evidence") },
    ]);
    const text = await readFile(join(dir, "generated/system/ledger.yaml"), "utf8");
    expect(text).toBe(
      [
        "schemaVersion: 2",
        "kind: System",
        "id: ledger",
        "status: current",
        "confidence: verified",
        "accessGroup: everyone",
        "boundary: product",
        "evidence:",
        "  - path: forge.yaml",
        "    repo: forge-ledger",
        "    source: config",
        "name: Ledger",
        "repos: []",
        "tags: []",
        "",
      ].join("\n"),
    );
    // a file that can't be read is left exactly as it was
    expect(await readFile(join(dir, "generated/system/broken.yaml"), "utf8")).toBe(
      "schemaVersion: 1\nkind: System\n",
    );
    const again = await migrateCatalog(dir);
    expect(again.migrated).toEqual([]);
    expect(again.current).toHaveLength(3);
  });

  it("changes nothing on a dry run", async () => {
    const dir = await catalog();
    const res = await migrateCatalog(dir, { dryRun: true });
    expect(res.migrated).toHaveLength(2);
    expect(await readFile(join(dir, "generated/system/ledger.yaml"), "utf8")).toBe(v1System);
  });

  it("reads back what it wrote", async () => {
    const dir = await catalog();
    await migrateCatalog(dir);
    const r = deserializeRecord(await readFile(join(dir, "generated/system/ledger.yaml"), "utf8"));
    expect(r.ok && r.record.schemaVersion).toBe(2);
  });
});
