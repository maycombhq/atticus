import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  interfaceId,
  parseRecord,
  recordPath,
  serializeRecord,
  type CatalogRecord,
} from "@maycombhq/core";
import { scanEstate } from "../src/index.js";

/**
 * A federated metarepo's loose ends (calls and events it couldn't place in its own estate)
 * go through merge identity resolution against our records: a call to one of our endpoints
 * or a subscription to one of our topics becomes an interface, flagged with its origin. Local
 * code still wins: nothing we found changes, and what can't be placed stays a loose end.
 */

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
const T = 120_000;
const AT = "2026-10-18T09:00:00Z";
const CALLER = { source: "code", repo: "notify-api", path: "src/LedgerClient.java", line: 12 };
const SUB = { source: "code", repo: "notify-api", path: "src/TransferListener.java", line: 8 };
const ODD = { source: "code", repo: "notify-api", path: "src/Odd.java", line: 3 };

const theirs: Record<string, unknown>[] = [
  {
    kind: "Component",
    id: "notify-api",
    confidence: "verified",
    system: "notify",
    type: "service",
    evidence: [{ source: "config", repo: "notify-api", path: "pom.xml" }],
  },
  {
    kind: "Unresolved",
    id: "notify-api.http-call.0000000001",
    confidence: "inferred",
    unresolvedKind: "http-call",
    raw: "GET http://ledger-api/accounts/{id}/balance",
    owner: "notify-api",
    evidence: [{ ...CALLER, side: "caller" }],
  },
  {
    kind: "Unresolved",
    id: "notify-api.event-subscribe.0000000002",
    confidence: "inferred",
    unresolvedKind: "event-subscribe",
    raw: "transfers.completed",
    owner: "notify-api",
    evidence: [SUB],
  },
  {
    kind: "Unresolved",
    id: "notify-api.http-call.0000000003",
    confidence: "inferred",
    unresolvedKind: "http-call",
    raw: "POST http://nowhere-known/hooks",
    owner: "notify-api",
    evidence: [{ ...ODD, side: "caller" }],
  },
];

async function federatedMetarepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-fed-loose-"));
  await mkdir(join(dir, "org-pack"), { recursive: true });
  for (const r of theirs) {
    const p = parseRecord({ schemaVersion: 2, status: "current", ...r });
    if (!p.ok) throw new Error(`bad fixture record ${String(r.id)}: ${JSON.stringify(p.issues)}`);
    const f = join(dir, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  return dir;
}

const scan = async (federated: { id: string; dir: string }[]) =>
  scanEstate({
    root: await mkdtemp(join(tmpdir(), "atticus-fed-root-")),
    orgPack: join(FORGE, "metarepo/org-pack"),
    repoDir: (id) => join(FORGE, "repos", id),
    repoState: async () => ({ commit: "a".repeat(40), dirty: false }),
    cache: null,
    scannedAt: AT,
    inputsDir: join(FORGE, "inputs"),
    federated,
  });

const exportEv = (kind: string, id: string) => ({
  source: "export",
  repo: "notify",
  path: `catalog/generated/${kind}/${id}.yaml`,
});

describe("federated loose ends", () => {
  it(
    "resolve against local records into flagged interfaces, and local records stay as they were (golden)",
    async () => {
      const plain = await scan([]);
      const fed = await scan([{ id: "notify", dir: await federatedMetarepo() }]);
      expect(fed.problems).toEqual([]);
      const flagged = (r: CatalogRecord) => (r.flags ?? []).includes("federated:notify");

      // Local code wins: every record of ours is exactly what the scan without federation found.
      expect(fed.records.filter((r) => !flagged(r))).toEqual(plain.records);

      const get = (kind: string, id: string) =>
        fed.records.find((r) => r.kind === kind && r.id === id) as unknown as Record<
          string,
          unknown
        >;
      const call = interfaceId("notify-api", "ledger-api", "GET", "/accounts/{id}/balance");
      expect(get("Interface", call)).toMatchObject({
        from: "notify-api",
        to: "ledger-api",
        endpoint: "ledger-api.get-balance",
        via: "direct",
        method: "GET",
        normalizedPath: "/accounts/{}/balance",
        sync: "sync",
        confidence: "verified",
        flags: ["federated:notify"],
      });
      const callEv = get("Interface", call).evidence as Record<string, unknown>[];
      expect(callEv.slice(0, 2)).toEqual([
        { ...CALLER, side: "caller" },
        exportEv("unresolved", "notify-api.http-call.0000000001"),
      ]);
      expect(callEv.slice(2).every((e) => e.side === "callee" && e.repo === "forge-ledger")).toBe(
        true,
      );

      const event = interfaceId("ledger-api", "notify-api", undefined, "transfers.completed");
      expect(get("Interface", event)).toMatchObject({
        from: "ledger-api",
        to: "notify-api",
        endpoint: "topic.transfers-completed",
        via: "event-bus",
        sync: "async",
        flags: ["federated:notify"],
      });

      // The two placed loose ends are gone; the one nobody serves stays, with its origin.
      const loose = fed.records.filter((r) => r.kind === "Unresolved" && flagged(r));
      expect(loose.map((r) => r.id)).toEqual(["notify-api.http-call.0000000003"]);
      expect(fed.federated).toEqual([{ id: "notify", added: 4, shadowed: [], resolved: 2 }]);
    },
    T,
  );
});
