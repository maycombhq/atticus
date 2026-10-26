import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  catalogJsonSchemas,
  deserializeRecord,
  migrateCatalog,
  parseRecord,
  referenceFields,
  serializeRecord,
} from "../src/index.js";
import { EXAMPLES } from "./examples.js";

/**
 * ADR 0031: catalog schema version 2 added the Capability kind. ADR 0125: version 3 adds
 * `required` on a Schema field. Version-1 and version-2 files still read.
 */
describe("catalog schema version 3", () => {
  it("is version 3, and readers accept 1, 2 and 3", () => {
    expect(SCHEMA_VERSION).toBe(3);
    expect([...SUPPORTED_SCHEMA_VERSIONS]).toEqual([1, 2, 3]);
  });

  it("reads a version-1 or version-2 record and returns it as version 3, since no field changed", () => {
    const r = parseRecord({ ...EXAMPLES.System, schemaVersion: 1 });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.record.schemaVersion).toBe(3);
    for (const v of [2, 3]) {
      const back = parseRecord({ ...EXAMPLES.System, schemaVersion: v });
      expect(back.ok && back.record, String(v)).toEqual(r.record);
    }
  });

  it("refuses a version it doesn't know", () => {
    for (const v of [0, 4, "3"]) {
      const r = parseRecord({ ...EXAMPLES.System, schemaVersion: v });
      expect(r.ok, String(v)).toBe(false);
      if (!r.ok) {
        expect(r.issues[0]?.path).toBe("schemaVersion");
        expect(r.issues[0]?.message).toBe(
          "schemaVersion must be 1, 2 or 3 (older files are read as version 3)",
        );
      }
    }
  });

  it("always writes version 3", () => {
    for (const v of [1, 2]) {
      const text = serializeRecord({
        ...EXAMPLES.System,
        schemaVersion: v,
        tags: [],
        accessGroup: "everyone",
      } as never);
      expect(text.startsWith("schemaVersion: 3\nkind: System\n")).toBe(true);
    }
    const decision = parseRecord({ ...EXAMPLES.CuratedDecision, schemaVersion: 1 });
    expect(decision.ok && serializeRecord(decision.record)).toMatch(/^schemaVersion: 3\n/);
  });

  it("names the version in the JSON Schema ids", () => {
    const s = catalogJsonSchemas().Capability as { $id: string };
    expect(s.$id).toBe("https://maycombhq.github.io/atticus/schema/catalog/v3/Capability.json");
  });
});

