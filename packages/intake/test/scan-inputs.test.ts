import { readFileSync } from "node:fs";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { interfaceId, parseRecord, type CatalogRecord } from "@maycombhq/core";
import type { Ingestor } from "@maycombhq/sdk";
import { scanInputs } from "../src/index.js";

const MIXED = join(dirname(fileURLToPath(import.meta.url)), "fixtures/mixed");
const expected = parse(readFileSync(join(MIXED, "expected.yaml"), "utf8")) as {
  documents: unknown[];
  records: Record<string, unknown>[];
  triage: unknown[];
  problems: unknown[];
};
const rec = (r: Record<string, unknown>): CatalogRecord => {
  const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
  if (!p.ok) throw new Error(`${String(r.id)}: ${JSON.stringify(p.issues)}`);
  return p.record;
};
const opts = {
  root: join(MIXED, "metarepo"),
  inputsDir: join(MIXED, "inputs"),
  scannedAt: "2026-10-18T09:00:00Z",
};

describe("scanInputs (golden: fixtures/mixed)", () => {
  it("classifies, dedupes and versions every file, and reads what it can", async () => {
    const res = await scanInputs(opts);
    expect(res.problems).toEqual(expected.problems);
    expect(res.documents).toEqual(expected.documents);
  });

  it("emits records tagged with their source, field for field", async () => {
    const res = await scanInputs(opts);
    expect(res.records).toEqual(expected.records.map(rec));
  });

  it("sends to triage only what it can't settle", async () => {
    const res = await scanInputs(opts);
    expect(res.triage).toEqual(expected.triage);
  });

  it("gives the same result every time", async () => {
    expect(await scanInputs(opts)).toEqual(await scanInputs(opts));
  });

  it("defaults to <root>/inputs and copes with no inputs at all", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-intake-"));
    await cp(join(MIXED, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
    expect(await scanInputs({ root })).toEqual({
      records: [],
      documents: [],
      triage: [],
      problems: [],
    });
    await cp(join(MIXED, "inputs/partner-specs"), join(root, "inputs/partner-specs"), {
      recursive: true,
    });
    const res = await scanInputs({ root });
    expect(res.documents.map((d) => [d.path, d.status])).toEqual([
      ["inputs/partner-specs/contoso-events-asyncapi.yaml", "read"],
      ["inputs/partner-specs/fabrikam-fx-openapi-v1.yaml", "superseded"],
      ["inputs/partner-specs/fabrikam-fx-openapi-v2.yaml", "read"],
    ]);
  });
});

describe("decisions people have made", () => {
  const decision = (d: Record<string, unknown>) =>
    rec({
      kind: "CuratedDecision",
      confidence: "asserted",
      evidence: [],
      reason: "checked",
      by: "a.architect",
      at: "2026-10-18T10:00:00Z",
      ...d,
    });

  it("an alias decision settles an unknown title, and the spec's facts come in", async () => {
    const res = await scanInputs({
      ...opts,
      records: [
        decision({
          id: "alias.tailspin-billing",
          target: "billing-hub",
          action: "alias",
          value: "Tailspin Billing",
        }),
      ],
    });
    const doc = res.documents.find((d) => d.path === "inputs/inbox/tailspin-openapi.yaml")!;
    expect(doc).toMatchObject({ status: "read", systems: ["billing-hub"], unknownNames: [] });
    expect(doc.records).toEqual(["billing-hub", "billing-hub.get-invoice"]);
    expect(res.records.find((r) => r.id === "billing-hub.get-invoice")).toMatchObject({
      component: "billing-hub",
      confidence: "verified",
      evidence: [
        { source: "spec", path: "inputs/inbox/tailspin-openapi.yaml", line: 6, side: "definition" },
      ],
    });
    expect(res.triage.map((t) => t.id)).not.toContain("unknown-name.tailspin-billing");
  });

  it("a supersede decision settles which version is newer", async () => {
    const res = await scanInputs({
      ...opts,
      records: [
        decision({
          id: "triage.version-unclear.doc-handbook",
          target: "doc.handbook",
          action: "assert",
          value: { supersededBy: "doc.inbox-handbook" },
        }),
      ],
    });
    expect(res.documents.find((d) => d.path === "inputs/docs/handbook.md")).toMatchObject({
      status: "superseded",
      supersededBy: "doc.inbox-handbook",
    });
    expect(res.triage.filter((t) => t.kind === "version-unclear")).toEqual([]);
  });
});

describe("partner specs never overwrite facts verified from code", () => {
  const code = (path: string, line: number, side: "caller" | "callee") => ({
    source: "code" as const,
    repo: "acme-billing",
    path,
    line,
    side,
  });
  const catalog = [
    rec({
      kind: "Component",
      id: "billing-api",
      confidence: "verified",
      system: "billing-hub",
      repo: "acme-billing",
      type: "service",
      evidence: [code("pom.xml", 1, "callee")],
    }),
    // the code says Fabrikam's rates call uses OAuth; the partner spec says an API key
    rec({
      kind: "Endpoint",
      id: "fabrikam-fx.get-rate",
      confidence: "verified",
      component: "fabrikam-fx",
      endpointType: "rest",
      method: "GET",
      pathOrTopic: "/v2/rates/{pair}",
      normalizedPath: "/v2/rates/{}",
      auth: "oauth2",
      evidence: [code("src/FxClient.java", 4, "callee")],
    }),
    // a call the partner spec doesn't have
    rec({
      kind: "Interface",
      id: interfaceId("billing-api", "fabrikam-fx", "DELETE", "/v2/quotes/{}"),
      confidence: "inferred",
      from: "billing-api",
      to: "fabrikam-fx",
      via: "direct",
      method: "DELETE",
      normalizedPath: "/v2/quotes/{}",
      sync: "sync",
      evidence: [code("src/FxClient.java", 9, "caller")],
    }),
  ];

  it("reports each disagreement for a person to decide, offering both sides", async () => {
    const res = await scanInputs({ ...opts, records: catalog });
    const conflicts = res.triage.filter((t) => t.kind === "conflict");
    const missingId = interfaceId("billing-api", "fabrikam-fx", "DELETE", "/v2/quotes/{}");
    expect(conflicts).toEqual([
      {
        id: "conflict.fabrikam-fx-get-rate-auth",
        kind: "conflict",
        summary:
          "The partner spec says fabrikam-fx.get-rate uses api-key; the code says oauth2. The code stands until someone decides.",
        source: { path: "inputs/partner-specs/fabrikam-fx-openapi-v2.yaml", line: 14 },
        records: ["fabrikam-fx.get-rate"],
        options: [
          {
            action: "suppress",
            label: "The code is right",
            decision: {
              id: "triage.conflict.fabrikam-fx-get-rate-auth",
              target: "fabrikam-fx.get-rate",
              action: "suppress",
              value: { triage: "conflict.fabrikam-fx-get-rate-auth" },
              reason: "The code is right",
            },
          },
          {
            action: "assert",
            label: "The partner spec is right: auth is api-key",
            decision: {
              id: "triage.conflict.fabrikam-fx-get-rate-auth",
              target: "fabrikam-fx.get-rate",
              action: "assert",
              value: { auth: "api-key" },
              reason: "The partner spec is right: auth is api-key",
            },
          },
        ],
      },
      {
        id: `conflict.${missingId}-not-in-spec`,
        kind: "conflict",
        summary:
          "In code billing-api calls DELETE /v2/quotes/{} on fabrikam-fx, which the partner spec doesn't have.",
        source: { path: "inputs/partner-specs/fabrikam-fx-openapi-v2.yaml" },
        records: [missingId],
        options: [
          {
            action: "suppress",
            label: "The code is right",
            decision: {
              id: `triage.conflict.${missingId}-not-in-spec`,
              target: missingId,
              action: "suppress",
              value: { triage: `conflict.${missingId}-not-in-spec` },
              reason: "The code is right",
            },
          },
        ],
      },
    ]);
  });
});

describe("pluggable ingestors", () => {
  /** Stands in for an image reader from another package: one edge read off a whiteboard photo. */
  const whiteboard: Ingestor = {
    id: "whiteboard",
    version: "1.0.0",
    sniff: (name) => (name.endsWith(".png") ? 1 : 0),
    async *ingest(fileName) {
      yield {
        schemaVersion: 1,
        kind: "Interface",
        id: interfaceId("billing-hub", "fabrikam-fx", "POST", "/v2/quotes"),
        status: "current",
        confidence: "verified",
        from: "billing-hub",
        to: "fabrikam-fx",
        via: "direct",
        method: "POST",
        normalizedPath: "/v2/quotes",
        sync: "sync",
        direction: "outbound",
        conflicts: [],
        evidence: [{ source: "diagram", path: fileName }],
      } as unknown as CatalogRecord;
      yield {
        schemaVersion: 1,
        kind: "Unresolved",
        id: "whiteboard.no-citation",
        status: "current",
        confidence: "inferred",
        unresolvedKind: "box",
        raw: "Tax Engine",
        evidence: [{ source: "diagram", path: "elsewhere.png" }],
      } as unknown as CatalogRecord;
    },
  };
  const broken: Ingestor = {
    id: "broken",
    version: "0.1.0",
    sniff: (name) => (name.endsWith(".csv") ? 1 : 0),
    // eslint-disable-next-line require-yield
    async *ingest() {
      throw new Error("bad sheet");
    },
  };

  it("uses the ingestor that claims a file, caps what it says at inferred, and drops uncited records", async () => {
    const res = await scanInputs({ ...opts, ingestors: [whiteboard, broken] });
    const doc = res.documents.find((d) => d.path === "inputs/inbox/whiteboard.png")!;
    expect(doc).toMatchObject({ status: "read", reader: "whiteboard@1.0.0" });
    const edge = res.records.find((r) => r.kind === "Interface")!;
    expect(edge.confidence).toBe("inferred");
    expect(res.records.some((r) => r.id === "whiteboard.no-citation")).toBe(false);
    expect(res.documents.find((d) => d.path === "inputs/inbox/ownership.csv")).toMatchObject({
      status: "failed",
      reader: "broken@0.1.0",
    });
    expect(res.problems).toEqual([
      {
        path: "inputs/inbox/ownership.csv",
        message: "broken@0.1.0 failed: bad sheet",
      },
      {
        path: "inputs/inbox/whiteboard.png",
        message:
          "whiteboard@1.0.0 emitted Unresolved whiteboard.no-citation without citing the file; left out",
      },
    ]);
  });
});
