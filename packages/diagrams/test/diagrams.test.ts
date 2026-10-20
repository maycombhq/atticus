import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadOrgPack, parseRecord, type CatalogRecord } from "@maycombhq/core";
import { readDrawio, reconcile } from "@maycombhq/reconcile";
import {
  containerView,
  contextView,
  dataView,
  eventView,
  sequenceView,
  shapeLibrary,
  toDrawio,
  toMermaid,
  viewFromDiagram,
  type FlowView,
} from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const golden = (name: string) => readFileSync(join(HERE, "fixtures/golden", name), "utf8");

function load(file: string, defaults: Record<string, unknown>): CatalogRecord[] {
  return (parse(readFileSync(file, "utf8")) as Record<string, unknown>[]).map((r) => {
    const p = parseRecord({ schemaVersion: 1, ...defaults, ...r });
    if (!p.ok) throw new Error(`${String(r.id)}: ${JSON.stringify(p.issues)}`);
    return p.record;
  });
}
const forge = () => load(join(FORGE, "expected/scan.yaml"), { status: "current" });
const planned = () => load(join(HERE, "fixtures/planned-catalog.yaml"), {});

/** Same records, different order: output must not depend on it. */
const shuffled = (rs: CatalogRecord[]) =>
  rs
    .map((r, i) => ({ r, k: (i * 7919) % 101 }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.r);

describe("Mermaid views (golden files written by hand)", () => {
  it("context view: systems and their interfaces, boundaries styled", () => {
    expect(toMermaid(contextView(forge()))).toBe(golden("forge-context.mmd"));
  });

  it("container view: one system's components and their neighbours", () => {
    expect(toMermaid(containerView(forge(), "portal"))).toBe(golden("forge-container-portal.mmd"));
    expect(toMermaid(containerView(forge(), "ledger"))).toBe(golden("forge-container-ledger.mmd"));
  });

  it("data view: components and the tables they read and write", () => {
    expect(toMermaid(dataView(forge()))).toBe(golden("forge-data.mmd"));
  });

  it("event view: topics with publishers and subscribers", () => {
    expect(toMermaid(eventView(forge()))).toBe(golden("forge-event.mmd"));
  });

  it("sequence view for an impact path", () => {
    expect(
      toMermaid(sequenceView(forge(), ["portal-ui", "portal-bff", "ledger-api", "northwind-pay"])),
    ).toBe(golden("forge-sequence.mmd"));
  });

  it("planned records are styled by legend", () => {
    expect(toMermaid(contextView(planned()))).toBe(golden("planned-context.mmd"));
    expect(toMermaid(dataView(planned()))).toBe(golden("planned-data.mmd"));
  });

  it("output doesn't depend on record order", () => {
    const rs = shuffled(forge());
    expect(toMermaid(contextView(rs))).toBe(golden("forge-context.mmd"));
    expect(toMermaid(containerView(rs, "portal"))).toBe(golden("forge-container-portal.mmd"));
    expect(toMermaid(dataView(rs))).toBe(golden("forge-data.mmd"));
    expect(toMermaid(eventView(rs))).toBe(golden("forge-event.mmd"));
  });
});

describe("views: focus, edge cases", () => {
  it("narrows the data and event views to a focus", () => {
    const d = dataView(forge(), "reports");
    expect(d.nodes.map((n) => n.id)).toEqual(["ledger-db.entry", "ledger-api", "reports-job"]);
    expect(d.edges.map((e) => e.id)).toEqual([
      "access.ledger-api.ledger-db.entry",
      "access.reports-job.ledger-db.entry",
    ]);
    const e = eventView(forge(), "reports-job");
    expect(e.nodes.map((n) => n.id)).toEqual([
      "ledger-api",
      "reports-job",
      "topic.transfers-completed",
    ]);
    expect(eventView(forge(), "topic.payments-initiated").edges.map((x) => x.label)).toEqual([
      "publishes",
      "delivers to",
    ]);
  });

  it("refuses an unknown focus", () => {
    expect(() => containerView(forge(), "nope")).toThrow(/No system "nope" in the catalog/);
    expect(() => dataView(forge(), "nope")).toThrow(/"nope" isn't in the catalog/);
    expect(() => sequenceView(forge(), ["portal-ui", "nope"])).toThrow(
      /"nope" isn't in the catalog/,
    );
  });

  it("sequence steps follow the real direction, table access and explicit interfaces", () => {
    const text = (ids: string[]) => toMermaid(sequenceView(forge(), ids)).split("\n").slice(2);
    expect(text(["reports-job", "ledger-db.entry"])).toEqual([
      "  participant reports_job as reports-job",
      "  participant ledger_db_entry as ledger-db.entry",
      "  reports_job->>ledger_db_entry: reads",
      "",
    ]);
    expect(text(["reports-job", "ledger-api"])).toEqual([
      "  participant reports_job as reports-job",
      "  participant ledger_api as ledger-api",
      "  ledger_api-)reports_job: A.EB.PUB transfers.completed",
      "",
    ]);
    expect(text(["audit-svc", "northwind-pay"])).toEqual([
      "  participant audit_svc as audit-svc",
      "  participant northwind_pay as Northwind Pay",
      "  Note over audit_svc,northwind_pay: No known link between audit-svc and northwind-pay",
      "",
    ]);
    expect(text(["if-e7344c9455608119", "northwind-pay"])).toEqual([
      "  participant ledger_api as ledger-api",
      "  participant northwind_pay as Northwind Pay",
      "  ledger_api->>northwind_pay: POST /v2/payments",
      "",
    ]);
  });

  it("styles planned modify and retire edges and keeps Mermaid ids safe", () => {
    const rs = planned().map((r) =>
      r.id === "if-ac5205eb0a051483" ? ({ ...r, status: "planned-retire" } as CatalogRecord) : r,
    );
    rs.push({
      schemaVersion: 1,
      kind: "System",
      id: "end",
      status: "current",
      confidence: "asserted",
      name: "End",
      boundary: "internal",
      repos: [],
      tags: [],
      accessGroup: "everyone",
      evidence: [{ source: "manual", by: "fixture" }],
    } as CatalogRecord);
    const text = toMermaid(contextView(rs));
    expect(text).toContain('  end_["End"]\n');
    expect(text).toContain("  linkStyle 0 stroke:#b71c1c,stroke-width:2px,stroke-dasharray:2 2\n");
    expect(text).toContain("  linkStyle 2 stroke:#2e7d32,stroke-width:2px,stroke-dasharray:6 3\n");
  });
});

describe("draw.io export and the reconcile round trip", () => {
  async function roundTrip(view: FlowView, records: CatalogRecord[]) {
    const op = await loadOrgPack(join(FORGE, "metarepo/org-pack"));
    const profile = op.profiles[0]!.profile!;
    const diagram = readDrawio(toDrawio(view), profile.legend);
    return {
      diagram,
      result: reconcile({
        diagram,
        file: "exported.drawio",
        records,
        systems: profile.systems,
        patterns: op.patterns,
      }),
    };
  }

  it("labels nodes with names (ids when a name doesn't slug to the id) and edges in the reconcile grammar", async () => {
    const { diagram } = await roundTrip(contextView(planned()), planned());
    expect(diagram.problems).toEqual([]);
    expect(diagram.nodes.map((n) => [n.label, n.legend ?? null])).toEqual([
      ["Contoso KYC", "retire"],
      ["Ledger", "modify"],
      ["notify", "new"],
      ["Portal", null],
    ]);
    expect(
      diagram.edges.map((e) => [
        e.from,
        e.to,
        e.pattern,
        e.method ?? e.topic,
        e.path ?? null,
        e.legend ?? null,
      ]),
    ).toEqual([
      ["Ledger", "Contoso KYC", "S.GW.VND", "POST", "/v1/checks", null],
      ["Portal", "Ledger", "S.GW.SOR", "GET", "/accounts/{id}/balance", null],
      ["Portal", "notify", "A.EB.PUB", "notifications.requested", null, "new"],
    ]);
  });

  it("reading the exported context view back and reconciling it finds nothing to resolve", async () => {
    const { result } = await roundTrip(contextView(planned()), planned());
    expect(result.items).toEqual([]);
    expect(result.matches.flatMap((m) => m.interfaces).sort()).toEqual([
      "if-598c22ef7274546a",
      "if-75b5e8d8aa780837",
      "if-ac5205eb0a051483",
    ]);
  });

  it("on the Forge catalog every interface matches; only the undrawn table access is left", async () => {
    const { result } = await roundTrip(contextView(forge()), forge());
    expect(result.items.filter((i) => i.type === "alias-needed")).toEqual([]);
    expect(result.items.map((i) => i.id)).toEqual(["code-only.reports-job-ledger-db-entry"]);
    expect(result.matches.flatMap((m) => m.interfaces).sort()).toEqual(
      forge()
        .filter((r) => r.kind === "Interface")
        .map((r) => r.id)
        .sort(),
    );
  });

  it("a container view round-trips too; only the neighbours' other interfaces are code-only", async () => {
    const { result } = await roundTrip(containerView(forge(), "portal"), forge());
    expect(result.items.map((i) => [i.type, i.records])).toEqual([
      ["code-only", ["if-e7344c9455608119"]],
      ["code-only", ["if-f1cd1f189eaa4b7b"]],
    ]);
    expect(result.matches).toHaveLength(5);
  });

  it("is deterministic and refuses a sequence view", () => {
    expect(toDrawio(contextView(forge()))).toBe(toDrawio(contextView(shuffled(forge()))));
    expect(toDrawio(contextView(forge()))).toMatch(/^<mxfile host="atticus"/);
    expect(() =>
      toDrawio(sequenceView(forge(), ["portal-ui", "portal-bff"]) as unknown as FlowView),
    ).toThrow(/sequence/);
  });
});

describe("draw.io input rendered as Mermaid", () => {
  it("renders the Forge diagram as drawn", () => {
    const xml = readFileSync(join(FORGE, "inputs/diagrams/forge-context.drawio"), "utf8");
    const view = viewFromDiagram(readDrawio(xml), "inputs/diagrams/forge-context.drawio");
    expect(toMermaid(view)).toBe(golden("forge-drawio.mmd"));
  });
});

describe("shape library", () => {
  const entries = () => {
    const m = /^<mxlibrary>(.*)<\/mxlibrary>\n?$/s.exec(shapeLibrary());
    expect(m).not.toBeNull();
    return JSON.parse(m![1]!) as { xml: string; w: number; h: number; title: string }[];
  };
  const inflate = (b64: string) =>
    decodeURIComponent(inflateRawSync(Buffer.from(b64, "base64")).toString("utf8"));

  it("has system, component, vendor, data store and topic shapes, each with the three legend styles", () => {
    const titles = entries().map((e) => e.title);
    expect(titles).toEqual(
      ["System", "Component", "Vendor", "Data store", "Topic"].flatMap((t) => [
        t,
        `${t} (new)`,
        `${t} (modify)`,
        `${t} (retire)`,
      ]),
    );
  });

  it("each shape reads back as one labelled box with its legend", () => {
    for (const e of entries()) {
      const d = readDrawio(inflate(e.xml));
      expect(d.nodes).toHaveLength(1);
      const legend = /\((new|modify|retire)\)$/.exec(e.title)?.[1];
      expect(d.nodes[0]!.legend, e.title).toBe(legend);
      expect(d.nodes[0]!.label).toBe(e.title.replace(/ \(.*\)$/, ""));
      expect(e.w).toBeGreaterThan(0);
    }
    const vendor = entries().find((e) => e.title === "Vendor")!;
    expect(inflate(vendor.xml)).toContain("shape=cloud");
  });
});

describe("modules a component builds on (ADR 0068)", () => {
  it("draws each uses as an edge inside the system's container view", () => {
    const comp = (id: string, uses?: string[]) => {
      const p = parseRecord({
        schemaVersion: 2,
        kind: "Component",
        id,
        status: "current",
        confidence: "verified",
        system: "ledger",
        type: "spring-boot",
        evidence: [
          {
            repo: "tide-ledger",
            commit: "0".repeat(40),
            extractor: "component@1.1.0",
            source: "config",
            path: `${id}/pom.xml`,
          },
        ],
        ...(uses ? { uses } : {}),
      });
      if (!p.ok) throw new Error(id);
      return p.record;
    };
    const v = containerView(
      [
        comp("ledger-api", ["ledger-core", "ledger-rules"]),
        comp("ledger-rules", ["ledger-core"]),
        comp("ledger-core"),
      ],
      "ledger",
    );
    expect(v.edges.map((e) => `${e.from} ${e.label} ${e.to}`)).toEqual([
      "ledger-api uses ledger-core",
      "ledger-api uses ledger-rules",
      "ledger-rules uses ledger-core",
    ]);
  });
});
