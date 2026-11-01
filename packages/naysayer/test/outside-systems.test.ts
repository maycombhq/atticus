import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { runCritic, type CriticResult } from "../src/index.js";
import { CHANGE, NOW, forgeChangeRoot, write } from "./helpers.js";

/**
 * O2: the critic takes every system outside the estate, not only a vendor's. In the Forge
 * estate, Audit is a system the profile declares (boundary internal) that no repo of the
 * manifest belongs to: another team's. A call to it is checked against its published spec once
 * that spec is in the catalog (ADR 0142 reads another team's spec as a vendor's is); its owner
 * is still asked about its alerts, its gaps and how it authenticates, which stay vendor-only
 * skips on purpose.
 */

const spec = (r: CriticResult) =>
  r.findings.filter((f) => f.finding.summary.includes("published spec has no"));

async function withAuditSpec(path: string): Promise<string> {
  const root = await forgeChangeRoot();
  const p = parseRecord({
    schemaVersion: 1,
    status: "current",
    confidence: "verified",
    kind: "Endpoint",
    endpointType: "rest",
    id: "audit-svc.post-audit",
    component: "audit-svc",
    method: "POST",
    normalizedPath: path,
    pathOrTopic: path,
    evidence: [
      {
        source: "spec",
        repo: "forge-portal-bff",
        path: "inputs/partner-specs/audit-openapi.yaml",
        line: 4,
      },
    ],
  });
  if (!p.ok) throw new Error(JSON.stringify(p));
  await write(root, join("catalog/generated", recordPath(p.record)), serializeRecord(p.record));
  return root;
}

describe("O2: another team's system in the critic", () => {
  it("checks a call to it against its published spec, in its own words", async () => {
    const r = await runCritic(await withAuditSpec("/audit/records"), CHANGE, { now: NOW });
    const f = spec(r).filter((x) => x.finding.locator.record === "audit");
    expect(f.map((x) => x.finding.summary)).toEqual([
      "Audit's published spec has no POST /audit/events.",
    ]);
    expect(f[0]!.finding.why).toContain("another team's system");
    expect(f[0]!.finding.fix.text).toBe(
      "Get the operation's spec from the team that owns Audit and add it to inputs/partner-specs, or correct the operation.",
    );
  });

  it("says nothing when its spec has the operation, or when no spec of it is in the catalog yet", async () => {
    const has = await runCritic(await withAuditSpec("/audit/events"), CHANGE, { now: NOW });
    expect(spec(has).filter((x) => x.finding.locator.record === "audit")).toEqual([]);
    const none = await runCritic(await forgeChangeRoot(), CHANGE, { now: NOW });
    expect(spec(none).filter((x) => x.finding.locator.record === "audit")).toEqual([]);
  });

  it("still asks its owner about its alerts and how it authenticates (vendor-only skips)", async () => {
    const r = await runCritic(await forgeChangeRoot(), CHANGE, { now: NOW });
    const about = r.findings
      .filter(
        (f) => f.finding.locator.record === "audit-svc" || f.finding.summary.includes("audit-svc"),
      )
      .map((f) => f.finding.summary);
    expect(about.some((s) => /alert/i.test(s))).toBe(true);
    expect(about.some((s) => /authenticat/i.test(s))).toBe(true);
  });
});
