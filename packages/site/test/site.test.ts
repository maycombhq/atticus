import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, type CatalogRecord } from "@maycombhq/core";
import { buildSite, systemGuide } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../fixtures");

/** The Forge catalog, plus a decision, an owner question and a restricted system. */
function forge(): CatalogRecord[] {
  const rows = parse(readFileSync(join(FIXTURES, "forge/expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[];
  const extra = [
    {
      kind: "Decision",
      id: "decision.limit-in-ledger",
      title: "Check the daily limit in Ledger",
      decision: "Ledger checks the limit inside the transfer transaction.",
      reason: "Ledger owns the balance and the entries.",
      links: { changes: ["add-transfer-limit"], interfaces: [], systems: ["ledger"] },
      decidedBy: "priya",
      date: "2026-10-01",
      evidence: [{ source: "manual", path: "catalog/curated/decision/limit.yaml" }],
    },
    {
      kind: "System",
      id: "fraud-lab",
      name: "Fraud lab",
      boundary: "internal",
      repos: [],
      accessGroup: "fraud-team",
      evidence: [{ source: "manual", path: "catalog/curated/system/fraud-lab.yaml" }],
    },
    {
      kind: "Interface",
      id: "if-33828b870dc80b3b",
      from: "ledger-api",
      to: "fraud-lab",
      via: "direct",
      normalizedPath: "POST /score",
      sync: "sync",
      evidence: [{ source: "manual", path: "catalog/curated/interface/if-ledger-fraud.yaml" }],
    },
  ];
  const out: CatalogRecord[] = [];
  for (const r of [...rows, ...extra]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", confidence: "verified", ...r });
    if (p.ok) out.push(p.record);
    else throw new Error(`${String(r.id)}: ${JSON.stringify(p.issues)}`);
  }
  return out;
}

describe("system guides", () => {
  it("writes Ledger's guide from the catalog: owner, components, interfaces, data, runtime, decisions", () => {
    const g = systemGuide(forge(), "ledger", {
      changes: [
        {
          id: "add-transfer-limit",
          title: "Add a daily transfer limit",
          state: "plan",
          systems: ["ledger", "portal"],
        },
      ],
    });
    const golden = join(HERE, "golden/ledger.md");
    // UPDATE_GOLDEN=1 rewrites the golden file; review the diff before committing it.
    if (process.env.UPDATE_GOLDEN) writeFileSync(golden, g.markdown);
    expect(g.markdown).toBe(readFileSync(golden, "utf8"));
  });

  it("says what is missing instead of leaving a section blank", () => {
    const g = systemGuide(forge(), "audit");
    expect(g.markdown).toContain("No owner recorded.");
    expect(g.markdown).toContain("No data stores in the catalog.");
    expect(g.gaps).toContain("owner");
  });

  it("refuses a system the catalog doesn't have", () => {
    expect(() => systemGuide(forge(), "atlantis")).toThrow(/no system atlantis/i);
  });
});

describe("the read-only catalog site", () => {
  it("writes an index, a page per open system and a search file, and leaves restricted systems out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-site-"));
    const r = await buildSite(forge(), dir, { title: "Forge catalog", builtAt: "2026-10-18" });
    expect(r.systems).toEqual(["audit", "ledger", "northwind-pay", "portal", "reports"]);
    expect(r.hidden).toEqual(["fraud-lab"]);
    const files = (await readdir(dir, { recursive: true })).map(String).sort();
    expect(files).toContain("index.html");
    expect(files).toContain("search.json");
    expect(files).toContain(join("systems", "ledger.html"));
    expect(files).not.toContain(join("systems", "fraud-lab.html"));
    const ledger = await readFile(join(dir, "systems/ledger.html"), "utf8");
    // A hidden system is never named, even from an open system's page.
    expect(ledger).not.toMatch(/fraud/i);
    expect(ledger).toContain("a system that isn't on this site");
    expect(ledger).toContain("Content-Security-Policy");
    const search = JSON.parse(await readFile(join(dir, "search.json"), "utf8")) as { id: string }[];
    expect(search.some((x) => /fraud/.test(x.id))).toBe(false);
    expect(search.some((x) => x.id === "ledger-api")).toBe(true);
  });

  it("escapes catalog text, so a record can't put markup on the page", async () => {
    const recs = forge();
    const sys = recs.find((x) => x.id === "ledger") as unknown as { name: string };
    sys.name = '<script>alert("x")</script>';
    const dir = await mkdtemp(join(tmpdir(), "atticus-site-"));
    await buildSite(recs, dir, { title: "Forge", builtAt: "2026-10-18" });
    const html = await readFile(join(dir, "systems/ledger.html"), "utf8");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});
