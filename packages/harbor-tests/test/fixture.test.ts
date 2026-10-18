import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ChecklistPack, Dialect, loadOrgPack, parseRecord } from "@maycombhq/core";
import { runDialectTests } from "@maycombhq/extractors";
import { loadRepos } from "@maycombhq/workspace";
import {
  expectedFile,
  expectedRows,
  HARBOR,
  HARBOR_ROOT,
  harborRecords,
  newVocabulary,
  ORG_PACK,
  read,
  type Discrepancy,
  type ExpectedInputs,
} from "./harbor.js";

/**
 * Stage 0: the Harbor fixture itself. The expected files must hold together before any stage
 * is measured against them: valid records, references that exist, evidence pointing at real
 * lines, a loadable org pack, a dialect whose tests pass, and seeded problems that name real
 * records.
 */

const rows = expectedRows();
const records = harborRecords();
const byId = new Map(records.map((r) => [r.id, r]));
const inputs = expectedFile<ExpectedInputs>("inputs.yaml");
const discrepancies = expectedFile<Discrepancy[]>("discrepancies.yaml");

describe("Harbor expected catalog", () => {
  it("is valid against contract C1, apart from the ADR 0040 values main's schema lacks", () => {
    const usingNew = rows.filter((r) => newVocabulary(r).length > 0).map((r) => r.id);
    for (const r of rows) {
      if (usingNew.includes(r.id)) continue;
      const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
      expect(p.ok, `${r.id}: ${p.ok ? "" : JSON.stringify(p.issues)}`).toBe(true);
    }
    // 7 GraphQL, webhook and function endpoints, 7 mesh and webhook interfaces, 2 schedules
    // and 2 deployments with ingress.
    expect(usingNew).toHaveLength(18);
  });

  // The ADR 0040 values in C1 (endpointType graphql/webhook/function, via mesh/webhook,
  // settingKind schedule, Deployment.ingress) are in schema version 2.
  it("is valid against contract C1, every record (ADR 0040 schema)", () => {
    for (const r of rows) {
      const p = parseRecord({ schemaVersion: 2, status: "current", ...r });
      expect(p.ok, `${r.id}: ${p.ok ? "" : JSON.stringify(p.issues)}`).toBe(true);
    }
  });

  it("has unique ids", () => {
    expect(byId.size).toBe(records.length);
  });

  it("uses the ADR 0040 component types and store types", () => {
    const types = new Set(records.flatMap((r) => (r.kind === "Component" ? [r.type] : [])));
    for (const t of [
      "spa",
      "mobile-app",
      "bff",
      "service",
      "function",
      "data-pipeline",
      "ml-model",
    ])
      expect(types.has(t), t).toBe(true);
    const stores = new Set(records.flatMap((r) => (r.kind === "DataStore" ? [r.storeType] : [])));
    for (const s of ["postgresql", "warehouse", "feature-store", "object-storage", "queue"])
      expect(stores.has(s), s).toBe(true);
  });

  it("has every reference pointing at a record that exists", () => {
    const missing: string[] = [];
    const need = (from: string, ref: string | undefined) => {
      if (ref && !byId.has(ref)) missing.push(`${from} -> ${ref}`);
    };
    for (const r of records) {
      switch (r.kind) {
        case "Component":
          need(r.id, r.system);
          break;
        case "Endpoint":
          need(r.id, r.component);
          break;
        case "Interface":
          need(r.id, r.from);
          need(r.id, r.to);
          need(r.id, r.endpoint);
          break;
        case "Table":
          need(r.id, r.dataStore);
          need(r.id, r.ownerComponent);
          r.readers.forEach((x) => need(r.id, x));
          r.writers.forEach((x) => need(r.id, x));
          break;
        case "Column":
          need(r.id, r.table);
          break;
        case "IndexConstraint":
          need(r.id, r.table);
          need(r.id, r.references?.table);
          break;
        case "Migration":
          need(r.id, r.dataStore);
          break;
        case "DataStore":
          need(r.id, r.ownerComponent);
          break;
        case "Deployment":
        case "ObservabilityAsset":
        case "QualityAsset":
          need(r.id, r.component);
          break;
        case "Setting":
          need(r.id, r.component);
          need(r.id, r.target);
          break;
      }
    }
    expect(missing).toEqual([]);
  });

  it("has evidence pointing at real files and lines", () => {
    const problems: string[] = [];
    for (const r of records) {
      for (const e of r.evidence) {
        if (!e.path) continue;
        const rel = e.repo ? join("repos", e.repo, e.path) : e.path;
        const abs = rel.startsWith("org-pack/") ? join(HARBOR_ROOT, rel) : join(HARBOR, rel);
        if (!existsSync(abs)) {
          problems.push(`${r.id}: missing ${rel}`);
          continue;
        }
        if (e.line) {
          const lines = readFileSync(abs, "utf8").split("\n");
          if (e.line > lines.length || (lines[e.line - 1] ?? "").trim() === "")
            problems.push(`${r.id}: ${rel}:${e.line} is empty or past the end`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("marks an interface verified only when both ends are seen", () => {
    for (const r of records) {
      if (r.kind !== "Interface") continue;
      const sides = new Set(r.evidence.map((e) => e.side));
      const bothEnds = sides.has("caller") && (sides.has("callee") || sides.has("definition"));
      expect(r.confidence === "verified", r.id).toBe(bothEnds);
    }
  });

  it("covers what makes Harbor unlike Forge: no gateway routes, mesh, GraphQL, gRPC, webhooks", () => {
    expect(records.some((r) => r.kind === "GatewayRoute")).toBe(false);
    const vias = new Set(records.flatMap((r) => (r.kind === "Interface" ? [r.via] : [])));
    expect([...vias].sort()).toEqual(["direct", "event-bus", "mesh", "webhook"]);
    const types = new Set(records.flatMap((r) => (r.kind === "Endpoint" ? [r.endpointType] : [])));
    expect([...types].sort()).toEqual([
      "event-topic",
      "function",
      "graphql",
      "grpc",
      "rest",
      "webhook",
    ]);
  });
});

describe("Harbor repos and org pack", () => {
  it("lists exactly the fixture repos, with systems and components that match the catalog", async () => {
    const repos = await loadRepos(HARBOR_ROOT);
    expect(repos.map((r) => r.id).sort()).toEqual(readdirSync(join(HARBOR, "repos")).sort());
    expect(repos).toHaveLength(11);
    for (const r of repos) if (r.system) expect(byId.get(r.system)?.kind, r.id).toBe("System");
    const ids = new Set(repos.map((r) => r.id));
    for (const rec of records)
      if (rec.kind === "Component" && rec.repo) expect(ids.has(rec.repo), rec.id).toBe(true);
  });

  it("loads with no problems, defaulting only the files it leaves out", async () => {
    const op = await loadOrgPack(ORG_PACK);
    expect(op.problems).toEqual([]);
    expect(op.defaulted).toEqual(["change-types.yaml", "test-strategy.yaml"]);
    expect(op.dialects.map((d) => d.name)).toEqual(["harbor-outbox"]);
    expect(op.checklists.map((c) => c.name)).toEqual(["harbor-architecture"]);
    expect(op.runtime.adapters.workTracker?.type).toBe("manual");
    expect(op.runtime.adapters.gitHost?.type).toBe("github");
  });

  it("has exactly the pattern codes of the patterns wiki page", async () => {
    const op = await loadOrgPack(ORG_PACK);
    expect(op.patterns.map((p) => p.code).sort()).toEqual([...inputs.patterns].sort());
    const wiki = read("inputs/wiki/integration-patterns.md");
    for (const code of inputs.patterns) expect(wiki).toContain(`| ${code} |`);
  });

  it("the harbor-outbox dialect is a valid C2 file whose tests pass", async () => {
    const d = Dialect.parse(parse(read("metarepo/org-pack/dialects/harbor-outbox.yaml")));
    expect(await runDialectTests(d, join(ORG_PACK, "dialects"))).toEqual([]);
  });

  it("the architecture checklist is a valid C3 pack whose rules name real seeded problems", () => {
    const pack = ChecklistPack.parse(parse(read("metarepo/org-pack/checklists/architecture.yaml")));
    const seeded = new Set(discrepancies.map((d) => d.id.split("-")[0]));
    for (const r of pack.rules)
      for (const m of (r.description ?? "").matchAll(/\b(h\d\d)\b/g))
        expect(seeded.has(m[1]!), `${r.id} -> ${m[1]}`).toBe(true);
  });

  it("names every diagram box that is in the catalog through an id or the profile", async () => {
    const op = await loadOrgPack(ORG_PACK);
    const profile = op.profiles.find((p) => p.platform === "harbor")!.profile!;
    const names = new Set(
      profile.systems.flatMap((s) => [s.name, ...s.aliases]).map((n) => n.toLowerCase()),
    );
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    for (const [box, id] of Object.entries(inputs.aliases)) {
      if (id === null) continue;
      expect(slug(box) === id || names.has(box.toLowerCase()), box).toBe(true);
      expect(byId.has(id), `${box} -> ${id}`).toBe(true);
    }
  });
});

describe("Harbor seeded problems", () => {
  it("has at least twelve discrepancies across every finder, whose refs all exist", () => {
    expect(discrepancies.length).toBeGreaterThanOrEqual(12);
    expect(new Set(discrepancies.map((d) => d.id)).size).toBe(discrepancies.length);
    for (const d of discrepancies)
      for (const ref of d.refs) expect(byId.has(ref), `${d.id} -> ${ref}`).toBe(true);
    const finders = new Set(discrepancies.map((d) => d.found_by));
    for (const f of ["reconcile", "critic", "knowledge-gap", "intake"])
      expect(finders.has(f as Discrepancy["found_by"]), f).toBe(true);
  });

  it("seeds a typo that is not a real pattern code", () => {
    const codes = inputs.diagrams.flatMap((d) => d.edges.map((e) => e.pattern)).filter(Boolean);
    expect(codes).toContain("HB.ASYNC.EVNT");
    expect(inputs.patterns).not.toContain("HB.ASYNC.EVNT");
  });

  it("lists every aliased diagram end", () => {
    for (const d of inputs.diagrams)
      for (const e of d.edges) {
        expect(e.from in inputs.aliases, e.from).toBe(true);
        expect(e.to in inputs.aliases, e.to).toBe(true);
      }
  });

  it("keeps the documents the expected files cite by line byte-exact", () => {
    const sha = (p: string) =>
      createHash("sha256")
        .update(readFileSync(join(HARBOR, p)))
        .digest("hex");
    expect(sha("inputs/wiki/checkout-solution-spec.md")).toBe(
      "acba0aa7717b7e1a99e603f764a90fc4565c0efaf7f18e8d91da302b4e92d947",
    );
    expect(sha("inputs/wiki/integration-patterns.md")).toBe(
      "120a5c19668160f0cbda5459e228bef9052d39c82a66ba170a937112cb9c19ab",
    );
    expect(sha("inputs/diagrams/harbor-architecture.mmd")).toBe(
      "c13c22d854d1e9f659fdc5192eac9f0daec57c29659cc9922ed7e2d8552bff19",
    );
    expect(sha("inputs/diagrams/harbor-data-platform.drawio")).toBe(
      "089ae84e7216f1c3a2cbe65448bdabb9179c8dc4471af6367fb8a5d311564384",
    );
  });
});
