import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadOrgPack, mergeCatalog, parseRecord, type CatalogRecord } from "@maycombhq/core";
import { scanEstate } from "@maycombhq/scanner";
import { scanInputs } from "../src/index.js";

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
const ORG_PACK = join(FORGE, "metarepo/org-pack");
const T = 120_000;
type Row = Record<string, unknown> & { kind: string; id: string };
const expected = (
  parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<string, unknown>[]
).map((r) => {
  const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
  if (!p.ok) throw new Error(String(r.id));
  return p.record as unknown as Row;
});
const evKey = (e: Record<string, unknown>) =>
  `${e.repo ?? ""}:${e.path ?? ""}:${e.line ?? ""}:${e.side ?? ""}`;

/** Field-for-field comparison, evidence as a set of (repo, path, line, side). */
function compare(actual: CatalogRecord[]) {
  const kinds = new Set(expected.map((e) => e.kind));
  const act = new Map(
    (actual as unknown as Row[])
      .filter((r) => kinds.has(r.kind))
      .map((r) => [`${r.kind}/${r.id}`, r]),
  );
  const out = {
    missing: [] as string[],
    extra: [] as string[],
    fields: [] as string[],
    evidence: [] as string[],
  };
  for (const e of expected) {
    const k = `${e.kind}/${e.id}`;
    const a = act.get(k);
    act.delete(k);
    if (!a) {
      out.missing.push(k);
      continue;
    }
    for (const f of [...new Set([...Object.keys(e), ...Object.keys(a)])].sort())
      if (f !== "evidence" && JSON.stringify(a[f]) !== JSON.stringify(e[f]))
        out.fields.push(`${k}.${f}: expected ${JSON.stringify(e[f])}, got ${JSON.stringify(a[f])}`);
    const ea = new Set((a.evidence as Record<string, unknown>[]).map(evKey));
    const ee = new Set((e.evidence as Record<string, unknown>[]).map(evKey));
    const lacking = [...ee].filter((x) => !ea.has(x));
    const surplus = [...ea].filter((x) => !ee.has(x));
    if (lacking.length + surplus.length > 0)
      out.evidence.push(`${k}: missing [${lacking.join(", ")}] extra [${surplus.join(", ")}]`);
  }
  out.extra = [...act.keys()];
  return out;
}

async function forge() {
  const root = await mkdtemp(join(tmpdir(), "atticus-intake-forge-"));
  const scan = await scanEstate({
    root,
    orgPack: ORG_PACK,
    repoDir: (id) => join(FORGE, "repos", id),
    repoState: async () => ({ commit: "a".repeat(40), dirty: false }),
    cache: null,
    scannedAt: "2026-10-18T09:00:00Z",
  });
  const inputs = await scanInputs({
    root: join(FORGE, "metarepo"),
    orgPack: ORG_PACK,
    inputsDir: join(FORGE, "inputs"),
    records: scan.records,
    scannedAt: "2026-10-18T09:00:00Z",
  });
  // What scanEstate does at the end, with intake's records after the scan's (code first, so a
  // document can never overwrite a fact read from code). See the report for the one-line change.
  const op = await loadOrgPack(ORG_PACK);
  const merged = mergeCatalog({
    records: [...scan.repos.flatMap((r) => r.records), ...inputs.records],
    repos: op.profiles.flatMap((p) =>
      (p.repos?.repos ?? []).map((r) => ({
        id: r.id,
        type: r.type,
        ...(r.component ? { component: r.component } : {}),
        ...(r.system ? { system: r.system } : {}),
      })),
    ),
    systems: op.profiles.flatMap((p) => p.profile?.systems ?? []),
    patterns: op.patterns,
    profilePath: "org-pack/profiles/forge/profile.yaml",
  });
  return { scan, inputs, merged };
}

describe("the Forge partner spec, taken in", () => {
  it(
    "reads every input but the wiki, which another reader owns",
    async () => {
      const { inputs } = await forge();
      expect(inputs.problems).toEqual([]);
      expect(inputs.documents.map((d) => [d.path, d.classification, d.status, d.systems])).toEqual([
        [
          "inputs/diagrams/forge-context.drawio",
          "diagram",
          "read",
          ["ledger", "northwind-pay", "portal", "reports"],
        ],
        ["inputs/partner-specs/northwind-pay-openapi.yaml", "openapi", "read", ["northwind-pay"]],
        ["inputs/tickets/ado-stories.json", "ticket-export", "no-reader", []],
        ["inputs/tickets/closed-service-requests.json", "ticket-export", "no-reader", []],
      ]);
      expect(inputs.triage).toEqual([]);
    },
    T,
  );

  it(
    "closes the M1 gap: the vendor endpoint, the verified vendor call and the verified vendor system",
    async () => {
      const { merged } = await forge();
      expect(merged.invalid).toEqual([]);
      const c = compare(merged.records);
      expect(c.missing).toEqual([]);
      expect(c.extra).toEqual([]);
      expect(c.fields).toEqual([]);
      // Systems and components carry the first file that shows them (ADR 0017); everything else
      // must match exactly. The vendor system also keeps the profile as evidence (see report).
      expect(
        c.evidence.filter((d) => !d.startsWith("System/") && !d.startsWith("Component/")),
      ).toEqual([]);

      const byId = (kind: string, id: string) =>
        merged.records.find((r) => r.kind === kind && r.id === id) as unknown as Row;
      const want = (kind: string, id: string) =>
        expected.find((e) => e.kind === kind && e.id === id)!;
      expect(byId("Endpoint", "northwind-pay.post-payment")).toEqual({
        ...want("Endpoint", "northwind-pay.post-payment"),
        evidence: [
          {
            source: "spec",
            path: "inputs/partner-specs/northwind-pay-openapi.yaml",
            line: 6,
            side: "definition",
          },
        ],
      });
      const vendorCall = byId("Interface", "if-e7344c9455608119");
      expect(vendorCall.confidence).toBe("verified");
      expect(vendorCall.endpoint).toBe("northwind-pay.post-payment");
      expect(vendorCall.evidence).toContainEqual({
        source: "spec",
        path: "inputs/partner-specs/northwind-pay-openapi.yaml",
        line: 6,
        side: "callee",
      });
      const { evidence: _e, ...vendorSystem } = byId("System", "northwind-pay");
      const { evidence: _w, ...wantSystem } = want("System", "northwind-pay");
      expect(vendorSystem).toEqual(wantSystem);
      expect(byId("System", "northwind-pay").evidence).toContainEqual({
        source: "spec",
        path: "inputs/partner-specs/northwind-pay-openapi.yaml",
        side: "definition",
      });
    },
    T,
  );
});
