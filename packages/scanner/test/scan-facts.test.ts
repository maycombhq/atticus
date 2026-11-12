import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFacts } from "@maycombhq/core";
import { factsSnapshotWrites, scanEstate } from "../src/index.js";

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

/**
 * ADR 0195 (CS2): a repo's facts reach the catalog only from its facts snapshot, the slot a
 * successful `verify <repo> --write` takes (catalog/sources/facts/<repo>.jsonl and its meta);
 * the live facts file is the assistant's working file and the scan never reads it.
 */
async function snapshot(root: string, repo: string, text: string): Promise<void> {
  const p = parseFacts(text);
  if (!p.ok) throw new Error("bad facts in the test");
  const commit = p.facts[0]?.commit ?? COMMIT;
  for (const w of factsSnapshotWrites(root, repo, p.facts, { commit, contracts: null })) {
    await mkdir(dirname(w.path), { recursive: true });
    await writeFile(w.path, w.text!);
  }
}

async function scan(facts?: string, commit = COMMIT, more: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "atticus-scan-facts-"));
  if (facts !== undefined) {
    await snapshot(root, "forge-ledger", facts);
    for (const [repo, text] of Object.entries(more)) await snapshot(root, repo, text);
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
      expect(readers.basis?.["forge-ledger"]).toEqual({ from: "readers" });
      expect(withFacts.basis?.["forge-ledger"]).toEqual({ from: "facts", unread: [] });
      const eps = ledgerEndpoints(withFacts.records);
      expect(eps).toHaveLength(1);
      expect(eps[0]!.evidence.every((e) => e.by === "assistant")).toBe(true);
      // The readers are kept beside the facts as the cross-check (CS3 lists what they found).
      const note = withFacts.notes.find((n) => n.startsWith("forge-ledger: read from its facts"));
      expect(note).toMatch(/facts snapshot/);
      // The scan still read the repo in full: its readers slot holds what the readers found.
      const obs = withFacts.observations.find((o) => o.repo === "forge-ledger");
      expect(
        obs?.full && obs.slot.records.filter((r) => r.kind === "Endpoint").length,
      ).toBeGreaterThanOrEqual(byReaders.length);
    },
    T,
  );

  it(
    "takes a facts snapshot of an earlier commit as it is: facts behind HEAD still win, and the live facts file isn't read (ADR 0195 point 2.1)",
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
      // The checkout is at another commit than the snapshot: beta.26 fell back to the readers or
      // carried the facts; the owner's decision (2026-11-11) keeps the facts as the source.
      const r = await scan(facts, "b".repeat(40));
      expect(r.basis?.["forge-ledger"]).toEqual({ from: "facts", unread: [] });
      expect(ledgerEndpoints(r.records)).toHaveLength(1);

      // A live facts file alone (no snapshot) is the assistant's work in progress: not read.
      const root = await mkdtemp(join(tmpdir(), "atticus-scan-facts-"));
      await mkdir(join(root, "facts"), { recursive: true });
      await writeFile(join(root, "facts", "forge-ledger.jsonl"), facts);
      const live = await scanEstate({
        root,
        orgPack: join(FORGE, "metarepo/org-pack"),
        repoDir: (id) => join(FORGE, "repos", id),
        repoState: async () => ({ commit: COMMIT, dirty: false }),
        cache: null,
        scannedAt: "2026-10-24T09:00:00Z",
        inputsDir: null,
      });
      expect(live.basis?.["forge-ledger"]).toEqual({ from: "readers" });
      expect(ledgerEndpoints(live.records).length).toBeGreaterThan(1);
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
