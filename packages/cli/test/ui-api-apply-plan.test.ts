import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, type CatalogRecord } from "@maycombhq/core";
import {
  parseReadersSlot,
  readBuildReport,
  readersSlotPath,
  serializeReadersSlot,
  undoDirOf,
  writeBuildReport,
} from "@maycombhq/scanner";
import { startServer, type RunningServer } from "@maycombhq/server";
import { catalogBuild } from "../src/catalog-build-commands.js";
import { extendUiRoutes } from "../src/ui-commands.js";
import { verifyCommand } from "../src/verify-commands.js";
import { seedReadersSlots } from "./seed-slots.js";

/**
 * ADR 0195 point 4, the review of beta.27: a confirm is of the list shown. Apply (POST
 * /api/facts/{repo}/apply, `verify <repo> --write`) and a scan's confirm (POST /api/scan) send
 * the plan of the refusal they confirm, as POST /api/build does: the refused job's result carries
 * it, a count without it is a 400, the route compares it with the latest build's own report
 * before a job starts (409), and the command compares it again under the scan's lock, so a writer
 * between the refusal and the confirm (a correction, a terminal's scan or build) can never make
 * the confirmed run remove records the page didn't list. Invented Forge estate (CLAUDE.md rule
 * 3); no network (rule 5).
 */

const VERIFY = join(__dirname, "..", "..", "verify", "test", "fixtures");
const META = join(VERIFY, "metarepo");
const quiet = { out: () => undefined, err: () => undefined };
const made: string[] = [];
const servers: RunningServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })));
});

/** The verify fixtures' metarepo: the readers' records as slots, built once, and the ledger's facts. */
async function metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-apply-plan-"));
  made.push(root);
  cpSync(join(META, "org-pack"), join(root, "org-pack"), { recursive: true });
  cpSync(join(META, "catalog"), join(root, "catalog"), { recursive: true });
  cpSync(join(VERIFY, "repo"), join(root, "workspace", "forge-ledger"), { recursive: true });
  const raw = (parse(readFileSync(join(META, "scan-before.yaml"), "utf8")) as object[]).map((x) => {
    const p = parseRecord({ schemaVersion: 2, status: "current", ...x });
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    return p.record;
  });
  await seedReadersSlots(root, raw);
  mkdirSync(join(root, "facts"), { recursive: true });
  writeFileSync(
    join(root, "facts", "forge-ledger.jsonl"),
    readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8"),
  );
  return root;
}

