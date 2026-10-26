import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { newChange } from "@maycombhq/changes";
import { scanEstate } from "@maycombhq/scanner";
import {
  absorb,
  adopt,
  federatedChanges,
  federatedSources,
  federationConflicts,
  resolveMetarepo,
} from "../src/index.js";
import { cleanup, COMMIT, copyFixture, fixture, SCANNED_AT } from "./helpers.js";

afterAll(cleanup);

const state = async () => ({ commit: COMMIT, dirty: false });

/** Adopt the catalog service, absorb the payments metarepo, and accept the sources.yaml entry. */
async function federatedRepo(): Promise<string> {
  const dir = await copyFixture("openspec-repo", "catalog-service");
  await adopt(dir);
  const r = await absorb(dir, fixture("atticus-metarepo"), { id: "payments" });
  // What the reviewer does with the proposal: add the absorbed entry to sources.yaml.
  const p = await resolveMetarepo(dir);
  const file = join(p.orgPackDir, "sources.yaml");
  const sources = parse(await readFile(file, "utf8")) as Record<string, unknown>;
  sources.absorbed = [r.entry];
  await writeFile(file, stringify(sources), "utf8");
  return dir;
}

describe("federation in the scan", () => {
  it("adds the federated catalog with its origin kept, and local code wins (golden)", async () => {
    const dir = await federatedRepo();
    expect(await federatedSources(dir)).toEqual([
      { id: "payments", dir: fixture("atticus-metarepo") },
    ]);
    const scan = await scanEstate({ root: dir, repoState: state, scannedAt: SCANNED_AT });
    expect(scan.problems).toEqual([]);
    expect(scan.federated).toEqual([
      { id: "payments", added: 3, shadowed: ["Component/catalog-service"] },
    ]);
    // Local code wins: the catalog-service component is the one read from our pom.xml.
    const local = scan.records.find((r) => r.kind === "Component" && r.id === "catalog-service")!;
    expect(local.confidence).toBe("verified");
    expect(local.flags ?? []).not.toContain("federated:payments");
    expect(local.evidence[0]).toMatchObject({
      source: "config",
      repo: "catalog-service",
      path: "pom.xml",
    });

    // Hand-written golden: their records, unchanged but for the flag and the export evidence.
    const fed = scan.records.filter((r) => r.flags?.includes("federated:payments"));
    expect(fed).toEqual([
      {
        schemaVersion: 3,
        kind: "Component",
        id: "payments-api",
        status: "current",
        confidence: "verified",
        evidence: [
          { source: "config", repo: "payments-api", path: "pom.xml" },
          {
            source: "export",
            repo: "payments",
            path: "catalog/generated/component/payments-api.yaml",
          },
        ],
        flags: ["federated:payments"],
        system: "payments",
        repo: "payments-api",
        type: "spring-boot",
      },
      {
        schemaVersion: 3,
        kind: "Endpoint",
        id: "payments-api.post.payments",
        status: "current",
        confidence: "verified",
        evidence: [
          {
            source: "code",
            repo: "payments-api",
            path: "src/main/java/com/example/payments/PaymentsController.java",
            line: 14,
          },
          {
            source: "export",
            repo: "payments",
            path: "catalog/generated/endpoint/payments-api.post.payments.yaml",
          },
        ],
        flags: ["federated:payments"],
        component: "payments-api",
        endpointType: "rest",
        method: "POST",
        pathOrTopic: "/payments",
        normalizedPath: "/payments",
        schemaRefs: [],
      },
      {
        schemaVersion: 3,
        kind: "Interface",
        id: "if-f834203081e831d1",
        status: "current",
        confidence: "inferred",
        evidence: [
          {
            source: "code",
            repo: "payments-api",
            path: "src/main/java/com/example/payments/CatalogClient.java",
            line: 9,
            side: "caller",
          },
          {
            source: "export",
            repo: "payments",
            path: "catalog/generated/interface/if-f834203081e831d1.yaml",
          },
        ],
        flags: ["federated:payments"],
        from: "payments-api",
        to: "catalog-service",
        via: "direct",
        method: "GET",
        normalizedPath: "/products/{sku}",
        sync: "sync",
        direction: "outbound",
        conflicts: [],
      },
    ]);
  });

  it("an explicit federated option works without sources.yaml, and none means no change", async () => {
    const dir = await copyFixture("openspec-repo", "catalog-service");
    await adopt(dir);
    const plain = await scanEstate({
      root: dir,
      repoState: state,
      scannedAt: SCANNED_AT,
      cache: null,
    });
    expect(plain.federated).toBeUndefined();
    const fed = await scanEstate({
      root: dir,
      repoState: state,
      scannedAt: SCANNED_AT,
      cache: null,
      federated: [{ id: "payments", dir: fixture("atticus-metarepo") }],
    });
    expect(fed.records.length).toBe(plain.records.length + 3);
  });
});

describe("federated changes for conflict detection", () => {
  it("reads their open changes read-only and finds overlaps with ours", async () => {
    const dir = await federatedRepo();
    const theirs = await federatedChanges(await federatedSources(dir));
    expect(theirs.map((c) => [c.origin, c.change.id, c.change.state])).toEqual([
      ["payments", "add-refunds", "design"],
    ]);
    await newChange(dir, {
      id: "add-product-notes",
      title: "Add product notes",
      type: "feature",
      by: "pat",
      systems: ["catalog-service"],
      now: SCANNED_AT,
    });
    expect(await federationConflicts(dir)).toEqual([
      {
        changes: ["add-product-notes", "payments:add-refunds"],
        overlap: {
          systems: ["catalog-service"],
          interfaces: [],
          dataStores: [],
          tables: [],
          records: [],
          repos: [],
          flows: [],
        },
      },
    ]);
  });
});
