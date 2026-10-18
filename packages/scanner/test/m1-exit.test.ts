import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fsScanCache } from "@maycombhq/sdk";
import { openIndex } from "@maycombhq/index";
import { generateEstate, writeEstate } from "@maycombhq/synth";
import { diffCatalogs, scanEstate, writeCatalog } from "../src/index.js";

/**
 * M1 exit, at scale: the whole pipeline (every built-in extractor, the Forge dialect, merge,
 * catalog files and the index) over the synthetic estate. Exit criteria: an incremental scan
 * of 300 repos in under 10 minutes and an index under 2 GB. ATTICUS_SYNTH_REPOS tries other sizes.
 */
const SIZE = Number(process.env.ATTICUS_SYNTH_REPOS ?? 300);
const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
const T = 600_000;

describe(`M1 exit on the synthetic estate (${SIZE} repos)`, () => {
  it(
    "scans, writes and indexes the estate; a one-repo change rescans incrementally in well under 10 minutes",
    async () => {
      const estate = generateEstate({ repos: SIZE });
      // The Forge dialect's own tests read ../../../repos/forge-ledger from its folder.
      const top = await mkdtemp(join(tmpdir(), "atticus-m1-"));
      const root = join(top, "metarepo");
      await writeEstate(estate, root);
      await cp(join(FORGE, "metarepo/org-pack/dialects"), join(root, "org-pack/dialects"), {
        recursive: true,
      });
      await cp(join(FORGE, "repos/forge-ledger"), join(top, "repos/forge-ledger"), {
        recursive: true,
      });

      const commits = new Map(
        estate.repos.map((r) => [r.id, createHash("sha1").update(r.id).digest("hex")]),
      );
      const cache = fsScanCache(join(root, ".index", "scan-cache"));
      const scan = () =>
        scanEstate({
          root,
          repoDir: (id) => join(root, "repos", id),
          repoState: async (id) => ({ commit: commits.get(id)!, dirty: false }),
          cache,
          scannedAt: "2026-10-18T09:00:00Z",
        });
      const out = join(root, "catalog", "generated");

      // ---- first, full scan
      let t = performance.now();
      const first = await scan();
      const firstScanMs = performance.now() - t;
      expect(first.problems).toEqual([]);
      const count = (kind: string) => first.records.filter((r) => r.kind === kind).length;
      expect(count("Endpoint")).toBe(estate.expected.endpoints + estate.expected.topics);
      expect(first.stats.interfaces).toBe(estate.expected.calls);
      expect(first.stats.verified).toBe(estate.expected.calls);
      expect(count("Deployment")).toBe(estate.expected.deployments);
      expect(count("Migration")).toBe(estate.expected.migrations);
      expect(count("Component")).toBe(
        estate.repos.filter((r) => !["gateway", "event-config", "infra"].includes(r.type)).length,
      );
      t = performance.now();
      const w1 = await writeCatalog(out, first.records);
      const firstWriteMs = performance.now() - t;
      t = performance.now();
      const ix1 = await openIndex(root);
      const firstIndexMs = performance.now() - t;
      expect(ix1.problems).toEqual([]);
      expect(ix1.query("kind:interface").total).toBe(estate.expected.calls);
      ix1.close();

      // ---- one repo changes: a new endpoint and a new commit
      // The last service: no other repo calls it, so the change stays inside one repo.
      const svc = estate.repos.filter((r) => r.type === "forge-service").at(-1)!;
      const file = join(
        root,
        "repos",
        svc.id,
        Object.keys(svc.files).find((f) => f.endsWith("Endpoints.java"))!,
      );
      const src = await readFile(file, "utf8");
      await writeFile(
        file,
        src.replace(
          /}\s*$/,
          `  @ForgeEndpoint(method = "DELETE", path = "/extra/{id}", auth = "oauth2")\n  public Object extra() { return null; }\n}\n`,
        ),
      );
      commits.set(svc.id, createHash("sha1").update(`${svc.id}-2`).digest("hex"));

      t = performance.now();
      const second = await scan();
      const incScanMs = performance.now() - t;
      const w2 = await writeCatalog(out, second.records);
      t = performance.now();
      const ix2 = await openIndex(root);
      const incIndexMs = performance.now() - t;
      const indexBytes = (await stat(ix2.file)).size;
      expect(ix2.query(`kind:endpoint component:${svc.id} method:delete`).total).toBe(1);
      ix2.close();

      expect(second.problems).toEqual([]);
      expect(second.records.length).toBe(first.records.length + 1);
      // Only the changed repo's extractors ran; everything else came from the cache.
      const ranRepos = new Set(
        second.repos.filter((s) => s.runs.some((r) => r.status === "ran")).map((s) => s.repo),
      );
      expect([...ranRepos]).toEqual([svc.id]);
      // The new endpoint is added; the repo's other records only get the new commit in their evidence.
      const d = diffCatalogs(first.records, second.records);
      expect(d.added.map((r) => r.id)).toEqual([`${svc.id}.delete-extra`]);
      expect(d.removed).toEqual([]);
      expect(d.changed).toEqual([]);
      expect(w2.written).toBe(1 + d.evidenceOnly.length);
      expect(w2.written).toBeLessThan(40);

      const incrementalMs = incScanMs + incIndexMs;
      expect(incrementalMs).toBeLessThan(600_000);
      expect(indexBytes).toBeLessThan(2 * 1024 ** 3);

      const report = {
        repos: SIZE,
        records: first.records.length,
        interfaces: first.stats.interfaces,
        firstScanMs: Math.round(firstScanMs),
        firstWriteMs: Math.round(firstWriteMs),
        firstIndexMs: Math.round(firstIndexMs),
        filesWritten: w1.written,
        incrementalScanMs: Math.round(incScanMs),
        incrementalIndexMs: Math.round(incIndexMs),
        filesRewritten: w2.written,
        indexBytes,
      };
      console.log(`M1 exit: ${JSON.stringify(report)}`);
      if (process.env.ATTICUS_M1_REPORT)
        await writeFile(process.env.ATTICUS_M1_REPORT, JSON.stringify(report, null, 2));
    },
    T,
  );
});
