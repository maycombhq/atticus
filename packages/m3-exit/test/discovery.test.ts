import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  atticus,
  FORGE,
  forgeEstate,
  readYaml,
  removeTop,
  T,
  walk,
  type Estate,
} from "./helpers.js";

/**
 * M3 exit, step 1: a team points Atticus at the Forge estate and learns what it has. Everything
 * goes through the CLI entry point: workspace sync clones the repos from local bare remotes,
 * scan builds the catalog, then reconcile, questions and sources sync find the seeded
 * discrepancies of fixtures/forge/expected/discrepancies.yaml (d01-d06, d09-d12).
 */

let e: Estate;
beforeAll(async () => {
  e = await forgeEstate();
}, T);
afterAll(() => removeTop(e));

describe("M3 exit step 1: scan, reconcile, questions and sources", () => {
  it(
    "clones the seven repos and scans them into a catalog that holds the hand-written expected records",
    async () => {
      const sync = await atticus(e.root, "workspace", "sync");
      expect(sync.code).toBe(0);
      expect(sync.out.filter((l) => / cloned [0-9a-f]{12}$/.test(l))).toHaveLength(7);

      const scan = await atticus(e.root, "scan");
      expect(scan.err).toEqual([]);
      expect(scan.code).toBe(0);
      expect(scan.out[0]).toMatch(/^Scanned 7 repos in /);
      expect(scan.text).toMatch(/7 interfaces \(6 verified\), 0 loose ends/);

      const validate = await atticus(
        undefined,
        "catalog",
        "validate",
        join(e.root, "catalog/generated"),
      );
      expect(validate.code).toBe(0);

      const files = await walk(join(e.root, "catalog/generated"));
      const expected = await readYaml<{ kind: string; id: string }[]>(
        join(FORGE, "expected/scan.yaml"),
      );
      const missing = expected.filter(
        (r) => !files.includes(`${r.kind.toLowerCase()}/${r.id}.yaml`),
      );
      expect(missing.map((r) => `${r.kind}/${r.id}`)).toEqual([]);
    },
    T,
  );

  it(
    "reconcile finds d01-d06 between the draw.io diagram and the code",
    async () => {
      const r = await atticus(e.root, "reconcile");
      expect(r.code).toBe(1);
      expect(r.out[0]).toBe(
        "inputs/diagrams/forge-context.drawio: 7 edges, 5 matched to code, 7 items",
      );
      // d01: the vendor call is drawn through the gateway; code calls Northwind Pay directly.
      expect(r.text).toMatch(
        /pattern-mismatch \[e4\] .*S\.GW\.VND goes through the gateway, the code calls directly/,
      );
      // d02: Reports is drawn calling the Ledger API; code reads ledger-db.entry.
      expect(r.text).toMatch(
        /drawn-call-reads-database \[e5\] .*reports-job reads ledger-api's database directly \(ledger-db\.entry\)/,
      );
      // d03 and d04: two code-only edges.
      expect(r.text).toMatch(
        /code-only In code portal-bff calls audit-svc \(POST \/audit\/events\)/,
      );
      expect(r.text).toMatch(
        /code-only In code ledger-api publishes transfers\.completed to reports-job/,
      );
      // d05: the diagram-only edge marked New becomes a planned-new interface.
      expect(r.text).toMatch(/planned \[e7\] Edge Portal BFF → Notifications Service/);
      // d06: "Ledger Platform" needs an alias to ledger-api.
      expect(r.text).toMatch(/alias-needed \[ledger\] The diagram's "Ledger Platform"/);
    },
    T,
  );

  it(
    "questions finds the knowledge gaps d09-d11 and names who to ask",
    async () => {
      const r = await atticus(e.root, "questions");
      expect(r.code).toBe(1);
      // d09: no timeout or retry known for the Northwind client.
      expect(r.text).toMatch(/q\.call-resilience-known\.if-e7344c9455608119 → team-ledger/);
      // d10: reports-job has no alerts.
      expect(r.text).toMatch(/q\.unattended-workload-monitored\.reports-job → team-reports/);
      // d11: audit-svc is known only from a caller.
      expect(r.text).toMatch(/q\.component-source-known\.audit-svc → team-platform/);
      expect(r.out.at(-1)).toMatch(
        /open questions\. Unanswered questions stay unknowns; nothing is guessed\.$/,
      );
    },
    T,
  );

  it(
    "sources sync finds d12: the solution spec contradicts the code twice, and code wins",
    async () => {
      const r = await atticus(e.root, "sources", "sync", "--json");
      expect(r.code).toBe(1);
      const res = JSON.parse(r.out.join("\n")) as {
        documentConflicts: { record?: string; recordId?: string }[];
      };
      expect(res.documentConflicts).toHaveLength(2);
      const text = await atticus(e.root, "sources", "sync");
      expect(text.text).toMatch(/2 conflicts with code \(code wins; each goes to triage\)/);
      expect(text.text).toMatch(/interface if-e7344c9455608119 is via direct/);
      expect(text.text).toMatch(/reports-job reads table ledger-db\.entry directly/);
    },
    T,
  );
});
