import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { CatalogRecord } from "@maycombhq/core";
import {
  cacheKeyHash,
  configHash,
  defineExtractor,
  fsRepo,
  fsScanCache,
  memoryRepo,
  memoryScanCache,
  scanRepo,
  stampEvidence,
  type Extractor,
} from "../src/index.js";

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const AT = "2026-10-18T04:00:00Z";

function system(id: string, path: string, extra: Record<string, unknown> = {}): CatalogRecord {
  return {
    schemaVersion: 1,
    kind: "System",
    id,
    status: "current",
    confidence: "verified",
    evidence: [{ source: "config", path }],
    name: id,
    boundary: "product",
    repos: [],
    tags: [],
    accessGroup: "everyone",
    ...extra,
  } as unknown as CatalogRecord;
}

/** Emits one System per systems/*.txt file and counts how often it actually ran. */
function systemsExtractor(version = "1.0.0"): Extractor & { calls: number } {
  const x = {
    calls: 0,
    ...defineExtractor({
      id: "systems",
      version,
      claims: ["systems/*.txt"],
      async *scan(repo) {
        x.calls++;
        for await (const path of repo.listFiles(["systems/*.txt"])) {
          yield system((await repo.readText(path)).trim(), path);
        }
      },
    }),
  };
  return x;
}

const repo = () =>
  memoryRepo("forge-demo", SHA, {
    "systems/b.txt": "billing",
    "systems/a.txt": "accounts",
    "README.md": "x",
  });

describe("stampEvidence", () => {
  it("fills repo, commit, scan time and extractor on evidence read from the repo", () => {
    const r = stampEvidence(system("a", "x.yaml"), repo(), "systems@1.0.0", AT) as {
      evidence: object[];
    };
    expect(r.evidence[0]).toEqual({
      source: "config",
      path: "x.yaml",
      repo: "forge-demo",
      commit: SHA,
      scannedAt: AT,
      extractor: "systems@1.0.0",
    });
  });

  it("keeps values the extractor set and leaves non-repo evidence alone", () => {
    const rec = system("a", "x.yaml");
    rec.evidence = [
      { source: "code", repo: "other-repo", path: "Y.java" } as never,
      { source: "diagram", path: "d.drawio" } as never,
    ];
    const r = stampEvidence(rec, repo(), "systems@1.0.0", AT) as {
      evidence: Record<string, unknown>[];
    };
    expect(r.evidence[0]).toEqual({
      source: "code",
      repo: "other-repo",
      path: "Y.java",
      extractor: "systems@1.0.0",
    });
    expect(r.evidence[1]).toEqual({ source: "diagram", path: "d.drawio" });
  });
});

