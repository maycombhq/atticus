import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanEstate } from "../src/index.js";

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
const T = 120_000;
const COMMIT = "a".repeat(40);

const fact = (o: Record<string, unknown>) =>
  JSON.stringify({
    repo: "forge-ledger",
    commit: COMMIT,
    verified: "line",
    by: "assistant",
    conf: "declared",
    ...o,
  });

async function scan(facts?: string, commit = COMMIT, more: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "atticus-scan-facts-"));
  if (facts !== undefined) {
    await mkdir(join(root, "facts"), { recursive: true });
    await writeFile(join(root, "facts", "forge-ledger.jsonl"), facts);
    for (const [repo, text] of Object.entries(more))
      await writeFile(join(root, "facts", `${repo}.jsonl`), text);
  }
  return scanEstate({
    root,
    orgPack: join(FORGE, "metarepo/org-pack"),
    repoDir: (id) => join(FORGE, "repos", id),
    repoState: async () => ({ commit, dirty: false }),
    cache: null,
    scannedAt: "2026-10-24T09:00:00Z",
    inputsDir: null,
  });
}

const ledgerEndpoints = (
  records: { kind: string; id: string; evidence: { repo?: string; by?: string }[] }[],
) =>
  records.filter((r) => r.kind === "Endpoint" && r.evidence.some((e) => e.repo === "forge-ledger"));

describe("a scan takes a repo's verified facts over its readers (ADR 0124 §3)", () => {
  it(
    "uses the assistant's facts for forge-ledger, keeps the readers as a cross-check note",
    async () => {
      const readers = await scan();
      const byReaders = ledgerEndpoints(readers.records);
      expect(byReaders.length).toBeGreaterThan(1);

      const facts = [
        fact({
          kind: "entry",
          id: "e-balance",
          entryType: "rest",
          method: "GET",
          path: "/accounts/{id}/balance",
          auth: "oauth2",
          cite: {
            file: "src/main/java/forge/ledger/LedgerEndpoints.java",
            line: 8,
            value: "/accounts/{id}/balance",
          },
        }),
      ].join("\n");
      const withFacts = await scan(facts);
      const eps = ledgerEndpoints(withFacts.records);
      expect(eps).toHaveLength(1);
      expect(eps[0]!.evidence.every((e) => e.by === "assistant")).toBe(true);
      const note = withFacts.notes.find((n) => n.startsWith("forge-ledger: read from its facts"));
      expect(note).toMatch(/readers found .*Endpoint/);
    },
    T,
  );

  it(
    "falls back to the readers, with a note, when the facts are of another commit",
    async () => {
      const facts = fact({
        kind: "entry",
        id: "e-balance",
        entryType: "rest",
        method: "GET",
        path: "/accounts/{id}/balance",
        cite: {
          file: "src/main/java/forge/ledger/LedgerEndpoints.java",
          line: 8,
          value: "/accounts/{id}/balance",
        },
      });
      const r = await scan(facts, "b".repeat(40));
      expect(ledgerEndpoints(r.records).length).toBeGreaterThan(1);
      expect(r.notes.join("\n")).toMatch(/forge-ledger: its facts are of commit a{7}/);
    },
    T,
  );

  it(
    "joins the calls of repos read from their facts to each other's entries (ADR 0124, C-join)",
    async () => {
      const ledger = fact({
        kind: "entry",
        id: "e-post",
        entryType: "grpc",
        path: "forge.ledger.v1.Ledger/Post",
        cite: { file: "src/main/proto/ledger.proto", line: 7, value: "Post" },
      });
      const job = JSON.stringify({
        kind: "call",
        id: "c-post",
        repo: "forge-reports-job",
        commit: COMMIT,
        callType: "grpc",
        path: "forge.ledger.v1.Ledger/Post",
        cite: { file: "src/main/java/forge/reports/LedgerClient.java", line: 12, value: "post" },
        verified: "line",
        by: "assistant",
        conf: "declared",
      });
      const r = await scan(ledger, COMMIT, { "forge-reports-job": job });
      const iface = r.records.find(
        (x) => x.kind === "Interface" && x.from === "reports-job" && x.to === "ledger-api",
      );
      expect(iface?.evidence.map((e) => `${e.repo}:${e.side}`)).toEqual([
        "forge-reports-job:caller",
        "forge-ledger:callee",
      ]);
      expect(r.records.some((x) => x.id === "unresolved.c-post")).toBe(false);
    },
    T,
  );
});