/** ADR 0125: a Schema field says whether it is required; left out, nobody knows. */
describe("Schema field required", () => {
  const schema = (fields: Record<string, unknown>[]) => ({
    ...EXAMPLES.Schema,
    evidence: [{ source: "code", repo: "forge-ledger", path: "src/EntryRequest.java" }],
    fields,
  });

  it("takes true, false or nothing, and never defaults an unknown to false", () => {
    const r = parseRecord(
      schema([
        { name: "amount", type: "decimal", required: true },
        { name: "memo", type: "string", required: false },
        { name: "currency", type: "string" },
      ]),
    );
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    if (r.record.kind !== "Schema") throw new Error("not a Schema");
    expect(r.record.fields).toEqual([
      { name: "amount", type: "decimal", required: true },
      { name: "memo", type: "string", required: false },
      { name: "currency", type: "string" },
    ]);
    expect("required" in r.record.fields[2]!).toBe(false);
  });

  it("refuses anything but a boolean", () => {
    for (const v of ["yes", 1, null]) {
      const r = parseRecord(schema([{ name: "amount", required: v }]));
      expect(r.ok, String(v)).toBe(false);
      if (!r.ok) expect(r.issues[0]?.path).toBe("fields.0.required");
    }
  });

  it("serialises canonically: required after name, nothing for an unknown, the same bytes twice", () => {
    const r = parseRecord(
      schema([
        { type: "decimal", required: true, name: "amount" },
        { name: "currency", type: "string" },
        { name: "memo", required: false },
      ]),
    );
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const text = serializeRecord(r.record);
    expect(text).toBe(
      [
        "schemaVersion: 3",
        "kind: Schema",
        "id: balance-response",
        "status: current",
        "confidence: verified",
        "evidence:",
        "  - path: src/EntryRequest.java",
        "    repo: forge-ledger",
        "    source: code",
        "fields:",
        "  - name: amount",
        "    required: true",
        "    type: decimal",
        "  - name: currency",
        "    type: string",
        "  - name: memo",
        "    required: false",
        "format: openapi",
        "ref: specs/ledger.yaml#/components/schemas/Balance",
        "",
      ].join("\n"),
    );
    const again = deserializeRecord(text);
    expect(again.ok && serializeRecord(again.record)).toBe(text);
  });

  it("is in the JSON Schema as an optional boolean", () => {
    const s = catalogJsonSchemas().Schema as {
      properties: {
        fields: { items: { properties: Record<string, { type?: string }>; required: string[] } };
      };
    };
    expect(s.properties.fields.items.properties.required).toMatchObject({ type: "boolean" });
    expect(s.properties.fields.items.required).toEqual(["name"]);
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
  /** A version-2 file in canonical form, as an Atticus at version 2 wrote it (ADR 0125). */
  const v2Schema = [
    "schemaVersion: 2",
    "kind: Schema",
    "id: ledger-api.post-accounts-accountid-entries.request",
    "status: current",
    "confidence: verified",
    "evidence:",
    "  - line: 7",
    "    path: src/main/java/forge/ledger/EntryRequest.java",
    "    repo: forge-ledger",
    "    source: code",
    "fields:",
    "  - name: amount",
    "    type: decimal",
    "  - name: currency",
    "    type: string",
    "format: other",
    "ref: ledger-api.post-accounts-accountid-entries",
    "",
  ].join("\n");
  const SCHEMA_FILE = "generated/schema/ledger-api.post-accounts-accountid-entries.request.yaml";

  async function catalog() {
    const dir = await mkdtemp(join(tmpdir(), "atticus-migrate-"));
    await mkdir(join(dir, "generated/system"), { recursive: true });
    await mkdir(join(dir, "curated/curateddecision"), { recursive: true });
    await writeFile(join(dir, "generated/system/ledger.yaml"), v1System);
    await mkdir(join(dir, "generated/schema"), { recursive: true });
    await writeFile(join(dir, SCHEMA_FILE), v2Schema);
    const v3 = parseRecord({ ...EXAMPLES.Component, schemaVersion: 3 });
    if (!v3.ok) throw new Error("bad example");
    await mkdir(join(dir, "generated/component"), { recursive: true });
    await writeFile(join(dir, "generated/component/ledger-api.yaml"), serializeRecord(v3.record));
    await writeFile(
      join(dir, "curated/curateddecision/cur-alias-ledger.yaml"),
      "schemaVersion: 1\nkind: CuratedDecision\nid: cur-alias-ledger\nstatus: current\nconfidence: asserted\ntarget: ledger\naction: alias\nvalue: Ledger Platform\nreason: Name used on the diagram\nby: a.architect\nat: 2026-10-18T10:00:00Z\n",
    );
    await writeFile(join(dir, "generated/system/broken.yaml"), "schemaVersion: 1\nkind: System\n");
    await writeFile(join(dir, "notes.txt"), "not a record");
    return dir;
  }

  it("rewrites version-1 and version-2 files as canonical version 3 and reports what changed", async () => {
    const dir = await catalog();
    const res = await migrateCatalog(dir);
    expect(res.migrated).toEqual([
      "curated/curateddecision/cur-alias-ledger.yaml",
      SCHEMA_FILE,
      "generated/system/ledger.yaml",
    ]);
    expect(res.current).toEqual(["generated/component/ledger-api.yaml"]);
    expect(res.problems).toEqual([
      { file: "generated/system/broken.yaml", message: expect.stringContaining("evidence") },
    ]);
    const text = await readFile(join(dir, "generated/system/ledger.yaml"), "utf8");
    expect(text).toBe(
      [
        "schemaVersion: 3",
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
    expect(again.current).toHaveLength(4);
  });

  it("version 2 to 3 changes only the version: no field gains a required it didn't have (ADR 0125)", async () => {
    const dir = await catalog();
    await migrateCatalog(dir);
    expect(await readFile(join(dir, SCHEMA_FILE), "utf8")).toBe(
      v2Schema.replace(/^schemaVersion: 2\n/, "schemaVersion: 3\n"),
    );
  });

  it("migrates only the versions it is asked to, so each upgrade step lists its own files", async () => {
    const dir = await catalog();
    const two = await migrateCatalog(dir, { dryRun: true, versions: [2] });
    expect(two.migrated).toEqual([SCHEMA_FILE]);
    expect(two.problems).toEqual([]);
    const one = await migrateCatalog(dir, { dryRun: true, versions: [1] });
    expect(one.migrated).toEqual([
      "curated/curateddecision/cur-alias-ledger.yaml",
      "generated/system/ledger.yaml",
    ]);
    expect(one.problems.map((p) => p.file)).toEqual(["generated/system/broken.yaml"]);
    await migrateCatalog(dir, { versions: [1] });
    // a step writes the current version, and leaves the other step's files alone
    expect(await readFile(join(dir, "generated/system/ledger.yaml"), "utf8")).toMatch(
      /^schemaVersion: 3\n/,
    );
    expect(await readFile(join(dir, SCHEMA_FILE), "utf8")).toBe(v2Schema);
  });

  it("lists the same files to migrate when asked for those only, without reading every file's YAML", async () => {
    const dir = await catalog();
    // Files whose version the text alone can't settle are read as YAML, as always: a quoted
    // key, a comment after the number, an escape, the word twice.
    await mkdir(join(dir, "curated/system"), { recursive: true });
    const odd = {
      "curated/system/quoted.yaml": v1System.replace("schemaVersion: 1", '"schemaVersion": 2'),
      "curated/system/comment.yaml": v1System.replace("schemaVersion: 1", "schemaVersion: 2 # old"),
      "curated/system/escape.yaml": v1System.replace("name: Ledger", 'name: "Led\\u0067er"'),
      "curated/system/twice.yaml": v1System.replace("name: Ledger", "name: schemaVersion"),
      "curated/system/flow.yaml": "{schemaVersion: 2, kind: System, id: flow}\n",
    };
    for (const [f, text] of Object.entries(odd)) await writeFile(join(dir, f), text);
    for (const versions of [[1], [2], [1, 2]]) {
      const full = await migrateCatalog(dir, { dryRun: true, versions });
      const quick = await migrateCatalog(dir, { dryRun: true, versions, pendingOnly: true });
      expect(quick.migrated, String(versions)).toEqual(full.migrated);
      expect(quick.problems, String(versions)).toEqual(full.problems);
      // It doesn't list the files already current: it never reads them.
      expect(quick.current).toEqual([]);
    }
    expect(
      (await migrateCatalog(dir, { dryRun: true, versions: [2], pendingOnly: true })).migrated,
    ).toEqual(["curated/system/comment.yaml", "curated/system/quoted.yaml", SCHEMA_FILE]);
  });

  it("changes nothing on a dry run", async () => {
    const dir = await catalog();
    const res = await migrateCatalog(dir, { dryRun: true });
    expect(res.migrated).toHaveLength(3);
    expect(await readFile(join(dir, "generated/system/ledger.yaml"), "utf8")).toBe(v1System);
    expect(await readFile(join(dir, SCHEMA_FILE), "utf8")).toBe(v2Schema);
  });

  it("reads back what it wrote", async () => {
    const dir = await catalog();
    await migrateCatalog(dir);
    for (const f of ["generated/system/ledger.yaml", SCHEMA_FILE]) {
      const r = deserializeRecord(await readFile(join(dir, f), "utf8"));
      expect(r.ok && r.record.schemaVersion, f).toBe(3);
    }
  });
});