describe("scanRepo", () => {
  it("runs extractors, stamps evidence and sorts records deterministically", async () => {
    const s = await scanRepo({ repo: repo(), extractors: [systemsExtractor()], scannedAt: AT });
    expect(s.records.map((r) => r.id)).toEqual(["accounts", "billing"]);
    expect(s.records[0]!.evidence[0]).toMatchObject({
      repo: "forge-demo",
      commit: SHA,
      extractor: "systems@1.0.0",
    });
    expect(s.runs).toEqual([
      expect.objectContaining({ extractor: "systems", status: "ran", records: 2, rejected: 0 }),
    ]);
  });

  it("skips an extractor whose claimed files aren't in the repo", async () => {
    const x = systemsExtractor();
    const s = await scanRepo({
      repo: memoryRepo("r", SHA, { "README.md": "" }),
      extractors: [x],
      scannedAt: AT,
    });
    expect(s.runs[0]!.status).toBe("skipped");
    expect(x.calls).toBe(0);
  });

  it("isolates a failing extractor and drops its partial output", async () => {
    const broken = defineExtractor({
      id: "broken",
      version: "1.0.0",
      claims: ["**/*"],
      async *scan() {
        yield system("half-done", "x.yaml");
        throw new Error("parser exploded");
      },
    });
    const s = await scanRepo({
      repo: repo(),
      extractors: [broken, systemsExtractor()],
      scannedAt: AT,
    });
    expect(s.runs.map((r) => [r.extractor, r.status])).toEqual([
      ["broken", "failed"],
      ["systems", "ran"],
    ]);
    expect(s.runs[0]!.error).toBe("parser exploded");
    expect(s.records.map((r) => r.id)).toEqual(["accounts", "billing"]);
  });

  it("reports invalid records and duplicates without returning them", async () => {
    const sloppy = defineExtractor({
      id: "sloppy",
      version: "1.0.0",
      claims: ["**/*"],
      async *scan(_repo, ctx) {
        yield system("Not A Slug", "x.yaml");
        yield system("dup", "x.yaml");
        yield system("dup", "y.yaml");
        ctx.warn("odd file", "README.md");
      },
    });
    const s = await scanRepo({ repo: repo(), extractors: [sloppy], scannedAt: AT });
    expect(s.records.map((r) => r.id)).toEqual(["dup"]);
    expect(s.rejected).toHaveLength(1);
    expect(s.warnings.map((w) => w.message)).toEqual([
      "emitted System/dup more than once; kept the first",
      "odd file",
    ]);
  });

  it("refuses the same extractor twice", async () => {
    await expect(
      scanRepo({ repo: repo(), extractors: [systemsExtractor(), systemsExtractor()] }),
    ).rejects.toThrow(/twice/);
  });

  it("uses the cache for an unchanged commit, extractor version, dialects and config", async () => {
    const cache = memoryScanCache();
    const x = systemsExtractor();
    const first = await scanRepo({
      repo: repo(),
      extractors: [x],
      cache,
      dialects: ["forge"],
      scannedAt: AT,
    });
    const second = await scanRepo({
      repo: repo(),
      extractors: [x],
      cache,
      dialects: ["forge"],
      scannedAt: "2026-10-19T00:00:00Z",
    });
    expect(x.calls).toBe(1);
    expect(second.runs[0]!.status).toBe("cached");
    // Cached records keep the time they were actually scanned.
    expect(second.records).toEqual(first.records);
  });

  it("misses the cache when anything in the key changes", async () => {
    const cache = memoryScanCache();
    const x = systemsExtractor();
    await scanRepo({ repo: repo(), extractors: [x], cache, scannedAt: AT });
    await scanRepo({
      repo: memoryRepo("forge-demo", "f".repeat(40), { "systems/a.txt": "a" }),
      extractors: [x],
      cache,
      scannedAt: AT,
    });
    await scanRepo({ repo: repo(), extractors: [x], cache, dialects: ["forge"], scannedAt: AT });
    await scanRepo({
      repo: repo(),
      extractors: [x],
      cache,
      configFor: () => configHash({ "rules.yaml": "v2" }),
      scannedAt: AT,
    });
    await scanRepo({ repo: repo(), extractors: [systemsExtractor("1.0.1")], cache, scannedAt: AT });
    expect(x.calls).toBe(4);
    expect(cache.size()).toBe(5);
  });

  it("never reads or writes the cache for a dirty checkout", async () => {
    const cache = memoryScanCache();
    const x = systemsExtractor();
    await scanRepo({ repo: repo(), extractors: [x], cache, dirty: true, scannedAt: AT });
    await scanRepo({ repo: repo(), extractors: [x], cache, dirty: true, scannedAt: AT });
    expect(x.calls).toBe(2);
    expect(cache.size()).toBe(0);
  });
});

describe("cache keys", () => {
  const key = { repo: "r", commit: SHA, extractor: "x", version: "1.0.0", dialects: ["b", "a"] };
  it("ignores dialect order and nothing else", () => {
    expect(cacheKeyHash(key)).toBe(cacheKeyHash({ ...key, dialects: ["a", "b"] }));
    expect(cacheKeyHash(key)).not.toBe(cacheKeyHash({ ...key, config: "c" }));
    expect(configHash({ b: "2", a: "1" })).toBe(configHash({ a: "1", b: "2" }));
  });
});

