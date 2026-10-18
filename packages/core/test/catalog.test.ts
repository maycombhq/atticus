import { describe, expect, it } from "vitest";
import {
  RECORD_KINDS,
  catalogJsonSchemas,
  interfaceId,
  normalizePath,
  parseRecord,
  recordPath,
  slugify,
} from "../src/index.js";
import { EXAMPLES } from "./examples.js";

describe("C1 record kinds", () => {
  it("has exactly the 29 kinds in the contract", () => {
    expect(RECORD_KINDS).toHaveLength(29);
    expect(Object.keys(EXAMPLES).sort()).toEqual([...RECORD_KINDS].sort());
  });

  it.each(RECORD_KINDS)("accepts a valid %s", (kind) => {
    const result = parseRecord(EXAMPLES[kind]);
    if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
    expect(result.record.kind).toBe(kind);
  });

  it("rejects unknown kinds", () => {
    const result = parseRecord({ ...EXAMPLES.System, kind: "Spaceship" });
    expect(result.ok).toBe(false);
  });

  it("rejects unknown fields (typos fail loudly)", () => {
    const result = parseRecord({ ...EXAMPLES.System, nmae: "typo" });
    expect(result.ok).toBe(false);
  });

  it("rejects ids that aren't file-name-safe slugs", () => {
    for (const id of ["Ledger", "a:b", "a/b", "", "-x", "x".repeat(121)]) {
      expect(parseRecord({ ...EXAMPLES.System, id }).ok, id).toBe(false);
    }
  });

  it("requires evidence on every scanned or asserted record", () => {
    expect(parseRecord({ ...EXAMPLES.System, evidence: [] }).ok).toBe(false);
  });

  it("requires manual evidence on asserted records", () => {
    const r = parseRecord({
      ...EXAMPLES.Obligation,
      evidence: [{ source: "document", path: "x.docx" }],
    });
    expect(r.ok).toBe(false);
  });

  it("allows curated decisions without separate evidence", () => {
    expect(parseRecord(EXAMPLES.CuratedDecision).ok).toBe(true);
  });

  it("requires the interface id to match its identity hash", () => {
    const r = parseRecord({ ...EXAMPLES.Interface, id: "if-0000000000000000" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe("id");
  });

  it("rejects autoscaling min above max", () => {
    expect(parseRecord({ ...EXAMPLES.Deployment, autoscaling: { min: 5, max: 2 } }).ok).toBe(false);
  });

  it("fills defaults for optional lists", () => {
    const r = parseRecord(EXAMPLES.System);
    expect(r.ok && r.record.kind === "System" && r.record.tags).toEqual([]);
  });
});

describe("identity", () => {
  it("normalises path parameters in every common style", () => {
    for (const p of [
      "/a/{id}/b",
      "/a/:id/b",
      "/a/<id>/b",
      "/a/${id}/b",
      "a/{x}/b/",
      "//a/{id}//b?x=1#f",
    ]) {
      expect(normalizePath(p), p).toBe("/a/{}/b");
    }
  });

  it("leaves topics alone", () => {
    expect(normalizePath(" deposits.posted ")).toBe("deposits.posted");
  });

  it("gives the same interface id for the same edge written differently", () => {
    expect(interfaceId("a", "b", "get", "/x/{id}")).toBe(interfaceId("a", "b", "GET", "/x/:id/"));
    expect(interfaceId("a", "b", "GET", "/x")).not.toBe(interfaceId("b", "a", "GET", "/x"));
    expect(interfaceId("a", "b", undefined, "topic")).toMatch(/^if-[0-9a-f]{16}$/);
  });

  it("slugifies free text into valid ids", () => {
    expect(slugify("Ledger Platform (EU)")).toBe("ledger-platform-eu");
    expect(slugify("Café Système")).toBe("cafe-systeme");
    expect(slugify("!!!")).toBe("unnamed");
  });

  it("puts each record in its own file by kind and id", () => {
    expect(recordPath({ kind: "Interface", id: "if-abc" })).toBe("interface/if-abc.yaml");
  });
});

describe("JSON Schema export", () => {
  it("produces one schema per kind with a stable id", () => {
    const schemas = catalogJsonSchemas();
    expect(Object.keys(schemas)).toHaveLength(29);
    for (const kind of RECORD_KINDS) {
      const s = schemas[kind] as { $id: string; title: string; type: string };
      expect(s.$id).toContain(`/${kind}.json`);
      expect(s.title).toBe(kind);
      expect(s.type).toBe("object");
    }
  });
});
