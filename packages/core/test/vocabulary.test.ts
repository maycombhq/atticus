import { describe, expect, it } from "vitest";
import {
  COMPONENT_TYPES,
  STORE_TYPES,
  catalogJsonSchemas,
  deserializeRecord,
  interfaceId,
  parseRecord,
  serializeRecord,
} from "../src/index.js";
import { EXAMPLES } from "./examples.js";

/** ADR 0040: the catalog vocabulary for any ecosystem, added to schema version 2. */
describe("ADR 0040 vocabulary", () => {
  const endpoint = (endpointType: string, method: string | undefined, pathOrTopic: string) => ({
    ...EXAMPLES.Endpoint,
    id: `ledger-api.${endpointType}`,
    endpointType,
    method,
    pathOrTopic,
    normalizedPath: undefined,
  });

  it.each([
    ["graphql", "QUERY", "Query.account"],
    ["graphql", "MUTATION", "Mutation.openAccount"],
    ["graphql", "SUBSCRIPTION", "Subscription.balanceChanged"],
    ["websocket", undefined, "/ws/quotes"],
    ["sse", "GET", "/events/statements"],
    ["webhook", "POST", "/hooks/payments"],
    ["function", undefined, "http:/resize"],
    ["transaction", undefined, "PAY1"],
  ])("reads an Endpoint of type %s", (type, method, path) => {
    const r = parseRecord(endpoint(type, method, path));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.record).toMatchObject({ endpointType: type, pathOrTopic: path });
  });

  it("still refuses an endpoint type nobody decided", () => {
    expect(parseRecord(endpoint("carrier-pigeon", undefined, "x")).ok).toBe(false);
  });

  it.each(["mesh", "webhook"])("reads an Interface via %s", (via) => {
    const i = EXAMPLES.Interface as Record<string, unknown>;
    const r = parseRecord({
      ...i,
      via,
      id: interfaceId(
        String(i.from),
        String(i.to),
        i.method as string | undefined,
        String(i.normalizedPath),
      ),
    });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.record).toMatchObject({ via });
  });

  it("reads a schedule Setting, and the older config + schedule.<job> form still reads", () => {
    const schedule = parseRecord({
      ...EXAMPLES.Setting,
      id: "ledger-api.schedule.nightly",
      settingKind: "schedule",
      key: "schedule.nightly",
      valueOrRef: "0 2 * * *",
    });
    if (!schedule.ok) throw new Error(JSON.stringify(schedule.issues));
    expect(schedule.record).toMatchObject({ settingKind: "schedule" });
    const old = parseRecord({
      ...EXAMPLES.Setting,
      settingKind: "config",
      key: "schedule.nightly",
      valueOrRef: "0 2 * * *",
    });
    expect(old.ok).toBe(true);
  });

  it("reads Deployment.ingress and leaves it out when absent", () => {
    const r = parseRecord({
      ...EXAMPLES.Deployment,
      ingress: [
        { host: "ledger.forge.example", path: "/api", tls: true },
        { host: "ledger.internal" },
      ],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.record).toMatchObject({
      ingress: [
        { host: "ledger.forge.example", path: "/api", tls: true },
        { host: "ledger.internal" },
      ],
    });
    const text = serializeRecord(r.record);
    expect(text).toContain(
      "ingress:\n  - host: ledger.forge.example\n    path: /api\n    tls: true\n",
    );
    const back = deserializeRecord(text);
    expect(back.ok && back.record).toEqual(r.record);
    const plain = parseRecord(EXAMPLES.Deployment);
    expect(plain.ok && "ingress" in plain.record).toBe(false);
  });

  it("refuses an ingress route without a host or with an unknown field", () => {
    expect(parseRecord({ ...EXAMPLES.Deployment, ingress: [{ path: "/x" }] }).ok).toBe(false);
    expect(parseRecord({ ...EXAMPLES.Deployment, ingress: [{ host: "h", weight: 3 }] }).ok).toBe(
      false,
    );
  });

  it("documents store and component types, and free text still reads", () => {
    expect(STORE_TYPES).toEqual([
      "relational",
      "document",
      "key-value",
      "cache",
      "warehouse",
      "lake",
      "object-storage",
      "search",
      "feature-store",
      "queue",
      "stream",
      "file-share",
    ]);
    expect(COMPONENT_TYPES).toEqual([
      "service",
      "spa",
      "bff",
      "mobile-app",
      "desktop-app",
      "function",
      "batch-job",
      "data-pipeline",
      "ml-model",
      "gateway",
      "worker",
      "library",
      "mainframe-program",
    ]);
    expect(parseRecord({ ...EXAMPLES.Component, type: "kiosk" }).ok).toBe(true);
    expect(parseRecord({ ...EXAMPLES.DataStore, storeType: "postgres" }).ok).toBe(true);
  });

  it("reads a SaaS system by the tags convention", () => {
    const r = parseRecord({
      ...EXAMPLES.System,
      id: "northwind-pay",
      name: "Northwind Pay",
      boundary: "vendor",
      tags: ["saas"],
    });
    expect(r.ok).toBe(true);
  });

  it("version-1 files with the new values read as version 2", () => {
    const r = parseRecord({
      ...endpoint("graphql", "QUERY", "Query.account"),
      schemaVersion: 1,
    });
    expect(r.ok && r.record.schemaVersion).toBe(2);
  });

  it("shows the additions in the generated JSON Schema", () => {
    const s = catalogJsonSchemas();
    const ep = s.Endpoint as { properties: { endpointType: { enum: string[] } } };
    expect(ep.properties.endpointType.enum).toEqual(
      expect.arrayContaining(["graphql", "websocket", "sse", "webhook", "function", "transaction"]),
    );
    const dep = s.Deployment as { properties: Record<string, unknown>; required: string[] };
    expect(dep.properties.ingress).toBeDefined();
    expect(dep.required).not.toContain("ingress");
  });
});