describe("fsScanCache", () => {
  const key = {
    repo: "forge-demo",
    commit: SHA,
    extractor: "systems",
    version: "1.0.0",
    dialects: [],
  };

  it("round-trips through disk and is used by scanRepo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-cache-"));
    const x = systemsExtractor();
    const first = await scanRepo({
      repo: repo(),
      extractors: [x],
      cache: fsScanCache(dir),
      scannedAt: AT,
    });
    const second = await scanRepo({
      repo: repo(),
      extractors: [x],
      cache: fsScanCache(dir),
      scannedAt: AT,
    });
    expect(x.calls).toBe(1);
    expect(second.records).toEqual(first.records);
    const files = await readdir(join(dir, "forge-demo", SHA));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^systems@1\.0\.0\.[0-9a-f]{16}\.json$/);
  });

  it("treats an edited or truncated file as a miss", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-cache-"));
    const cache = fsScanCache(dir);
    await cache.put(key, { records: [], warnings: [], rejected: 0 });
    const folder = join(dir, "forge-demo", SHA);
    const [name] = await readdir(folder);
    const path = join(folder, name!);
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace('"rejected":0', '"rejected":9'));
    expect(await cache.get(key)).toBeUndefined();
    await writeFile(path, text.slice(0, 20));
    expect(await cache.get(key)).toBeUndefined();
  });

  it("prunes old commits of a repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-cache-"));
    const cache = fsScanCache(dir);
    const old = "a".repeat(40);
    await cache.put(key, { records: [], warnings: [], rejected: 0 });
    await cache.put({ ...key, commit: old }, { records: [], warnings: [], rejected: 0 });
    expect(await cache.prune("forge-demo", [SHA])).toBe(1);
    expect(await cache.get(key)).toBeDefined();
    expect(await cache.get({ ...key, commit: old })).toBeUndefined();
  });

  it("refuses key parts that could escape the cache folder", async () => {
    const cache = fsScanCache(await mkdtemp(join(tmpdir(), "atticus-cache-")));
    await expect(
      cache.put({ ...key, repo: "../x" }, { records: [], warnings: [], rejected: 0 }),
    ).rejects.toThrow(/unsafe/);
  });
});

describe("fsRepo", () => {
  it("lists files sorted with forward slashes and skips ignored folders and symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-fsrepo-"));
    const files = [
      "src/b/B.java",
      "src/a/A.java",
      "node_modules/x/i.js",
      ".git/config",
      "target/out.class",
      "pom.xml",
    ];
    for (const f of files) {
      await mkdir(join(dir, dirname(f)), { recursive: true });
      await writeFile(join(dir, f), "x");
    }
    const outside = await mkdtemp(join(tmpdir(), "atticus-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret");
    let linked = true;
    try {
      await symlink(join(outside, "secret.txt"), join(dir, "src", "link.txt"));
    } catch {
      linked = false; // Windows without symlink rights
    }
    const r = fsRepo("demo", dir, SHA);
    const listed: string[] = [];
    for await (const p of r.listFiles(["**/*"])) listed.push(p);
    expect(listed).toEqual(["pom.xml", "src/a/A.java", "src/b/B.java"]);
    if (linked) await expect(r.readText("src/link.txt")).rejects.toThrow();
  });

  it("refuses paths that leave the repo and strips a byte-order mark", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-fsrepo-"));
    await writeFile(join(dir, "a.yaml"), "\ufeffname: x\n");
    const r = fsRepo("demo", dir, SHA);
    expect(await r.readText("a.yaml")).toBe("name: x\n");
    for (const bad of ["../a.yaml", "/etc/passwd", "C:/x", "a\\b"])
      await expect(r.readText(bad), bad).rejects.toThrow();
    await expect(r.readText("missing.txt")).rejects.toThrow(/no such file/);
  });

  it("refuses files over the size limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-fsrepo-"));
    await writeFile(join(dir, "big.json"), "x".repeat(2000));
    await expect(
      fsRepo("demo", dir, SHA, { maxFileBytes: 1000 }).readText("big.json"),
    ).rejects.toThrow(/larger/);
  });

  it("leaves files over the size limit out of listings and says which, so one can't sink an extractor", async () => {
    // A committed vendor.min.js used to throw inside the extractor, which lost every record it
    // had found in the repo.
    const dir = await mkdtemp(join(tmpdir(), "atticus-fsrepo-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "app.ts"), 'http.get("/api/a");\n');
    await writeFile(join(dir, "src", "vendor.min.ts"), "x".repeat(2000));
    const repo = fsRepo("demo", dir, SHA, { maxFileBytes: 1000 });
    const reader = defineExtractor({
      id: "calls",
      version: "1.0.0",
      claims: ["src/**/*.ts"],
      async *scan(r) {
        for await (const path of r.listFiles(this.claims)) {
          const text = await r.readText(path);
          if (text.includes("/api/a"))
            yield {
              kind: "Unresolved",
              id: "calls-a",
              schemaVersion: 1,
              status: "current",
              unresolvedKind: "http-call",
              raw: "GET /api/a",
              confidence: "inferred",
              evidence: [{ source: "code", path, line: 1 }],
            };
        }
      },
    });
    const scan = await scanRepo({ repo, extractors: [reader], scannedAt: AT });
    expect(scan.runs[0]!.status).toBe("ran");
    expect(scan.records.map((r) => r.id)).toEqual(["calls-a"]);
    expect(repo.skippedFiles()).toEqual([{ path: "src/vendor.min.ts", bytes: 2000 }]);
  });
});

