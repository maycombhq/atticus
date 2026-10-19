import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUi } from "@maycombhq/cli/dist/ui-commands.js";
import { generateEstate, writeEstate } from "@maycombhq/synth";
import { scanEstate, writeCatalog } from "@maycombhq/scanner";
import { uiDistDir } from "@maycombhq/ui";

/**
 * Performance budgets (M5). The estate an install targets is 30 to 40 repos; these run on a
 * synthetic estate of 120 (three times that) on the build machine (2 CPUs), with the seeded
 * change laid over it. Budgets are what a person waits for, with room for a slower laptop.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../fixtures");
const REPOS = Number(process.env.ATTICUS_PERF_REPOS ?? 120);
const BIN = join(HERE, "../../cli/dist/bin.js");

const BUDGET = {
  scanMs: 120_000,
  firstIndexMs: 30_000,
  apiP95Ms: 1_000,
  viewP95Ms: 6_000,
  cliStartMs: 2_000,
  appGzipBytes: 1_200_000,
};

let root: string;
let ui: Awaited<ReturnType<typeof startUi>>;
const timings: Record<string, number> = {};

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;

async function timed(path: string, n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    const r = await fetch(ui.url + path, { headers: { "X-Atticus-Token": ui.token } });
    await r.arrayBuffer();
    if (r.status !== 200) throw new Error(`${path}: ${r.status}`);
    out.push(performance.now() - t);
  }
  return out;
}

beforeAll(async () => {
  const top = await mkdtemp(join(tmpdir(), "atticus-perf-"));
  root = join(top, "metarepo");
  const estate = generateEstate({ repos: REPOS });
  await writeEstate(estate, root);
  await cp(join(FIXTURES, "forge-change/openspec"), join(root, "openspec"), { recursive: true });
  const t = performance.now();
  const scan = await scanEstate({
    root,
    repoDir: (id) => join(root, "repos", id),
    repoState: async (id) => ({
      commit: id
        .padEnd(40, "0")
        .slice(0, 40)
        .replace(/[^0-9a-f]/g, "a"),
      dirty: false,
    }),
    scannedAt: "2026-10-19T09:00:00Z",
  });
  await writeCatalog(join(root, "catalog", "generated"), scan.records);
  timings.scanMs = performance.now() - t;
  timings.records = scan.records.length;
  ui = await startUi(root, { port: 0, user: "pat", staticDir: uiDistDir() });
});
afterAll(async () => {
  await ui?.close();
  console.log(`Performance on ${REPOS} repos:\n${JSON.stringify(timings, null, 2)}`);
});

describe(`performance budgets (${REPOS} synthetic repos)`, () => {
  it("scans the estate and builds the index on first use within budget", async () => {
    expect(timings.scanMs).toBeLessThan(BUDGET.scanMs);
    const t = performance.now();
    await timed("/api/catalog/kinds", 1);
    timings.firstIndexMs = performance.now() - t;
    expect(timings.firstIndexMs).toBeLessThan(BUDGET.firstIndexMs);
  });

  it("answers the catalog calls the screens make within budget", async () => {
    const graph = await fetch(ui.url + "/api/graph", { headers: { "X-Atticus-Token": ui.token } });
    const nodes = ((await graph.json()) as { nodes: { id: string; kind: string }[] }).nodes;
    const system = nodes.find((n) => n.kind === "System")?.id ?? nodes[0]!.id;
    for (const path of [
      "/api/catalog/kinds",
      "/api/catalog/Interface?limit=50",
      "/api/search?q=kind%3Ainterface",
      "/api/graph",
      `/api/impact/${encodeURIComponent(system)}`,
      "/api/changes",
      "/api/across?view=tasks",
      "/api/me",
    ]) {
      const p = p95(await timed(path, 10));
      timings[`p95 ${path}`] = Math.round(p);
      expect(p, path).toBeLessThan(BUDGET.apiP95Ms);
    }
  });

  it("answers the views that run a command within budget", async () => {
    for (const path of ["/api/view/coverage", "/api/view/triage", "/api/setup"]) {
      const p = p95(await timed(path, 3));
      timings[`p95 ${path}`] = Math.round(p);
      expect(p, path).toBeLessThan(BUDGET.viewP95Ms);
    }
  });

  it("starts the command line quickly and serves a small app", async () => {
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      const r = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" });
      runs.push(performance.now() - t);
      expect(r.status).toBe(0);
    }
    timings.cliStartMs = Math.round([...runs].sort((a, b) => a - b)[1]!);
    expect(timings.cliStartMs).toBeLessThan(BUDGET.cliStartMs);
    const assets = join(uiDistDir(), "assets");
    let bytes = 0;
    for (const f of await readdir(assets))
      if (/\.(js|css)$/.test(f)) bytes += gzipSync(await readFile(join(assets, f))).length;
    timings.appGzipBytes = bytes;
    expect(bytes).toBeLessThan(BUDGET.appGzipBytes);
  });
});
