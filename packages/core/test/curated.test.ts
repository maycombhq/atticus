import { describe, expect, it } from "vitest";
import { applyCurated, interfaceId, parseRecord, type CatalogRecord } from "../src/index.js";

const code = {
  source: "code" as const,
  repo: "forge-ledger",
  path: "src/main/java/forge/ledger/NorthwindClient.java",
  line: 8,
  side: "caller" as const,
};
const base = { schemaVersion: 1 as const, status: "current" as const, evidence: [code] };
const rec = (r: Record<string, unknown>) => {
  const p = parseRecord({ ...base, confidence: "verified", ...r });
  if (!p.ok) throw new Error(JSON.stringify(p.issues));
  return p.record;
};

const vendorCall = rec({
  kind: "Interface",
  id: interfaceId("ledger-api", "northwind-pay", "POST", "/v2/payments"),
  from: "ledger-api",
  to: "northwind-pay",
  via: "direct",
  method: "POST",
  normalizedPath: "/v2/payments",
  sync: "sync",
  conflicts: [
    { field: "via", values: ["direct", "gateway"], note: "inputs/wiki/ledger-solution-spec.md" },
    { field: "auth", values: ["mtls", "oauth2"] },
  ],
});
const auditCall = rec({
  kind: "Interface",
  id: interfaceId("portal-bff", "audit-svc", "POST", "/audit/events"),
  confidence: "inferred",
  from: "portal-bff",
  to: "audit-svc",
  via: "direct",
  method: "POST",
  normalizedPath: "/audit/events",
  sync: "sync",
});
const column = rec({
  kind: "Column",
  id: "account.holder_name",
  table: "ledger-db.account",
  name: "holder_name",
  type: "varchar(200)",
});
const schema = rec({
  kind: "Schema",
  id: "ledger-api.transfer-request",
  format: "openapi",
  ref: "api/ledger-openapi.yaml#/components/schemas/TransferRequest",
  fields: [{ name: "amount", type: "number" }, { name: "payeeName" }],
});
const records: CatalogRecord[] = [vendorCall, auditCall, column, schema];
const ledgerApi = {
  kind: "Component",
  id: "ledger-api",
  system: "ledger",
  repo: "forge-ledger",
  type: "forge-service",
};

let n = 0;
const decision = (d: Record<string, unknown>) => {
  const p = parseRecord({
    schemaVersion: 1,
    kind: "CuratedDecision",
    id: `cd-${String(++n).padStart(3, "0")}`,
    status: "current",
    confidence: "asserted",
    reason: "checked with the owner",
    by: "a.architect",
    at: "2026-10-18T10:00:00Z",
    ...d,
  });
  if (!p.ok) throw new Error(JSON.stringify(p.issues));
  return p.record;
};
const find = (rs: CatalogRecord[], id: string) =>
  rs.find((r) => r.id === id) as unknown as Record<string, unknown>;

