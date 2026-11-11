import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseReadersSlot, readersSlotPath, serializeReadersSlot } from "@maycombhq/scanner";
import { startServer, type RunningServer } from "@maycombhq/server";
import { catalogBuild } from "../src/catalog-build-commands.js";
import { extendUiRoutes } from "../src/ui-commands.js";

/**
 * ADR 0195 ticket CS3 (C4 3.12.0): the readers' cross-check and the build's confirm steps, as the
 * app calls them. The metarepo is the Forge estate's golden slots (every repo's readers, the
 * ledger's facts) built once; each write is the CLI's own command as a local job, so its lines
 * are its Console entry; and no write changes anything until it is confirmed with exactly what
 * the page listed. No network: the routes read and write the temporary metarepo only (CLAUDE.md
 * rule 5).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const SLOTS = join(FORGE, "slots");

let root: string;
let srv: RunningServer;
const quiet = { out: () => undefined, err: () => undefined };

const call = async (path: string, method = "GET", body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: {
      "X-Atticus-Token": srv.token,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
};
type Ended = { id: string; state: string; result?: { code: number; lines: string[] } };
/** A local job followed to its end, as the app's followJob does. */
const job = async (path: string, body: unknown = {}): Promise<Ended> => {
  const started = await call(path, "POST", body);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const id = String(started.body.jobId);
  for (let n = 0; n < 600; n++) {
    const j = await call(`/api/jobs/${id}`);
    if (j.body.state !== "running" && j.body.state !== "queued") return { ...j.body, id } as Ended;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${path} didn't end`);
};

async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(d: string, rel: string) {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) await walk(join(d, e.name), `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = await readFile(join(d, e.name), "utf8");
    }
  }
  await walk(dir, "");
  return out;
}
const catalog = async () => ({
  generated: await tree(join(root, "catalog/generated")),
  sources: await tree(join(root, "catalog/sources")),
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-cs3-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await writeFile(join(root, "org-pack/sources.yaml"), "schemaVersion: 1\nwikis: []\n");
  await cp(join(SLOTS, "readers"), join(root, "catalog/sources/readers"), { recursive: true });
  await cp(join(SLOTS, "facts"), join(root, "catalog/sources/facts"), { recursive: true });
  await mkdir(join(root, "facts"), { recursive: true });
  // The first build, as a person runs it after the slots land.
  expect(await catalogBuild(root, {}, quiet)).toBe(0);
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    version: "1.0.0",
    extend: (r, ctx) => extendUiRoutes(r, ctx),
  });
}, 240_000);
afterAll(async () => {
  await srv?.close();
  await rm(root, { recursive: true, force: true });
});

describe("the readers' cross-check routes", () => {
  it("counts each repo, and says why a repo without facts isn't compared", async () => {
    const r = await call("/api/crosscheck");
    expect(r.status).toBe(200);
    const ledger = r.body.repos.find((x: { repo: string }) => x.repo === "forge-ledger");
    expect(ledger).toMatchObject({ state: "compared", factsCommit: "0123abc", items: [] });
    expect(ledger.counts.readersOnly + ledger.counts.disagree).toBeGreaterThan(0);
    const others = r.body.repos.filter((x: { repo: string }) => x.repo !== "forge-ledger");
    expect(others.length).toBeGreaterThan(3);
    for (const o of others) expect(o.state).toBe("no-facts");
  });

  it("lists one repo's items with both values and their citations", async () => {
    const r = await call("/api/crosscheck/forge-ledger");
    expect(r.status).toBe(200);
    const items = r.body.items as { state: string; readers?: { cites: unknown[] } }[];
    const found = items.filter((i) => i.state === "readers-only");
    expect(found.length).toBe(r.body.counts.readersOnly);
    for (const i of found) expect(i.readers!.cites.length).toBeGreaterThan(0);
    expect((await call("/api/crosscheck/no-such-repo")).status).toBe(404);
    expect((await call("/api/crosscheck/..%2Fx")).status).toBe(400);
  });

  it("dismisses an item through the CLI command, as a Console entry, and takes it back", async () => {
    const before = await call("/api/crosscheck/forge-ledger");
    const item = (before.body.items as { key: string; state: string }[]).find(
      (i) => i.state === "readers-only",
    )!;
    const generated = await catalog();
    const j = await job("/api/crosscheck/forge-ledger/dismiss", { key: item.key });
    expect(j.state).toBe("done");
    expect(j.result!.lines.join(" ")).toMatch(/dismissed .* at the readers' value/);
    const file = await readFile(join(root, "facts/forge-ledger.crosscheck.yaml"), "utf8");
    expect(file).toContain(`key: ${item.key}`);
    // The catalog and the slots are as they were: a dismissal changes no record.
    expect(await catalog()).toEqual(generated);
    const after = await call("/api/crosscheck/forge-ledger");
    expect(after.body.counts.dismissed).toBe(before.body.counts.dismissed + 1);
    expect(
      (after.body.items as { key: string; dismissed?: boolean }[]).find((i) => i.key === item.key)
        ?.dismissed,
    ).toBe(true);
    // The Console lists the job with what it printed (ADR 0187).
    const activity = await call("/api/activity");
    const entry = (activity.body.entries as { id: string; title?: string }[]).find((e) =>
      e.title?.startsWith(`Dismiss on forge-ledger: ${item.key}`),
    );
    expect(entry).toBeDefined();
    const lines = await call(`/api/activity/${encodeURIComponent(entry!.id)}/lines`);
    expect(JSON.stringify(lines.body)).toMatch(/dismissed/);

    const undo = await job("/api/crosscheck/forge-ledger/dismiss", { key: item.key, undo: true });
    expect(undo.state).toBe("done");
    expect((await call("/api/crosscheck/forge-ledger")).body.counts).toEqual(before.body.counts);
  });

  it("refuses a key that isn't an item now, in words, writing nothing", async () => {
    const was = await readFile(join(root, "facts/forge-ledger.crosscheck.yaml"), "utf8");
    const j = await job("/api/crosscheck/forge-ledger/dismiss", { key: "Endpoint|GET /nowhere" });
    expect(j.state).toBe("failed");
    expect(j.result!.lines.join(" ")).toMatch(/isn't an item the readers found/);
    expect(await readFile(join(root, "facts/forge-ledger.crosscheck.yaml"), "utf8")).toBe(was);
    expect((await call("/api/crosscheck/forge-ledger/dismiss", "POST", {})).status).toBe(400);
  });
});

describe("the build's confirm steps", () => {
  it("says the catalog is what the slots build, and what the last build wrote", async () => {
    const r = await call("/api/build");
    expect(r.status).toBe(200);
    expect(r.body.pending).toMatchObject({ upToDate: true, removals: [] });
    expect(r.body.pending.refused).toBeUndefined();
    expect(r.body.last).toMatchObject({ n: 1, command: "atticus catalog build" });
    expect(r.body.last.added.length).toBeGreaterThan(10);
    const ledger = r.body.sources.find((s: { repo: string }) => s.repo === "forge-ledger");
    expect(ledger).toMatchObject({ source: "facts", commit: "0123abc" });
  });

  it("lists a hand edit, refuses a count it didn't list, and makes it curated", async () => {
    const files = Object.keys((await catalog()).generated).filter((f) => f.startsWith("table/"));
    const path = join(root, "catalog/generated", files[0]!);
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace(/^name: (.+)$/m, "name: $1-renamed"));
    const r = await call("/api/build");
    expect(r.body.pending.refused.reasons).toContain("hand-edits");
    expect(r.body.pending.refused.edits).toEqual([
      { path: `catalog/generated/${files[0]}`, how: "changed" },
    ]);
    expect(r.body.pending.refused.discardEdits).toBe(1);
    const before = await catalog();
    expect((await call("/api/build/edits/curate", "POST", { count: 2 })).status).toBe(409);
    expect(await catalog()).toEqual(before);
    const j = await job("/api/build/edits/curate", { count: 1 });
    expect(j.result!.lines.join(" ")).toMatch(/Wrote catalog\/curated\//);
    expect((await call("/api/build")).body.pending.upToDate).toBe(true);
  });

  it("waits for a large removal's exact count, writes nothing on another, then writes it", async () => {
    const slot = readersSlotPath(root, "forge-gateway");
    const p = parseReadersSlot(await readFile(slot, "utf8"), "forge-gateway");
    if (!p.ok) throw new Error("slot");
    await writeFile(slot, serializeReadersSlot({ ...p.slot, records: p.slot.records.slice(0, 1) }));
    const r = await call("/api/build");
    const refused = r.body.pending.refused;
    expect(refused.reasons).toEqual(["large-removals"]);
    const n = refused.allowRemovals as number;
    expect(refused.removals).toHaveLength(n);
    for (const x of refused.removals) expect(x.explainedBy.length).toBeGreaterThan(0);
    const before = await catalog();
    const wrong = await job("/api/build", { allowRemovals: n + 1 });
    expect(wrong.state).toBe("failed");
    expect(wrong.result!.lines.join(" ")).toMatch(new RegExp(`doesn't name the ${n} listed`));
    expect(await catalog()).toEqual(before);
    const ok = await job("/api/build", { allowRemovals: n });
    expect(ok.state).toBe("done");
    const after = await call("/api/build");
    expect(after.body.pending.upToDate).toBe(true);
    expect(after.body.last.removed).toHaveLength(n);
  });

  it("lists the undo copies and puts back exactly the files listed", async () => {
    const before = await catalog();
    const v = await call("/api/build/undo");
    expect(v.status).toBe(200);
    expect(v.body.copies.length).toBeGreaterThanOrEqual(3);
    const plan = v.body.plan as { n: number; files: unknown[] };
    expect(plan.n).toBe(v.body.copies[0].n);
    expect((await call("/api/build/undo", "POST", { n: plan.n, files: 0 })).status).toBe(409);
    expect(await catalog()).toEqual(before);
    const j = await job("/api/build/undo", { n: plan.n, files: plan.files.length });
    expect(j.state).toBe("done");
    expect(j.result!.lines.join(" ")).toMatch(/Put back/);
    // The large removal is taken back: its records are there again.
    const now = await catalog();
    expect(Object.keys(now.generated).length).toBeGreaterThan(Object.keys(before.generated).length);
    expect((await call("/api/build/undo?n=x")).status).toBe(400);
  });

  it("previews prune and removes exactly the files listed", async () => {
    expect((await call("/api/build/prune")).body).toEqual({ files: [] });
    const manifest = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
    const m = await readFile(manifest, "utf8");
    await writeFile(manifest, m.replace(/(  - id: forge-reports-job\n)/, "$1    archived: true\n"));
    const v = await call("/api/build/prune");
    expect(v.body.files).toEqual([
      {
        path: "catalog/sources/readers/forge-reports-job.json",
        why: "forge-reports-job is archived",
      },
    ]);
    expect((await call("/api/build/prune", "POST", { count: 2 })).status).toBe(409);
    expect(existsSync(readersSlotPath(root, "forge-reports-job"))).toBe(true);
    const j = await job("/api/build/prune", { count: 1 });
    expect(j.state).toBe("done");
    expect(existsSync(readersSlotPath(root, "forge-reports-job"))).toBe(false);
  });

  it("runs one local step at a time", async () => {
    const a = await call("/api/build", "POST", {});
    const b = await call("/api/build", "POST", {});
    expect(a.status).toBe(202);
    expect(b.status).toBe(409);
    // Let the first end before the server closes.
    for (let n = 0; n < 600; n++) {
      const j = await call(`/api/jobs/${String(a.body.jobId)}`);
      if (j.body.state !== "running" && j.body.state !== "queued") break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });
});