async function serve(root: string) {
  const s = await startServer({
    root,
    port: 0,
    user: "pat",
    version: "1.0.0",
    extend: (r, ctx) => extendUiRoutes(r, ctx),
  });
  servers.push(s);
  const call = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(s.url + path, {
      method,
      headers: {
        "X-Atticus-Token": s.token,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any -- a route's JSON, read loosely
  };
  type Ended = {
    state: string;
    result?: { code: number; lines: string[]; refused?: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any -- a job's result, read loosely
  };
  const job = async (path: string, body: unknown = {}): Promise<Ended> => {
    const started = await call(path, "POST", body);
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const id = String(started.body.jobId);
    for (let n = 0; n < 1200; n++) {
      const j = await call(`/api/jobs/${id}`);
      if (j.body.state !== "running" && j.body.state !== "queued") return j.body as Ended;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`${path} didn't end`);
  };
  return { call, job, jobs: s.jobs };
}

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
const catalog = async (root: string) => ({
  generated: await tree(join(root, "catalog/generated")),
  sources: await tree(join(root, "catalog/sources")),
  facts: await tree(join(root, "facts")),
});

const APPLY = "/api/facts/forge-ledger/apply";
const T = 240_000;

/**
 * A writer between the refusal and the confirm that keeps the count and changes the list: one
 * record the Apply listed (A) leaves the ledger's readers slot and another (C) comes in, and a
 * terminal's `atticus catalog build` writes it. The Apply now removes C, never shown, not A.
 */
async function swapOneRemoval(root: string, listed: { kind: string; id: string; path: string }[]) {
  const path = readersSlotPath(root, "forge-ledger");
  const p = parseReadersSlot(await readFile(path, "utf8"), "forge-ledger");
  if (!p.ok) throw new Error("slot");
  const ids = new Set(listed.map((x) => x.id));
  const a = p.slot.records.find((r) => ids.has(r.id) && r.kind !== "Interface");
  if (!a) throw new Error("no record of the ledger's own among the removals");
  // Another record of the same kind: a new id, and for an endpoint another path, as the merge
  // knows an endpoint by its method and path.
  const at = a as CatalogRecord & { pathOrTopic?: string; normalizedPath?: string };
  const c = {
    ...a,
    id: `${a.id}-again`,
    ...(at.pathOrTopic ? { pathOrTopic: `${at.pathOrTopic}/again` } : {}),
    ...(at.normalizedPath ? { normalizedPath: `${at.normalizedPath}/again` } : {}),
  } as CatalogRecord;
  await writeFile(
    path,
    serializeReadersSlot({
      ...p.slot,
      records: [...p.slot.records.filter((r) => r.id !== a.id), c].sort((x, y) =>
        x.kind === y.kind ? (x.id < y.id ? -1 : 1) : x.kind < y.kind ? -1 : 1,
      ),
    }),
  );
  // A terminal's build, its own removal of A confirmed with its count.
  if ((await catalogBuild(root, {}, quiet)) !== 0) {
    const n = (await readBuildReport(root))?.refused?.allowRemovals;
    expect(n).toBe(1);
    expect(await catalogBuild(root, { allowRemovals: n! }, quiet)).toBe(0);
  }
  return { a: `catalog/generated/${recordPath(a)}` };
}

describe("Apply confirms exactly the list its refusal showed (POST /api/facts/{repo}/apply)", () => {
  it(
    "carries the refusal's plan in the job's result; a count needs it, and a wrong count or plan writes nothing",
    async () => {
      const root = await metarepo();
      const { call, job } = await serve(root);
      const first = await job(APPLY);
      const refused = first.result!.refused!;
      expect(refused.reasons).toEqual(["large-removals"]);
      expect(refused.plan).toMatch(/^[0-9a-f]{64}$/);
      // The plan is of the list the build refused with: GET /api/build's own hash of it, as the
      // latest build's report says it.
      expect((await call("/api/build")).body.last.refused.plan).toBe(refused.plan);
      const n = refused.allowRemovals as number;
      const plan = refused.plan as string;
      const before = await catalog(root);
      expect((await call(APPLY, "POST", { allowRemovals: n })).status).toBe(400);
      expect((await call(APPLY, "POST", { discardEdits: 1 })).status).toBe(400);
      expect((await call(APPLY, "POST", { allowRemovals: n, plan: "0".repeat(64) })).status).toBe(
        409,
      );
      expect(await catalog(root)).toEqual(before);
      const wrong = await job(APPLY, { allowRemovals: n + 1, plan });
      expect(wrong.result!.code).not.toBe(0);
      expect(wrong.result!.lines.join(" ")).toMatch(new RegExp(`doesn't name the ${n} listed`));
      // Refused again with the same list: the same plan, so the right count still confirms it.
      expect(wrong.result!.refused!.plan).toBe(plan);
      expect(await catalog(root)).toEqual(before);
      const ok = await job(APPLY, { allowRemovals: n, plan });
      expect(ok.result!.code, ok.result!.lines.join("\n")).toBe(0);
      expect((await call("/api/build")).body.last).toMatchObject({
        command: "atticus verify forge-ledger --write",
        outcome: "written",
        counts: { removed: n },
      });
    },
    T,
  );

  it(
    "a writer that changes the list between the refusal and the confirm makes the confirm write nothing",
    async () => {
      const root = await metarepo();
      const { call, job } = await serve(root);
      const first = await job(APPLY);
      const refused = first.result!.refused!;
      const n = refused.allowRemovals as number;
      const plan = refused.plan as string;
      const report = await readBuildReport(root);
      const { a } = await swapOneRemoval(root, refused.removals);
      const swapped = await catalog(root);
      // The route's own check: the latest build is no longer the refusal the page showed.
      const conflict = await call(APPLY, "POST", { allowRemovals: n, plan });
      expect(conflict.status).toBe(409);
      expect(String(conflict.body.detail)).toMatch(/isn't what the page listed any more/);
      expect(await catalog(root)).toEqual(swapped);
      // A writer after the route's check and before the job takes the lock: the command works
      // the list out again under the lock and writes nothing, though the count is the same.
      await writeBuildReport(await undoDirOf(root), report!);
      const late = await job(APPLY, { allowRemovals: n, plan });
      expect(late.result!.code).not.toBe(0);
      expect(late.result!.lines.join("\n")).toMatch(
        /Nothing written: .* isn't what the page listed any more/,
      );
      expect(await catalog(root)).toEqual(swapped);
      // Its result lists what the build would remove now, with its own plan: as many, not A.
      const now = late.result!.refused!;
      expect(now.allowRemovals).toBe(n);
      expect(now.plan).not.toBe(plan);
      const paths = (now.removals as { path: string }[]).map((x) => x.path);
      expect(paths).toHaveLength(n);
      expect(paths).not.toContain(a);
      expect(paths).not.toEqual((refused.removals as { path: string }[]).map((x) => x.path));
      const ok = await job(APPLY, { allowRemovals: n, plan: now.plan });
      expect(ok.result!.code, ok.result!.lines.join("\n")).toBe(0);
    },
    T,
  );

  it(
    "verify --write with the app's plan, under the lock: another list writes nothing (no flag takes it)",
    async () => {
      const root = await metarepo();
      const said: string[] = [];
      const io = { out: (l: string) => said.push(l), err: (l: string) => said.push(l) };
      expect(await verifyCommand(root, "forge-ledger", { write: true }, io)).toBe(1);
      const report = (await readBuildReport(root))!;
      const listed = report.refused!.removals!;
      const n = report.refused!.allowRemovals!;
      const { lastBuildOf } = await import("../src/build-report.js");
      const plan = (await lastBuildOf(root))!.refused!.plan!;
      await swapOneRemoval(root, listed);
      const swapped = await catalog(root);
      said.length = 0;
      expect(
        await verifyCommand(root, "forge-ledger", { write: true, allowRemovals: n, plan }, io),
      ).toBe(1);
      expect(said.join("\n")).toMatch(/Nothing written: .* isn't what the page listed any more/);
      expect(await catalog(root)).toEqual(swapped);
    },
    T,
  );
});

describe("an Apply that leaves rejected facts out is applied, with their count (beta.28.1)", () => {
  it(
    "its job ends done, code 0, with leftOut and a line naming each fact left out",
    async () => {
      const root = await metarepo();
      const { job } = await serve(root);
      const first = await job(APPLY);
      const refused = first.result!.refused!;
      const ok = await job(APPLY, { allowRemovals: refused.allowRemovals, plan: refused.plan });
      expect(ok.result!.code, ok.result!.lines.join("\n")).toBe(0);
      expect((ok.result as { leftOut?: number }).leftOut).toBeUndefined();
      // One fact verify rejects, added to the read: the rest is written, it is left out.
      const bad = readFileSync(join(VERIFY, "redteam.facts.jsonl"), "utf8").split("\n")[0]!;
      const facts = join(root, "facts", "forge-ledger.jsonl");
      writeFileSync(facts, readFileSync(facts, "utf8") + bad + "\n");
      const id = (JSON.parse(bad) as { id: string }).id;
      const left = await job(APPLY);
      expect(left.state).toBe("done");
      expect(left.result!.code, left.result!.lines.join("\n")).toBe(0);
      expect((left.result as { leftOut?: number }).leftOut).toBe(1);
      expect(left.result!.lines.join("\n")).toMatch(new RegExp(`left out: ${id} \\(`));
    },
    T,
  );

  it(
    "12 facts left out are counted 12, not the 5 lines shown (the hunt of beta.28.1, S1)",
    async () => {
      const root = await metarepo();
      const { job } = await serve(root);
      const first = await job(APPLY);
      const refused = first.result!.refused!;
      const ok = await job(APPLY, { allowRemovals: refused.allowRemovals, plan: refused.plan });
      expect(ok.result!.code, ok.result!.lines.join("\n")).toBe(0);
      const bad = JSON.parse(
        readFileSync(join(VERIFY, "redteam.facts.jsonl"), "utf8").split("\n")[0]!,
      ) as { id: string };
      const facts = join(root, "facts", "forge-ledger.jsonl");
      const twelve = Array.from({ length: 12 }, (_, i) =>
        JSON.stringify({ ...bad, id: `${bad.id}-${i + 1}` }),
      );
      writeFileSync(facts, readFileSync(facts, "utf8") + twelve.join("\n") + "\n");
      const left = await job(APPLY);
      expect(left.result!.code, left.result!.lines.join("\n")).toBe(0);
      expect((left.result as { leftOut?: number }).leftOut).toBe(12);
    },
    T,
  );
});

describe("a scan's confirm sends the plan of the refusal it confirms (POST /api/scan)", () => {
  it(
    "a count needs the plan, and a plan that isn't the latest refused scan's starts no scan",
    async () => {
      const root = await metarepo();
      const { call, jobs } = await serve(root);
      expect((await call("/api/scan", "POST", { allowRemovals: 3 })).status).toBe(400);
      expect((await call("/api/scan", "POST", { discardEdits: 1 })).status).toBe(400);
      const r = await call("/api/scan", "POST", { allowRemovals: 3, plan: "0".repeat(64) });
      expect(r.status).toBe(409);
      expect(String(r.body.detail)).toMatch(/isn't what the page listed any more/);
      expect(jobs.list()).toEqual([]);
    },
    T,
  );
});
