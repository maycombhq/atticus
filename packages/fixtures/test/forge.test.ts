import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ChecklistPack, Dialect, loadOrgPack, parseRecord, type CatalogRecord } from "@maycombhq/core";
import { loadRepos } from "@maycombhq/workspace";
import { readdirSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const rawScan = parse(read("expected/scan.yaml")) as Record<string, unknown>[];
const inputs = parse(read("expected/inputs.yaml")) as {
  diagramEdges: { cell: string; from: string; to: string; pattern: string | null }[];
  aliases: Record<string, string | null>;
  patterns: string[];
};
const discrepancies = parse(read("expected/discrepancies.yaml")) as {
  id: string;
  found_by: string;
  refs: string[];
}[];

const records: CatalogRecord[] = rawScan.map((r) => {
  const result = parseRecord({ schemaVersion: 1, status: "current", ...r });
  if (!result.ok) throw new Error(`${String(r.id)}: ${JSON.stringify(result.issues)}`);
  return result.record;
});
const byId = new Map(records.map((r) => [r.id, r]));

describe("Forge expected catalog", () => {
  it("is valid against contract C1", () => {
    expect(records.length).toBeGreaterThan(40);
  });

  it("has unique ids", () => {
    expect(byId.size).toBe(records.length);
  });

  it("covers the main record kinds a scan produces", () => {
    const kinds = new Set(records.map((r) => r.kind));
    for (const k of [
      "System", "Component", "Endpoint", "Interface", "GatewayRoute", "DataStore", "Table",
      "Column", "IndexConstraint", "Migration", "Deployment", "Setting", "ObservabilityAsset",
      "AccessGrant",
    ]) {
      expect(kinds.has(k as CatalogRecord["kind"]), k).toBe(true);
    }
  });

  it("has every reference pointing at a record that exists", () => {
    const missing: string[] = [];
    const need = (from: string, ref: string | undefined) => {
      if (ref && !byId.has(ref)) missing.push(`${from} -> ${ref}`);
    };
    for (const r of records) {
      switch (r.kind) {
        case "Component": need(r.id, r.system); break;
        case "Endpoint": need(r.id, r.component); break;
        case "Interface": need(r.id, r.from); need(r.id, r.to); need(r.id, r.endpoint); need(r.id, r.route); break;
        case "Table": need(r.id, r.dataStore); need(r.id, r.ownerComponent); r.readers.forEach((x) => need(r.id, x)); r.writers.forEach((x) => need(r.id, x)); break;
        case "Column": need(r.id, r.table); break;
        case "IndexConstraint": need(r.id, r.table); need(r.id, r.references?.table); break;
        case "Migration": need(r.id, r.dataStore); break;
        case "DataStore": need(r.id, r.ownerComponent); break;
        case "Deployment": case "ObservabilityAsset": need(r.id, r.component); break;
        case "Setting": need(r.id, r.component); need(r.id, r.target); break;
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
        if (!existsSync(join(ROOT, rel))) {
          problems.push(`${r.id}: missing ${rel}`);
          continue;
        }
        if (e.line) {
          const lines = read(rel).split("\n");
          if (e.line > lines.length || (lines[e.line - 1] ?? "").trim() === "") {
            problems.push(`${r.id}: ${rel}:${e.line} is empty or past the end`);
          }
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
});

describe("Forge inputs and seeded problems", () => {
  it("lists exactly the diagram's edges", () => {
    const xml = read("inputs/diagrams/forge-context.drawio");
    const cells = [...xml.matchAll(/<mxCell id="([^"]+)" value="([^"]*)"[^>]*edge="1"/g)];
    expect(cells.map((c) => c[1])).toEqual(inputs.diagramEdges.map((e) => e.cell));
    for (const [, cell, label] of cells) {
      const edge = inputs.diagramEdges.find((e) => e.cell === cell)!;
      expect(label?.split(" ")[0] || null, cell).toBe(edge.pattern);
    }
  });

  it("aliases every diagram box to a catalog id or marks it planned", () => {
    for (const [name, id] of Object.entries(inputs.aliases)) {
      if (id !== null) expect(byId.has(id), name).toBe(true);
    }
    for (const e of inputs.diagramEdges) {
      expect(e.from in inputs.aliases, e.from).toBe(true);
      expect(e.to in inputs.aliases, e.to).toBe(true);
    }
  });

  it("has every listed pattern code in the patterns wiki page", () => {
    const wiki = read("inputs/wiki/integration-patterns.md");
    for (const code of inputs.patterns) expect(wiki).toContain(`| ${code} |`);
  });

  it("seeds a typo that is not a real pattern code", () => {
    const codes = inputs.diagramEdges.map((e) => e.pattern).filter(Boolean);
    expect(codes).toContain("S.GW.SRO");
    expect(inputs.patterns).not.toContain("S.GW.SRO");
  });

  it("has thirteen discrepancies whose refs all exist", () => {
    expect(discrepancies).toHaveLength(13);
    expect(new Set(discrepancies.map((d) => d.id)).size).toBe(13);
    for (const d of discrepancies) for (const ref of d.refs) expect(byId.has(ref), `${d.id} -> ${ref}`).toBe(true);
    const finders = new Set(discrepancies.map((d) => d.found_by));
    for (const f of ["reconcile", "critic", "knowledge-gap", "intake"]) expect(finders.has(f), f).toBe(true);
  });

  it("keeps fixture documents byte-exact", () => {
    const sha = (p: string) => createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex");
    expect(sha("inputs/wiki/integration-patterns.md")).toBe(
      "8640d6505090101c35a71a3e11a9b42b8db8989bcffb2983a1977003d4912eb6",
    );
    expect(sha("inputs/diagrams/forge-context.drawio")).toBe(
      "19afb74146568c497c0151388d7ab8d07713187feb99d6d0cf93f4185ae1ecbf",
    );
  });
});

describe("Forge repo manifest", () => {
  it("lists exactly the fixture repos, with systems and components that match the catalog", async () => {
    const repos = await loadRepos(join(ROOT, "metarepo"));
    expect(repos.map((r) => r.id).sort()).toEqual(readdirSync(join(ROOT, "repos")).sort());
    for (const r of repos) {
      if (r.system) expect(byId.get(r.system)?.kind, r.id).toBe("System");
    }
    const ids = new Set(repos.map((r) => r.id));
    for (const rec of records) {
      if (rec.kind === "Component" && rec.repo) expect(ids.has(rec.repo), rec.id).toBe(true);
    }
  });
});

describe("Forge org pack samples (C2, C3)", () => {
  const orgPack = (p: string) => parse(read(join("metarepo/org-pack", p)));

  it("the Forge dialect is a valid C2 file whose test expectations match the expected catalog", () => {
    const d = Dialect.parse(orgPack("dialects/forge.yaml"));
    for (const t of d.tests) {
      if (t.fixture) expect(existsSync(join(ROOT, "metarepo/org-pack/dialects", t.fixture)), t.fixture).toBe(true);
      for (const want of t.expect) {
        const got = byId.get(want.id) as Record<string, unknown> | undefined;
        expect(got?.kind, want.id).toBe(want.kind);
        for (const [k, v] of Object.entries(want)) expect(got?.[k], `${want.id}.${k}`).toEqual(v);
      }
      for (const id of t.absent) expect(byId.has(id), id).toBe(false);
    }
  });

  it("the architecture checklist is a valid C3 pack and its rules name real seeded problems", () => {
    const pack = ChecklistPack.parse(orgPack("checklists/architecture.yaml"));
    const seeded = new Set(discrepancies.map((d) => d.id.split("-")[0]));
    for (const r of pack.rules) {
      for (const m of (r.description ?? "").matchAll(/\b(d\d\d)\b/g)) expect(seeded.has(m[1]!), `${r.id} -> ${m[1]}`).toBe(true);
    }
    const ruleIds = pack.rules.map((r) => r.id);
    expect(ruleIds).toContain("vendor-calls-through-gateway");
    expect(pack.rules.filter((r) => r.needs.length > 0).length).toBeGreaterThanOrEqual(3);
  });
});

describe("Forge org pack (C6)", () => {
  it("loads with no problems, defaulting only the files it leaves out", async () => {
    const op = await loadOrgPack(join(ROOT, "metarepo/org-pack"));
    expect(op.problems).toEqual([]);
    expect(op.defaulted).toEqual(["change-types.yaml", "test-strategy.yaml"]);
    expect(op.dialects.map((d) => d.name)).toEqual(["forge"]);
    expect(op.checklists.map((c) => c.name)).toEqual(["forge-architecture"]);
    expect(op.skills.map((s) => s.id)).toEqual(["add-forge-endpoint"]);
    expect(op.serviceRequests.map((s) => s.id).sort()).toEqual(["firewall-rule", "gateway-route"]);
    expect(op.agents.map((a) => a.id).sort()).toEqual(["architecture-critic", "story-writer"]);
  });

  it("has exactly the pattern codes of the patterns wiki page", async () => {
    const op = await loadOrgPack(join(ROOT, "metarepo/org-pack"));
    expect(op.patterns.map((p) => p.code).sort()).toEqual([...inputs.patterns].sort());
  });

  it("names every diagram box as a system or alias in the profile", async () => {
    const op = await loadOrgPack(join(ROOT, "metarepo/org-pack"));
    const profile = op.profiles.find((p) => p.platform === "forge")!.profile!;
    const names = new Set(profile.systems.flatMap((s) => [s.name, ...s.aliases]).map((n) => n.toLowerCase()));
    for (const [box, id] of Object.entries(inputs.aliases)) {
      if (id === null) continue; // planned, not in the catalog yet
      const system = byId.get(id)?.kind === "System" ? id : (byId.get(id) as { system?: string } | undefined)?.system;
      expect(names.has(box.toLowerCase()) || profile.systems.some((s) => s.id === system), box).toBe(true);
    }
  });
});
