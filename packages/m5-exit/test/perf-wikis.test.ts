import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { knowledgeScan } from "@maycombhq/cli/dist/knowledge-scan-commands.js";
import { loadOrgPack, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { openIndex } from "@maycombhq/index";
import { estimateScan, readKnowledge, syncSources, writeSnapshots } from "@maycombhq/knowledge";
import { estateOf, FlowDelta, selectTaskKnowledge, taskKnowledgeInput } from "@maycombhq/planner";
import { writeWikiEstate } from "@maycombhq/synth";

/**
 * Many wikis at scale (ADR 0132). The invented Forge shop's 12 knowledge sources (2 standards,
 * 2 platforms, 2 frameworks, 5 teams, 1 reference) with the generator's filler, about 4,800 pages,
 * on the build machine (2 CPUs): the sync (a Confluence and a SharePoint export among them), the
 * knowledge scan (a mock model that writes one item per page, so every check runs), the index,
 * each task's knowledge for the 14 tasks of a change (in one call, as the stories stage asks, and
 * one call per task, as `atticus task context` does), a rescan after a few pages change, and
 * what five syncs add to the metarepo's Git history. Budgets are what a person waits for, with
 * room for a slower laptop. Runs alone (the package's own test run), never beside other suites.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../fixtures");
const SCALE = Number(process.env.ATTICUS_PERF_WIKI_SCALE ?? 1);

const BUDGET = {
  syncMs: 60_000,
  scanMs: 120_000,
  indexMs: 60_000,
  tasksOneCallMs: 30_000,
  tasksPerTaskMs: 90_000,
  rescanMs: 30_000,
  estimateMs: 30_000,
  maxRssMb: 1_500,
  /** What four more syncs, each with 1% of the pages changed, add to .git, against the first. */
  gitGrowth: 0.25,
};

const timings: Record<string, number> = {};
let root: string;
let pagesSeen = 0;
let calls = 0;

const day = (n: number) => `2026-10-${String(20 + n).padStart(2, "0")}T08:00:00Z`;

/** A mock model that writes one process per page the prompt holds, quoting the page's words. */
function oneItemPerPage(req: AiRequest): string {
  calls++;
  const items: unknown[] = [];
  for (const m of req.pack.prompt.matchAll(
    /<atticus-data id="page-\d+" kind="document" origin="([^"]+)">\n([\s\S]*?)\n<\/atticus-data>/g,
  )) {
    pagesSeen++;
    const origin = m[1]!;
    const lines = m[2]!.split("\n");
    const title = lines
      .find((l) => l.startsWith("# "))
      ?.slice(2)
      .trim();
    const h = lines.findIndex((l) => l.startsWith("## "));
    if (!title || h < 0) continue;
    const first = lines.slice(h + 1).find((l) => l.trim());
    const sentence = first?.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").match(/^[^.]*\./)?.[0];
    if (!sentence) continue;
    items.push({
      kind: "process",
      id: origin
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 100),
      title,
      applies_when: `A team works on ${title.toLowerCase()}.`,
      steps: [sentence],
      source: { page: origin, section: lines[h]!.slice(3).trim(), quote: sentence },
    });
  }
  return JSON.stringify({ items, conflicts: [], superseded: [], injections: [] });
}

const quiet = { out: () => undefined, err: () => undefined };
const git = (...args: string[]) =>
  spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "perf",
      GIT_AUTHOR_EMAIL: "perf@example.com",
      GIT_COMMITTER_NAME: "perf",
      GIT_COMMITTER_EMAIL: "perf@example.com",
    },
  });
const gitBytes = () => {
  const out = git("count-objects", "-v").stdout;
  const kb = (k: string) => Number(new RegExp(`^${k}: (\\d+)`, "m").exec(out)?.[1] ?? 0);
  return (kb("size") + kb("size-pack")) * 1024;
};

async function countFiles(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true }))
    if (e.isFile()) {
      files++;
      bytes += (await stat(join(e.parentPath, e.name))).size;
    }
  return { files, bytes };
}