describe("golden: the runner over the Forge fixture", () => {
  /** A tiny Flyway reader, enough to prove the runner end to end against the expected catalog. */
  const flyway = defineExtractor({
    id: "flyway-demo",
    version: "0.1.0",
    claims: ["**/db/migration/V*__*.sql"],
    async *scan(repo) {
      for await (const path of repo.listFiles(this.claims)) {
        const version = /V(\d+)__/.exec(path)![1]!;
        const sql = await repo.readText(path);
        const operations = [...sql.matchAll(/create\s+(table|index)\s+([a-z_]+)/gi)].map(
          (m) => `create ${m[1]!.toLowerCase()} ${m[2]!.toLowerCase()}`,
        );
        yield {
          schemaVersion: 1,
          kind: "Migration",
          id: `ledger-db.v${version}`,
          status: "current",
          confidence: "verified",
          dataStore: "ledger-db",
          version,
          tool: "flyway",
          file: path,
          operations,
          evidence: [{ source: "migration", path, line: 1 }],
        } as unknown as CatalogRecord;
      }
    },
  });

  it("produces the expected Migration records from forge-ledger", async () => {
    const s = await scanRepo({
      repo: fsRepo("forge-ledger", join(FORGE, "repos/forge-ledger"), SHA),
      extractors: [flyway],
      scannedAt: AT,
    });
    expect(s.rejected).toEqual([]);
    const expected = (
      parse(await readFile(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<string, unknown>[]
    )
      .filter((r) => r.kind === "Migration")
      .map((r) => ({ schemaVersion: 2, status: "current", ...r }));
    const strip = (r: CatalogRecord) => ({
      ...r,
      evidence: r.evidence.map(({ commit: _c, scannedAt: _s, extractor: _x, ...rest }) => rest),
    });
    expect(s.records.map(strip)).toEqual(expected);
    expect(s.records[0]!.evidence[0]).toMatchObject({
      commit: SHA,
      scannedAt: AT,
      extractor: "flyway-demo@0.1.0",
    });
  });

  it("gives byte-identical output on a second run", async () => {
    const run = () =>
      scanRepo({
        repo: fsRepo("forge-ledger", join(FORGE, "repos/forge-ledger"), SHA),
        extractors: [flyway],
        scannedAt: AT,
      });
    expect(JSON.stringify((await run()).records)).toBe(JSON.stringify((await run()).records));
  });
});
