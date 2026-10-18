import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import { listIngestors, readMermaid } from "@maycombhq/ingestors";
import { scanInputs, type ScanInputsResult } from "@maycombhq/intake";
import { readDrawio, resolveNames, type Diagram } from "@maycombhq/reconcile";
import {
  expectedFile,
  HARBOR,
  HARBOR_ROOT,
  harborPack,
  harborRecords,
  harborSystems,
  ORG_PACK,
  SCANNED_AT,
  type ExpectedInputs,
} from "./harbor.js";

/**
 * Stage: reading inputs/. The two diagram formats read to the hand-written edges of
 * expected/inputs.yaml, every diagram name resolves as it says, and intake classifies,
 * versions and links each file, leaving the profile-matched spec title to triage.
 */

const inputs = expectedFile<ExpectedInputs>("inputs.yaml");
const text = (p: string) => readFileSync(join(HARBOR, p), "utf8");

async function diagram(file: string): Promise<Diagram> {
  const legend = (await harborPack()).profiles[0]!.profile!.legend;
  return file.endsWith(".mmd") ? readMermaid(text(file), legend) : readDrawio(text(file), legend);
}

describe("the Harbor diagrams (golden: expected/inputs.yaml)", () => {
  for (const want of inputs.diagrams) {
    it(`${want.file} reads to exactly the listed boxes and edges`, async () => {
      const d = await diagram(want.file);
      expect(d.problems).toEqual([]);
      expect(d.nodes.map((n) => n.label)).toEqual(want.boxes);
      expect(d.edges).toHaveLength(want.edges.length);
      want.edges.forEach((e, i) => {
        const got = d.edges[i] as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(e)) expect(got[k] ?? null, `${e.cell}.${k}`).toEqual(v);
        for (const k of ["pattern", "method", "path", "topic", "legend"])
          if (!(k in e)) expect(got[k], `${e.cell}.${k}`).toBeUndefined();
        expect(got.page).toBe(want.page);
      });
    });
  }

  it("resolves every diagram name as expected/inputs.yaml says", async () => {
    const names = Object.keys(inputs.aliases);
    const got = resolveNames(names, harborRecords(), harborSystems(await harborPack()));
    for (const n of names) expect(got.get(n)?.id ?? null, n).toBe(inputs.aliases[n]);
    expect(got.get("Product Catalog")!.how).toBe("profile");
    expect([...got.values()].filter((r) => r.how === "profile").map((r) => r.name)).toEqual([
      "Product Catalog",
    ]);
  });
});

describe("intake of the Harbor inputs/", () => {
  let res: ScanInputsResult;
  beforeAll(async () => {
    res = await scanInputs({
      root: HARBOR_ROOT,
      orgPack: ORG_PACK,
      inputsDir: join(HARBOR, "inputs"),
      records: harborRecords() as CatalogRecord[],
      ingestors: listIngestors(),
      scannedAt: SCANNED_AT,
    });
  });

  const doc = (p: string) => res.documents.find((d) => d.path === p)!;

  it("reads every input but the wiki, which another reader owns, with no problems", () => {
    expect(res.problems).toEqual([]);
    expect(res.documents.map((d) => d.path)).toEqual(inputs.documents.map((d) => d.path));
  });

  it("supersedes the older partner spec by its version and reads only the current one (h14)", () => {
    const v1 = doc("inputs/partner-specs/tidewater-payments-openapi-v1.yaml");
    const v2 = doc("inputs/partner-specs/tidewater-payments-openapi-v2.yaml");
    expect([v1.status, v1.supersededBy, v1.version]).toEqual([
      "superseded",
      "doc.tidewater-payments-openapi-v2",
      "1.4.0",
    ]);
    expect([v2.classification, v2.status, v2.version, v2.systems]).toEqual([
      "openapi",
      "read",
      "2.1.0",
      ["tidewater-payments"],
    ]);
    // Only v2's operations reach the catalog: the retired POST /v1/payments never does.
    expect(
      res.records
        .filter((r) => r.kind === "Endpoint")
        .map((r) => r.id)
        .sort(),
    ).toEqual([
      "tidewater-payments.get-charge",
      "tidewater-payments.post-charge",
      "tidewater-payments.post-refund",
    ]);
  });

  it("leaves the spec title matched only through the profile to triage (h15)", () => {
    expect(res.triage.map((t) => ({ id: t.id, kind: t.kind, records: t.records }))).toEqual(
      inputs.triage,
    );
  });

  it("reads the draw.io diagram and links it to the systems it names", () => {
    const want = inputs.documents.find((d) => d.path.endsWith(".drawio"))!;
    const got = doc(want.path);
    expect([got.classification, got.status, got.systems]).toEqual([
      want.classification,
      want.status,
      want.systems,
    ]);
  });

  it("reads the Mermaid diagram with the Mermaid ingestor", () => {
    const got = doc("inputs/diagrams/harbor-architecture.mmd");
    expect([got.status, got.reader]).toEqual(["read", "mermaid@0.1.0"]);
  });

  // Missing producer: intake classifying Mermaid text as a diagram and linking the systems its
  // boxes name (it reads draw.io names only); no lane owns this yet.
  it.skip("classifies the Mermaid diagram and links it to the systems it names", () => {
    const want = inputs.documents.find((d) => d.path.endsWith(".mmd"))!;
    const got = doc(want.path);
    expect([got.classification, got.systems]).toEqual([want.classification, want.systems]);
  });

  it("takes the GitHub issues export as a ticket export no reader handles yet (h16)", () => {
    const want = inputs.documents.find((d) => d.path.includes("github-issues"))!;
    const got = doc(want.path);
    expect([got.classification, got.status, got.systems]).toEqual([
      want.classification,
      want.status,
      want.systems,
    ]);
  });

  // Missing producer: intake recognising a Jira REST search export ({ issues: [{ key, fields }] })
  // as a ticket export; today it is classified as an API payload sample and a Schema is read
  // from it. No lane owns this yet.
  it.skip("takes the Jira export as a ticket export, not a payload sample (h16)", () => {
    const want = inputs.documents.find((d) => d.path.includes("jira"))!;
    const got = doc(want.path);
    expect([got.classification, got.status, got.systems]).toEqual([
      want.classification,
      want.status,
      want.systems,
    ]);
    expect(res.records.some((r) => r.kind === "Schema")).toBe(false);
  });
});
