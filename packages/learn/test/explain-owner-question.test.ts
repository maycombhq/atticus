import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parse } from "yaml";
import {
  loadOrgPack,
  orgPackDirOf,
  parseRecord,
  recordPath,
  serializeRecord,
  type CatalogRecord,
} from "@maycombhq/core";
import { knowledgeGaps } from "@maycombhq/knowledge";
import { explain } from "../src/index.js";

/**
 * Beta.27 review, final round: a gap's owner question stays on record once it is sent; after the
 * gap is filled, explain says the gap is closed instead of "was asked (sent)". Reads only.
 * Invented Forge names; files only, no network.
 */

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
const ID = "q.unattended-workload-monitored.reports-job";
let root: string;

async function write(dir: string, r: Record<string, unknown>) {
  const p = parseRecord(r);
  if (!p.ok) throw new Error(JSON.stringify(p.issues));
  const f = join(root, "catalog", dir, recordPath(p.record));
  await mkdir(dirname(f), { recursive: true });
  await writeFile(f, serializeRecord(p.record));
  return p.record;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-explain-oq-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  const records: CatalogRecord[] = [];
  for (const row of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[])
    records.push(await write("generated", { schemaVersion: 2, status: "current", ...row }));
  const orgPack = await loadOrgPack(orgPackDirOf(root));
  const g = knowledgeGaps({ records, orgPack }).find((x) => x.question.id === ID)!;
  // Sent: the question's own record says so, as the send route writes it.
  await write("curated", {
    ...g.question,
    confidence: "asserted",
    evidence: [{ source: "manual", by: "pat", scannedAt: "2026-11-09T09:00:00Z" }],
  });
});
afterAll(async () => rm(root, { recursive: true, force: true }));

it("says a sent gap's question is asked while the gap is open, and closed once it is filled", async () => {
  const open = await explain(root, ID);
  expect(open.lines[0]).toMatch(/was asked \(sent\): Which alert or dashboard watches reports-job/);
  await write("generated", {
    schemaVersion: 2,
    kind: "ObservabilityAsset",
    id: "reports-job.failed-alert",
    status: "current",
    confidence: "verified",
    component: "reports-job",
    assetKind: "alert",
    name: "reports-job failed",
    evidence: [{ source: "config", repo: "forge-reports-job", path: "alerts.yaml", line: 1 }],
  });
  const closed = await explain(root, ID);
  expect(closed.lines.join("\n")).not.toMatch(/\(sent\)/);
  expect(closed.lines).toContain(
    "The knowledge gap it asked about is closed now (the fact is in the catalog), so it waits on no answer.",
  );
});