async function sync(n: number) {
  const op = await loadOrgPack(join(root, "org-pack"));
  const s = await syncSources({ root, orgPack: op, now: day(n) });
  const w = await writeSnapshots({ root, orgPack: op, sync: s, takenAt: day(n) });
  return { op, s, copied: w.reduce((a, x) => a + x.copied, 0) };
}

beforeAll(async () => {
  root = join(await mkdtemp(join(tmpdir(), "atticus-perf-wikis-")), "metarepo");
  await mkdir(root, { recursive: true });
  await writeWikiEstate(root, { fixtures: FIXTURES, scale: SCALE });
  for (const r of parse(
    readFileSync(join(FIXTURES, "many-wikis/catalog.yaml"), "utf8"),
  ) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  git("init", "-q");
  git("add", "-A", "org-pack", "catalog");
  git("commit", "-qm", "estate");
}, 600_000);

afterAll(() => {
  console.log(`Many wikis at scale ${SCALE}:\n${JSON.stringify(timings, null, 2)}`);
});

describe(`many wikis at scale (12 sources, scale ${SCALE})`, () => {
  it("syncs every source within budget, and the metarepo's history grows by what changed", async () => {
    let t = performance.now();
    const first = await sync(0);
    timings.syncMs = Math.round(performance.now() - t);
    timings.pages = first.s.pages.length;
    timings.skipped = first.s.skipped.length;
    expect(timings.pages).toBeGreaterThan(4000 * SCALE);
    expect(timings.syncMs).toBeLessThan(BUDGET.syncMs);
    git("add", "-A", "knowledge");
    git("commit", "-qm", "sync 1");
    git("gc", "-q");
    const base = gitBytes();
    timings.gitAfterFirstSyncBytes = base;
    const firstFiles = await countFiles(join(root, "knowledge/snapshots"));
    timings.snapshotFilesAfterFirstSync = firstFiles.files;
    timings.snapshotBytesAfterFirstSync = firstFiles.bytes;
    // Four more syncs, a day apart, each with 1% of the team wikis' pages edited.
    for (let n = 1; n <= 4; n++) {
      const dir = join(root, "wikis/orders-team/notes");
      const files = (await readdir(dir))
        .sort()
        .slice(0, Math.max(1, Math.round(0.01 * timings.pages)));
      for (const f of files) {
        const p = join(dir, f);
        await writeFile(p, `${await readFile(p, "utf8")}\nEdited on day ${n}.\n`);
      }
      t = performance.now();
      const r = await sync(n);
      timings[`sync${n + 1}Ms`] = Math.round(performance.now() - t);
      timings[`sync${n + 1}Copied`] = r.copied;
      expect(r.copied).toBe(files.length);
      git("add", "-A", "knowledge");
      git("commit", "-qm", `sync ${n + 1}`);
    }
    git("gc", "-q");
    timings.gitAfterFiveSyncsBytes = gitBytes();
    expect(timings.gitAfterFiveSyncsBytes).toBeLessThan(base * (1 + BUDGET.gitGrowth));
    // The working tree holds each page once, and each later snapshot only what changed (and its
    // manifest): a full copy a sync would have been five times the first.
    const after = await countFiles(join(root, "knowledge/snapshots"));
    timings.snapshotFilesAfterFiveSyncs = after.files;
    timings.snapshotBytesAfterFiveSyncs = after.bytes;
    expect(after.files).toBeLessThan(firstFiles.files * 1.1);
  }, 600_000);

  it("estimates a scan's pages, tokens and model calls before it runs", async () => {
    const op = await loadOrgPack(join(root, "org-pack"));
    const t = performance.now();
    const e = await estimateScan(root, { orgPack: op });
    timings.estimateMs = Math.round(performance.now() - t);
    timings.estimateTokens = e.total.tokens;
    timings.estimateCalls = e.total.calls;
    expect(e.total.toRead).toBe(e.total.pages);
    expect(timings.estimateMs).toBeLessThan(BUDGET.estimateMs);
  }, 300_000);

  it("scans every page in batches, then rescans only what changed", async () => {
    const runtime = new MockRuntime(oneItemPerPage, { now: () => new Date(day(4)) });
    let t = performance.now();
    expect(await knowledgeScan(root, {}, { runtime, now: new Date(day(4)) }, quiet)).toBeLessThan(
      2,
    );
    timings.scanMs = Math.round(performance.now() - t);
    timings.scanCalls = calls;
    timings.scanPages = pagesSeen;
    const k = await readKnowledge(root, { cacheRoot: root });
    timings.items = k.items.length;
    expect(timings.scanMs).toBeLessThan(BUDGET.scanMs);
    expect(k.items.length).toBeGreaterThan(0.8 * timings.pages!);
    // Ten pages change; the rescan reads those ten and keeps every other item.
    const dir = join(root, "wikis/stock-team/runbooks");
    const files = (await readdir(dir)).sort().slice(0, 10);
    for (const f of files) {
      const p = join(dir, f);
      await writeFile(p, `${await readFile(p, "utf8")}\nEdited for the rescan.\n`);
    }
    await sync(5);
    pagesSeen = 0;
    t = performance.now();
    expect(await knowledgeScan(root, {}, { runtime, now: new Date(day(5)) }, quiet)).toBeLessThan(
      2,
    );
    timings.rescanMs = Math.round(performance.now() - t);
    timings.rescanPages = pagesSeen;
    expect(pagesSeen).toBe(10);
    expect((await readKnowledge(root, { cacheRoot: root })).items.length).toBe(k.items.length);
    expect(timings.rescanMs).toBeLessThan(BUDGET.rescanMs);
  }, 600_000);

  it("builds the index and lists each task's knowledge for 14 tasks within budget", async () => {
    // The hand-written items of the planted pages join the scan's.
    for (const r of parse(
      readFileSync(join(FIXTURES, "many-wikis/knowledge.yaml"), "utf8"),
    ) as unknown[]) {
      const p = parseRecord(r);
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      const f = join(root, "knowledge/items", recordPath(p.record));
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, serializeRecord(p.record));
    }
    let t = performance.now();
    (await openIndex(root)).close();
    timings.indexMs = Math.round(performance.now() - t);
    expect(timings.indexMs).toBeLessThan(BUDGET.indexMs);
    const change = parse(readFileSync(join(FIXTURES, "many-wikis/change.yaml"), "utf8"));
    const records = parse(readFileSync(join(FIXTURES, "many-wikis/catalog.yaml"), "utf8"));
    const estate = estateOf(
      records.map((r: unknown) => (parseRecord(r) as unknown as { record: never }).record),
      [],
    );
    const inputs = change.stories.flatMap(
      (s: { id: string; repo: string; flow: string; tasks: Record<string, unknown>[] }) =>
        s.tasks.map((task, n) => {
          const found = change.targetFlows.find((d: { flow: string }) => d.flow === s.flow);
          return taskKnowledgeInput(
            { ...s, name: s.id, tasks: [] } as never,
            {
              story: s.id,
              repo: s.repo,
              flow: s.flow,
              position: n + 1,
              fields: [],
              evidence: [],
              ...task,
            } as never,
            found ? FlowDelta.parse(found) : undefined,
            estate,
          );
        }),
    );
    expect(inputs).toHaveLength(14);
    t = performance.now();
    const all = await selectTaskKnowledge(root, change.change, inputs);
    timings.tasksOneCallMs = Math.round(performance.now() - t);
    expect([...all.byTask.values()].every((l) => l.length > 0)).toBe(true);
    expect(timings.tasksOneCallMs).toBeLessThan(BUDGET.tasksOneCallMs);
    t = performance.now();
    for (const i of inputs) await selectTaskKnowledge(root, change.change, [i]);
    timings.tasksPerTaskMs = Math.round(performance.now() - t);
    expect(timings.tasksPerTaskMs).toBeLessThan(BUDGET.tasksPerTaskMs);
    timings.maxRssMb = Math.round(process.resourceUsage().maxRSS / 1024);
    expect(timings.maxRssMb).toBeLessThan(BUDGET.maxRssMb);
    const size = await stat(join(root, ".index", "catalog.sqlite")).catch(() => undefined);
    if (size) timings.indexBytes = size.size;
  }, 600_000);
});
