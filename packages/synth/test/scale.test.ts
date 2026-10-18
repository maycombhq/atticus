import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { RepoManifest, type CatalogRecord } from "@maycombhq/core";
import { defineExtractor, fsRepo, fsScanCache, scanRepo, type RepoScan } from "@maycombhq/sdk";
import { generateEstate, prng, writeEstate } from "../src/index.js";

/** Set ATTICUS_SYNTH_REPOS to try other sizes; CI uses the planned 300. */
const SIZE = Number(process.env.ATTICUS_SYNTH_REPOS ?? 300);
const T = 180_000;

/** A small stand-in for the M1 Forge dialect: endpoints and client calls from annotations. */
const forgeDemo = defineExtractor({
  id: "forge-demo",
  version: "0.1.0",
  claims: ["src/main/java/**/*.java", "forge.yaml"],
  async *scan(repo) {
    const service = await repo
      .readText("forge.yaml")
      .then((t) => /^service: (.+)$/m.exec(t)?.[1])
      .catch(() => undefined);
    for await (const path of repo.listFiles(["src/main/java/**/*.java"])) {
      const lines = (await repo.readText(path)).split("\n");
      for (const [i, line] of lines.entries()) {
        const ep = /@ForgeEndpoint\(method = "(\w+)", path = "([^"]+)"/.exec(line);
        if (ep && service) {
          const name = /public Object (\w+)/.exec(lines[i + 1] ?? "")?.[1] ?? `l${i + 1}`;
          yield {
            schemaVersion: 1,
            kind: "Endpoint",
            id: `${service}.${ep[1]!.toLowerCase()}-${name}`,
            status: "current",
            confidence: "verified",
            component: service,
            endpointType: "rest",
            method: ep[1]!,
            pathOrTopic: ep[2]!,
            schemaRefs: [],
            evidence: [{ source: "code", path, line: i + 1, side: "callee" }],
          } as unknown as CatalogRecord;
        }
        const call = /@ForgeCall\(method = "(\w+)", path = "([^"]+)"/.exec(line);
        if (call) {
          yield {
            schemaVersion: 1,
            kind: "Unresolved",
            id: `${repo.name}.call-${i + 1}-${path.length}`,
            status: "current",
            confidence: "inferred",
            unresolvedKind: "forge-call",
            raw: `${call[1]} ${call[2]}`,
            evidence: [{ source: "code", path, line: i + 1, side: "caller" }],
          } as unknown as CatalogRecord;
        }
      }
    }
  },
});

describe(`synthetic estate (${SIZE} repos)`, () => {
  it("is deterministic for a seed and different for another", () => {
    const hash = (seed: number) =>
      createHash("sha256")
        .update(JSON.stringify(generateEstate({ repos: 40, seed }).repos))
        .digest("hex");
    expect(hash(7)).toBe(hash(7));
    expect(hash(7)).not.toBe(hash(8));
    const a = prng(1);
    const b = prng(1);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("has a valid manifest with exactly the requested number of repos", () => {
    const e = generateEstate({ repos: SIZE });
    const m = RepoManifest.parse(parse(e.manifest));
    expect(m.repos).toHaveLength(SIZE);
    expect(new Set(m.repos.map((r) => r.id)).size).toBe(SIZE);
    expect(e.expected.endpoints).toBe(e.expected.services * 4);
    expect(e.expected.directCalls + e.expected.gatewayCalls).toBe(e.expected.calls);
    expect(e.expected.gatewayCalls).toBeGreaterThan(0);
  });

  it(
    "scans every repo, finds exactly the expected facts, and a rescan comes from the cache",
    async () => {
      const estate = generateEstate({ repos: SIZE });
      const dir = await mkdtemp(join(tmpdir(), "atticus-synth-"));
      await writeEstate(estate, dir);
      const cache = fsScanCache(join(dir, ".index", "scan-cache"));
      const sha = (id: string) => createHash("sha1").update(id).digest("hex");

      const scanAll = async () => {
        const out: RepoScan[] = [];
        for (const r of estate.repos) {
          out.push(
            await scanRepo({
              repo: fsRepo(r.id, join(dir, "repos", r.id), sha(r.id)),
              extractors: [forgeDemo],
              cache,
              scannedAt: "2026-10-18T07:00:00Z",
            }),
          );
        }
        return out;
      };

      const t0 = performance.now();
      const first = await scanAll();
      const firstMs = performance.now() - t0;
      const records = first.flatMap((s) => s.records);
      expect(first.flatMap((s) => s.rejected)).toEqual([]);
      expect(records.filter((r) => r.kind === "Endpoint")).toHaveLength(estate.expected.endpoints);
      expect(records.filter((r) => r.kind === "Unresolved")).toHaveLength(
        estate.expected.directCalls,
      );

      const t1 = performance.now();
      const second = await scanAll();
      const secondMs = performance.now() - t1;
      expect(
        second.flatMap((s) => s.runs).every((r) => r.status === "cached" || r.status === "skipped"),
      ).toBe(true);
      expect(second.flatMap((s) => s.records)).toEqual(records);

      // Generous limits so slow CI machines pass; the point is the order of magnitude.
      expect(firstMs).toBeLessThan(120_000);
      expect(secondMs).toBeLessThan(firstMs);
      console.log(
        `${SIZE} repos: first scan ${Math.round(firstMs)} ms, cached rescan ${Math.round(secondMs)} ms, ${records.length} records`,
      );
    },
    T,
  );
});