describe("applyCurated", () => {
  it("leaves records alone for an alias decision", () => {
    const d = decision({ target: "ledger-api", action: "alias", value: "Ledger Platform" });
    const out = applyCurated([...records, rec({ ...ledgerApi })], [d]);
    expect(out.problems).toEqual([]);
    expect(out.applied).toEqual([d.id]);
    expect(out.records).toEqual([...records, rec({ ...ledgerApi })]);
  });

  it("asserts fields with confidence asserted and manual evidence naming who", () => {
    const d = decision({
      target: auditCall.id,
      action: "assert",
      value: { pattern: { code: "S.DIR.SOR", source: "asserted" }, auth: "mtls" },
    });
    const out = applyCurated(records, [d]);
    expect(out.problems).toEqual([]);
    expect(find(out.records, auditCall.id)).toEqual({
      ...auditCall,
      pattern: { code: "S.DIR.SOR", source: "asserted" },
      auth: "mtls",
      confidence: "asserted",
      evidence: [code, { source: "manual", by: "a.architect" }],
    });
    // the input is never changed
    expect(find(records, auditCall.id).auth).toBeUndefined();
  });

  it("drops a suppressed record and lists it; a scoped suppress changes nothing", () => {
    const drop = decision({ target: auditCall.id, action: "suppress", value: null });
    const scoped = decision({
      target: vendorCall.id,
      action: "suppress",
      value: { diagram: "inputs/diagrams/forge-context.drawio" },
    });
    const out = applyCurated(records, [drop, scoped]);
    expect(out.problems).toEqual([]);
    expect(out.suppressed).toEqual([auditCall.id]);
    expect(out.records.map((r) => r.id)).toEqual([vendorCall.id, column.id, schema.id]);
    expect(find(out.records, vendorCall.id)).toEqual(vendorCall);
    expect(out.applied).toEqual([drop.id, scoped.id]);
  });

  it("resolves a conflict: sets the chosen value and clears that conflict only", () => {
    const keep = decision({
      target: vendorCall.id,
      action: "resolve-conflict",
      value: { via: "direct" },
    });
    const out = applyCurated(records, [keep]);
    expect(out.problems).toEqual([]);
    const r = find(out.records, vendorCall.id);
    expect(r.via).toBe("direct");
    expect(r.conflicts).toEqual([{ field: "auth", values: ["mtls", "oauth2"] }]);
    // the value is what the code says, so the record stays verified
    expect(r.confidence).toBe("verified");
    expect(r.evidence).toEqual([code, { source: "manual", by: "a.architect" }]);

    const other = decision({
      target: vendorCall.id,
      action: "resolve-conflict",
      value: { auth: "oauth2" },
    });
    const r2 = find(applyCurated(records, [other]).records, vendorCall.id);
    expect(r2.auth).toBe("oauth2");
    expect(r2.confidence).toBe("asserted");
    expect(r2.conflicts).toEqual([
      { field: "via", values: ["direct", "gateway"], note: "inputs/wiki/ledger-solution-spec.md" },
    ]);
  });

  it("classifies a column, or schema fields by name", () => {
    const c = decision({ target: column.id, action: "classify", value: "pii" });
    const s = decision({ target: schema.id, action: "classify", value: { payeeName: "pii" } });
    const out = applyCurated(records, [c, s]);
    expect(out.problems).toEqual([]);
    expect(find(out.records, column.id).classification).toBe("pii");
    expect(find(out.records, column.id).confidence).toBe("asserted");
    expect(find(out.records, schema.id).fields).toEqual([
      { name: "amount", type: "number" },
      { name: "payeeName", classification: "pii" },
    ]);
  });

  it("applies decisions in time order, so the later one wins", () => {
    const later = decision({
      target: auditCall.id,
      action: "assert",
      value: { auth: "oauth2" },
      at: "2026-10-18T12:00:00Z",
    });
    const earlier = decision({
      target: auditCall.id,
      action: "assert",
      value: { auth: "mtls" },
      at: "2026-10-18T11:00:00Z",
    });
    const out = applyCurated(records, [later, earlier]);
    expect(find(out.records, auditCall.id).auth).toBe("oauth2");
    expect(out.applied).toEqual([earlier.id, later.id]);
  });

  it("reports decisions it can't apply and leaves the records as they were", () => {
    const ds = [
      decision({ target: "no-such-record", action: "assert", value: { auth: "mtls" } }),
      decision({ target: auditCall.id, action: "assert", value: "mtls" }),
      decision({ target: auditCall.id, action: "assert", value: { id: "x" } }),
      decision({ target: auditCall.id, action: "assert", value: { via: "carrier-pigeon" } }),
      decision({ target: vendorCall.id, action: "resolve-conflict", value: { sync: "async" } }),
      decision({ target: vendorCall.id, action: "resolve-conflict", value: { via: "sftp" } }),
      decision({ target: auditCall.id, action: "classify", value: "pii" }),
      decision({ target: schema.id, action: "classify", value: { nope: "pii" } }),
      decision({ target: column.id, action: "classify", value: { a: 1 } }),
      decision({ target: "ledger-api", action: "alias", value: 42 }),
      decision({ target: "no-such-record", action: "suppress", value: null }),
    ];
    const out = applyCurated(records, ds);
    expect(out.records).toEqual(records);
    expect(out.applied).toEqual([]);
    expect(out.problems.map((p) => `${p.decision}: ${p.message}`)).toEqual([
      `${ds[0]!.id}: no-such-record isn't in the catalog`,
      `${ds[1]!.id}: an assert needs a value of field names and values`,
      `${ds[2]!.id}: an assert can't change id`,
      expect.stringMatching(new RegExp(`^${ds[3]!.id}: the result isn't a valid Interface: via`)),
      `${ds[4]!.id}: ${vendorCall.id} has no open conflict on sync`,
      `${ds[5]!.id}: "sftp" isn't one of the conflicting values for via (direct, gateway)`,
      `${ds[6]!.id}: classify applies to a Column or a Schema, not an Interface`,
      `${ds[7]!.id}: ${schema.id} has no field nope`,
      `${ds[8]!.id}: classifying a column needs a classification name`,
      `${ds[9]!.id}: an alias needs a name or a list of names`,
      `${ds[10]!.id}: no-such-record isn't in the catalog`,
    ]);
  });

  it("ignores decisions that are no longer current", () => {
    const d = decision({
      target: auditCall.id,
      action: "suppress",
      value: null,
      status: "retired",
    });
    const out = applyCurated(records, [d]);
    expect(out.records).toEqual(records);
    expect(out.applied).toEqual([]);
    expect(out.problems).toEqual([]);
  });

  it("takes decisions mixed in with other records", () => {
    const d = decision({ target: auditCall.id, action: "suppress", value: null });
    expect(applyCurated(records, [...records, d]).suppressed).toEqual([auditCall.id]);
  });
});
