import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FACT_KINDS,
  factsJsonSchemas,
  parseFacts,
  parseRecord,
  projectFacts,
  serializeFacts,
  type Fact,
} from "../src/index.js";

const here = join(__dirname, "fixtures", "facts");
const text = readFileSync(join(here, "forge-ledger.facts.jsonl"), "utf8");

function facts(): Fact[] {
  const r = parseFacts(text);
  if (!r.ok) throw new Error(JSON.stringify(r.issues, null, 2));
  return r.facts;
}

describe("facts: the assistant's input format (ADR 0124)", () => {
  it("has the seven kinds", () => {
    expect([...FACT_KINDS]).toEqual([
      "entry",
      "call",
      "store",
      "field",
      "deploy",
      "config",
      "flow",
    ]);
    expect(Object.keys(factsJsonSchemas()).sort()).toEqual(["Fact", "FactsFile"]);
  });

  it("reads the fixture: one fact per line, every one cited", () => {
    const fs = facts();
    expect(fs).toHaveLength(17);
    for (const f of fs) {
      expect(f.cite.file).toBeTruthy();
      expect(f.cite.line).toBeGreaterThan(0);
      expect(f.cite.value).toBeTruthy();
    }
  });

  it("refuses a fact with no citation, an unknown kind, or a typo", () => {
    const first = facts()[0]!;
    const noCite = { ...first, cite: undefined };
    expect(parseFacts(JSON.stringify(noCite)).ok).toBe(false);
    expect(parseFacts(JSON.stringify({ ...first, kind: "thing" })).ok).toBe(false);
    expect(parseFacts(JSON.stringify({ ...first, pathh: "/x" })).ok).toBe(false);
  });

  it("refuses a secret as a config value", () => {
    const first = facts()[0]!;
    const leak = {
      ...first,
      kind: "config",
      id: "k-leak",
      component: "ledger-api",
      key: "spring.datasource.password",
      value: "hunter2",
      cite: { ...first.cite, value: "password" },
    };
    const r = parseFacts(JSON.stringify(leak));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.issues)).toMatch(/secret/i);
  });

  it("serialises canonically: sorted by id, one line each, the same bytes twice", () => {
    const fs = facts();
    const a = serializeFacts(fs);
    const b = serializeFacts([...fs].reverse());
    expect(a).toBe(b);
    const ids = a
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as Fact).id);
    expect(ids).toEqual([...ids].sort());
    const again = parseFacts(a);
    expect(again.ok && again.facts.length).toBe(17);
  });

  it("reports a dangling reference as an issue, not a crash", () => {
    const fs = facts();
    const bad = fs.map((f) => (f.id === "c-fx-rate" ? { ...f, from: "e-missing" } : f));
    const r = projectFacts(bad);
    expect(r.issues.map((i) => i.code)).toContain("dangling-ref");
  });
});

describe("projectFacts: facts become C1 records, nothing downstream changes", () => {
  const out = projectFacts(facts(), { system: "ledger" });
  const byKind = (k: string) => out.records.filter((r) => r.kind === k);

  it("every projected record parses as a valid C1 record", () => {
    expect(out.records.length).toBeGreaterThan(0);
    for (const r of out.records) {
      const p = parseRecord(r);
      if (!p.ok) throw new Error(`${r.kind} ${r.id}: ${JSON.stringify(p.issues, null, 2)}`);
    }
    expect(out.issues.filter((i) => i.code !== "unresolved-target")).toEqual([]);
  });

  it("entries become Endpoints under their Component, with the citation as evidence", () => {
    const comps = byKind("Component");
    expect(comps.map((c) => c.id)).toEqual(["ledger-api"]);
    const eps = byKind("Endpoint");
    expect(eps.map((e) => e.id).sort()).toEqual([
      "ledger-api.get-accounts-accountid",
      "ledger-api.on-forge-payments-settled",
      "ledger-api.post-accounts-accountid-entries",
    ]);
    const get = eps.find((e) => e.id === "ledger-api.get-accounts-accountid") as Record<
      string,
      unknown
    >;
    expect(get.endpointType).toBe("rest");
    expect(get.method).toBe("GET");
    expect(get.normalizedPath).toBe("/accounts/{}");
    expect(get.auth).toBe("oauth2");
    expect(get.confidence).toBe("verified");
    const ev = (get.evidence as { path: string; line: number; commit: string; side?: string }[])[0];
    expect(ev).toMatchObject({
      path: "src/main/java/forge/ledger/AccountController.java",
      line: 18,
      commit: "0123abc",
      side: "callee",
    });
    const listener = eps.find((e) => e.id === "ledger-api.on-forge-payments-settled") as Record<
      string,
      unknown
    >;
    expect(listener.endpointType).toBe("event-topic");
  });

  it("a call with a known target becomes an Interface; one without becomes Unresolved", () => {
    const ifs = byKind("Interface") as Record<string, unknown>[];
    expect(ifs).toHaveLength(1);
    expect(ifs[0]!).toMatchObject({
      from: "ledger-api",
      to: "northwind-fx",
      method: "GET",
      normalizedPath: "/v1/rates/{}",
      sync: "sync",
      via: "direct",
    });
    const un = byKind("Unresolved") as Record<string, unknown>[];
    expect(un).toHaveLength(1);
    expect(un[0]!.raw).toBe("POST notify.internal /notify");
    expect(out.issues.find((i) => i.code === "unresolved-target")?.factId).toBe("c-notify");
  });

  it("stores become a DataStore, Tables with readers and writers, and Columns from column fields", () => {
    const ds = byKind("DataStore") as Record<string, unknown>[];
    expect(ds.map((d) => d.id)).toEqual(["ledger-db"]);
    expect(ds[0]!.storeType).toBe("relational");
    const tables = byKind("Table") as Record<string, unknown>[];
    expect(tables.map((t) => t.id).sort()).toEqual(["ledger-db.account", "ledger-db.entry"]);
    const entry = tables.find((t) => t.id === "ledger-db.entry")!;
    expect(entry.writers).toEqual(["ledger-api"]);
    expect(entry.readers).toEqual([]);
    const cols = byKind("Column") as Record<string, unknown>[];
    expect(cols.map((c) => c.id).sort()).toEqual([
      "ledger-db.entry.account_id",
      "ledger-db.entry.amount",
    ]);
    const amount = cols.find((c) => c.id === "ledger-db.entry.amount")!;
    expect(amount).toMatchObject({ type: "numeric(18,2)", nullable: false });
    const acc = cols.find((c) => c.id === "ledger-db.entry.account_id")!;
    expect(acc.classification).toBe("internal");
  });

  it("request fields of an entry become a Schema the Endpoint refers to", () => {
    const schemas = byKind("Schema") as Record<string, unknown>[];
    const s = schemas.find((x) => x.id === "ledger-api.post-accounts-accountid-entries.request")!;
    expect(s).toBeTruthy();
    expect((s.fields as { name: string }[]).map((f) => f.name)).toEqual(["amount", "currency"]);
    const ep = byKind("Endpoint").find(
      (e) => e.id === "ledger-api.post-accounts-accountid-entries",
    ) as Record<string, unknown>;
    expect(ep.schemaRefs).toContain("ledger-api.post-accounts-accountid-entries.request");
  });

  it("deploy and config become Deployment and Setting; a secret's source is a reference, never a value", () => {
    const dep = byKind("Deployment") as Record<string, unknown>[];
    expect(dep).toHaveLength(1);
    expect(dep[0]!).toMatchObject({
      id: "ledger-api.prod",
      component: "ledger-api",
      env: "prod",
      platform: "kubernetes",
      replicas: 3,
    });
    const settings = byKind("Setting") as Record<string, unknown>[];
    expect(settings.map((s) => s.id).sort()).toEqual([
      "ledger-api.fx.client.base-url",
      "ledger-api.fx.client.read-timeout",
      "ledger-api.spring.datasource.password",
    ]);
    const pw = settings.find((s) => s.id === "ledger-api.spring.datasource.password")!;
    expect(pw.valueOrRef).toBe("env:LEDGER_DB_PASSWORD");
    const to = settings.find((s) => s.id === "ledger-api.fx.client.read-timeout")!;
    expect(to).toMatchObject({
      settingKind: "timeout",
      valueOrRef: "1500ms",
      target: "northwind-fx",
    });
  });

  it("a flow becomes a Flow with its trigger, steps, refs and errors, every one cited", () => {
    const flows = byKind("Flow") as Record<string, unknown>[];
    expect(flows).toHaveLength(1);
    const f = flows[0]!;
    expect(f.id).toBe("ledger-api.post-a-ledger-entry");
    expect(f.trigger).toMatchObject({
      kind: "endpoint",
      ref: "ledger-api.post-accounts-accountid-entries",
    });
    const steps = f.steps as { kind: string; refs: string[]; evidence: unknown[] }[];
    expect(steps.map((s) => s.kind)).toEqual(["validate", "call-out", "write", "respond"]);
    expect(steps[1]!.refs).toEqual(["if-" + (byKind("Interface")[0]!.id as string).slice(3)]);
    expect(steps[2]!.refs).toEqual(["ledger-db.entry"]);
    for (const s of steps) expect(s.evidence.length).toBeGreaterThan(0);
    expect((f.errors as unknown[]).length).toBe(1);
    expect(f.template).toBe("facts@1");
  });

  it("is deterministic: the same facts give the same records in the same order", () => {
    const a = projectFacts(facts(), { system: "ledger" }).records;
    const b = projectFacts([...facts()].reverse(), { system: "ledger" }).records;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
