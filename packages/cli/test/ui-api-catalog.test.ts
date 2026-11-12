import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  keepCatalogsInMemory,
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

/** A route called as the app calls it, on the server `on` gives (the shared one by default). */
const callOn =
  (on: () => RunningServer) =>
  async (path: string, method = "GET", body?: unknown) => {
    const s = on();
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
type Ended = { id: string; state: string; result?: { code: number; lines: string[] } };
/** A local job followed to its end, as the app's followJob does. */
const jobOn =
  (c: ReturnType<typeof callOn>) =>
  async (path: string, body: unknown = {}): Promise<Ended> => {
    const started = await c(path, "POST", body);
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const id = String(started.body.jobId);
    for (let n = 0; n < 600; n++) {
      const j = await c(`/api/jobs/${id}`);
      if (j.body.state !== "running" && j.body.state !== "queued")
        return { ...j.body, id } as Ended;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`${path} didn't end`);
  };
const call = callOn(() => srv);
const job = jobOn(call);

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
  // As the app's server does (ui-commands.ts): catalogs read are kept until a change is heard.
  keepCatalogsInMemory(true);
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    version: "1.0.0",
    extend: (r, ctx) => extendUiRoutes(r, ctx),
  });
}, 240_000);
afterAll(async () => {
  keepCatalogsInMemory(false);
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
    const item = (
      before.body.items as { key: string; state: string; readersSha256?: string }[]
    ).find((i) => i.state === "readers-only")!;
    expect(item.readersSha256).toMatch(/^[0-9a-f]{64}$/);
    const generated = await catalog();
    // The review: a dismissal is of the readers' value the page showed, checked before a job.
    expect(
      (await call("/api/crosscheck/forge-ledger/dismiss", "POST", { key: item.key })).status,
    ).toBe(400);
    expect(
      (
        await call("/api/crosscheck/forge-ledger/dismiss", "POST", {
          key: item.key,
          sha256: "0".repeat(64),
        })
      ).status,
    ).toBe(409);
    const j = await job("/api/crosscheck/forge-ledger/dismiss", {
      key: item.key,
      sha256: item.readersSha256,
    });
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
      e.title?.startsWith("Dismiss on forge-ledger"),
    );
    expect(entry).toBeDefined();
    const lines = await call(`/api/activity/${encodeURIComponent(entry!.id)}/lines`);
    expect(JSON.stringify(lines.body)).toMatch(/dismissed/);

    const undo = await job("/api/crosscheck/forge-ledger/dismiss", { key: item.key, undo: true });
    expect(undo.state).toBe("done");
    expect((await call("/api/crosscheck/forge-ledger")).body.counts).toEqual(before.body.counts);
  });

  it("refuses a key that isn't an item now, in words, writing nothing and starting no job", async () => {
    const was = await readFile(join(root, "facts/forge-ledger.crosscheck.yaml"), "utf8");
    const r = await call("/api/crosscheck/forge-ledger/dismiss", "POST", {
      key: "Endpoint|GET /nowhere",
      sha256: "0".repeat(64),
    });
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).toMatch(/isn't an item the readers found/);
    const back = await call("/api/crosscheck/forge-ledger/dismiss", "POST", {
      key: "Endpoint|GET /nowhere",
      undo: true,
    });
    expect(back.status).toBe(404);
    expect(await readFile(join(root, "facts/forge-ledger.crosscheck.yaml"), "utf8")).toBe(was);
    expect((await call("/api/crosscheck/forge-ledger/dismiss", "POST", {})).status).toBe(400);
  });

  it("previews promote to assert, refuses a fact it didn't show, then writes it and runs verify as one job", async () => {
    const key = "Endpoint|GET /accounts/{}/balance";
    const q = `/api/crosscheck/forge-ledger/promote?key=${encodeURIComponent(key)}`;
    const v = await call(q);
    expect(v.status).toBe(200);
    // The person's fact in the facts file's shape, the reader's line at the reader's commit. No
    // clone here, so the line's text isn't shown; no facts file, so it starts from the snapshot.
    expect(v.body).toMatchObject({
      repo: "forge-ledger",
      key,
      can: true,
      factKind: "entry",
      factsFile: "facts/forge-ledger.jsonl",
      fromSnapshot: true,
      cite: {
        file: "src/main/java/forge/ledger/LedgerEndpoints.java",
        line: 8,
        value: "/accounts/{id}/balance",
        commit: "a".repeat(40),
      },
    });
    expect(v.body.cite.text).toBeUndefined();
    expect(JSON.parse(v.body.line as string)).toMatchObject({ by: "person", verified: "none" });
    expect(v.body.next).toBeUndefined();
    const no = await call(
      `/api/crosscheck/forge-ledger/promote?key=${encodeURIComponent("IndexConstraint|ledger-db.account.pk")}`,
    );
    expect(no.body).toMatchObject({ can: false });
    expect(no.body.why).toMatch(/isn't one fact/);
    expect((await call("/api/crosscheck/forge-ledger/promote")).status).toBe(400);
    expect((await call(`/api/crosscheck/no-such-repo/promote?key=x`)).status).toBe(404);
    const generated = await catalog();
    const facts = join(root, "facts/forge-ledger.jsonl");
    // Confirms exactly the fact shown: another hash writes nothing.
    const wrong = await call("/api/crosscheck/forge-ledger/promote", "POST", {
      key,
      sha256: "0".repeat(64),
    });
    expect(wrong.status).toBe(409);
    expect(existsSync(facts)).toBe(false);
    const j = await job("/api/crosscheck/forge-ledger/promote", { key, sha256: v.body.sha256 });
    // The fact is written; verify then needs the repo's checkout, which this metarepo hasn't.
    expect(j.state).toBe("failed");
    const said = j.result!.lines.join(" ");
    expect(said).toMatch(/promoted Endpoint\|GET \/accounts\/\{\}\/balance to your own fact/);
    expect(await readFile(facts, "utf8")).toContain(v.body.line as string);
    // Nothing in the catalog or the slots changed: verify --write does that, on Apply.
    expect(await catalog()).toEqual(generated);
    const after = await call("/api/crosscheck/forge-ledger");
    const item = (after.body.items as { key: string; promoted?: unknown }[]).find(
      (i) => i.key === key,
    );
    expect(item?.promoted).toMatchObject({
      fact: v.body.fact,
      state: "written",
      file: "src/main/java/forge/ledger/LedgerEndpoints.java",
      line: 8,
    });
    const activity = await call("/api/activity");
    expect(
      (activity.body.entries as { title?: string }[]).some(
        (e) => e.title === "Promote on forge-ledger",
      ),
    ).toBe(true);
    await rm(facts);
  });
});

describe("the build's confirm steps", () => {
  it("says the catalog is what the slots build, and what the last build wrote", async () => {
    const r = await call("/api/build");
    expect(r.status).toBe(200);
    expect(r.body.pending).toMatchObject({ upToDate: true, removals: [] });
    expect(r.body.pending.refused).toBeUndefined();
    // The first build's own report (CS2's build-report.json): written, every record added.
    expect(r.body.last).toMatchObject({
      command: "atticus catalog build",
      outcome: "written",
      generated: "catalog/generated",
      run: [],
    });
    expect(r.body.last.added.length).toBeGreaterThan(10);
    expect(r.body.last.counts.added).toBe(r.body.last.added.length);
    expect(r.body.last.added[0]).toMatchObject({
      path: expect.stringMatching(/^catalog\/generated\//),
    });
    expect(r.body.upgrade).toBeUndefined();
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
    const plan = r.body.pending.plan as string;
    expect(plan).toMatch(/^[0-9a-f]{64}$/);
    expect((await call("/api/build/edits/curate", "POST", { count: 2, plan })).status).toBe(409);
    expect(
      (await call("/api/build/edits/curate", "POST", { count: 1, plan: "0".repeat(64) })).status,
    ).toBe(409);
    expect((await call("/api/build/edits/curate", "POST", { count: 1 })).status).toBe(400);
    expect(await catalog()).toEqual(before);
    const renamed = /^name: (.+-renamed)$/m.exec(await readFile(path, "utf8"))![1]!;
    const j = await job("/api/build/edits/curate", { count: 1, plan });
    expect(j.result!.lines.join(" ")).toMatch(/Wrote catalog\/curated\//);
    const after = (await call("/api/build")).body;
    expect(
      after.pending.upToDate,
      JSON.stringify({ lines: j.result!.lines, pending: after.pending }),
    ).toBe(true);
    // ADR 0195 (d): the build in the same job as the curate (the server keeps catalogs read in
    // memory) reads the decision it follows, so the hand edit's effect is kept, not overwritten.
    expect(await readFile(path, "utf8")).toMatch(new RegExp(`^name: ${renamed}$`, "m"));
    expect(after.last).toMatchObject({ command: "atticus catalog build", outcome: "written" });
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
    // The same build run in a terminal refuses, and its report is the page's last build: the
    // reasons, each removal with why, and the command that confirms it.
    const out: string[] = [];
    expect(
      await catalogBuild(root, {}, { out: (l) => out.push(l), err: (l) => out.push(l) }),
    ).not.toBe(0);
    const last = (await call("/api/build")).body.last;
    expect(last).toMatchObject({
      command: "atticus catalog build",
      outcome: "refused",
      refused: { reasons: ["large-removals"], allowRemovals: n },
      run: [`atticus catalog build --allow-removals ${n}`],
      counts: { removed: n, written: 0 },
    });
    expect(last.refused.command).toBe(`atticus catalog build --allow-removals ${n}`);
    expect(last.removed).toHaveLength(n);
    for (const x of last.removed) {
      expect(x.reasons).toContain("slot");
      expect(x.explainedBy.join(" ")).toMatch(/slot changed/);
    }
    const before = await catalog();
    const plan = r.body.pending.plan as string;
    // The review: a confirm is of the list shown (409 before a job on another), and names it.
    expect((await call("/api/build", "POST", { allowRemovals: n })).status).toBe(400);
    expect(
      (await call("/api/build", "POST", { allowRemovals: n, plan: "0".repeat(64) })).status,
    ).toBe(409);
    const wrong = await job("/api/build", { allowRemovals: n + 1, plan });
    expect(wrong.state).toBe("failed");
    expect(wrong.result!.lines.join(" ")).toMatch(new RegExp(`doesn't name the ${n} listed`));
    expect(await catalog()).toEqual(before);
    const ok = await job("/api/build", { allowRemovals: n, plan });
    expect(ok.state).toBe("done");
    const after = await call("/api/build");
    expect(after.body.pending.upToDate).toBe(true);
    expect(after.body.last).toMatchObject({ outcome: "written", counts: { removed: n } });
    expect(after.body.last.removed).toHaveLength(n);
    expect(after.body.last.undo).toBeGreaterThan(0);
  });

  it("lists the undo copies and puts back exactly the files listed", async () => {
    const before = await catalog();
    const v = await call("/api/build/undo");
    expect(v.status).toBe(200);
    expect(v.body.copies.length).toBeGreaterThanOrEqual(3);
    const plan = v.body.plan as { n: number; files: unknown[]; hash: string };
    expect(plan.n).toBe(v.body.copies[0].n);
    expect(plan.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      (await call("/api/build/undo", "POST", { n: plan.n, files: 0, plan: plan.hash })).status,
    ).toBe(409);
    expect(
      (
        await call("/api/build/undo", "POST", {
          n: plan.n,
          files: plan.files.length,
          plan: "0".repeat(64),
        })
      ).status,
    ).toBe(409);
    expect(
      (await call("/api/build/undo", "POST", { n: 6, files: 1, plan: plan.hash })).status,
    ).toBe(400);
    expect(await catalog()).toEqual(before);
    const j = await job("/api/build/undo", {
      n: plan.n,
      files: plan.files.length,
      plan: plan.hash,
    });
    expect(j.state).toBe("done");
    expect(j.result!.lines.join(" ")).toMatch(/Put back/);
    // The large removal is taken back: its records are there again.
    const now = await catalog();
    expect(Object.keys(now.generated).length).toBeGreaterThan(Object.keys(before.generated).length);
    expect((await call("/api/build/undo?n=x")).status).toBe(400);
  });

  it("previews prune and removes exactly the files listed", async () => {
    expect((await call("/api/build/prune")).body.files).toEqual([]);
    const manifest = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
    const m = await readFile(manifest, "utf8");
    await writeFile(
      manifest,
      m.replace(/( {2}- id: forge-reports-job\n)/, "$1    archived: true\n"),
    );
    const v = await call("/api/build/prune");
    expect(v.body.files).toEqual([
      {
        path: "catalog/sources/readers/forge-reports-job.json",
        why: "forge-reports-job is archived",
      },
    ]);
    const plan = v.body.plan as string;
    expect((await call("/api/build/prune", "POST", { count: 2, plan })).status).toBe(409);
    expect(
      (await call("/api/build/prune", "POST", { count: 1, plan: "0".repeat(64) })).status,
    ).toBe(409);
    expect(existsSync(readersSlotPath(root, "forge-reports-job"))).toBe(true);
    const j = await job("/api/build/prune", { count: 1, plan });
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

describe("a removal an answer explains is listed as the person's own action", () => {
  it("names the input that changed, an answer as such, in the last build's report", async () => {
    const undoDir = await undoDirOf(root);
    const report = await readBuildReport(root);
    expect(report).toBeDefined();
    const removal = {
      path: "catalog/generated/interface/if-ledger-to-notify.yaml",
      kind: "Interface",
      id: "if-ledger-to-notify",
      repos: ["forge-ledger"],
      explainedBy: ["an input changed (questions)"],
      reasons: ["input" as const],
    };
    try {
      await writeBuildReport(undoDir, {
        ...report!,
        command: "atticus verify forge-ledger --write",
        removed: [removal],
        counts: { ...report!.counts, removed: 1 },
      });
      const last = (await call("/api/build")).body.last;
      expect(last.command).toBe("atticus verify forge-ledger --write");
      expect(last.removed).toEqual([
        { ...removal, inputs: [{ what: "answers", path: "questions" }] },
      ]);
    } finally {
      await writeBuildReport(undoDir, report!);
    }
  });
});

describe("the upgrade to source slots as the app's confirm step (ADR 0195 point 6)", () => {
  let up: string;
  let upSrv: RunningServer;
  const callUp = callOn(() => upSrv);
  const jobUp = jobOn(callUp);
  beforeAll(async () => {
    // A catalog from before beta.27: the golden slots built, then catalog/sources and the state
    // folder's build files taken away, so catalog/generated is all there is.
    up = await mkdtemp(join(tmpdir(), "atticus-cs3-upgrade-"));
    await cp(join(FORGE, "metarepo/org-pack"), join(up, "org-pack"), { recursive: true });
    await writeFile(join(up, "org-pack/sources.yaml"), "schemaVersion: 1\nwikis: []\n");
    await cp(join(SLOTS, "readers"), join(up, "catalog/sources/readers"), { recursive: true });
    expect(await catalogBuild(up, {}, quiet)).toBe(0);
    await rm(join(up, "catalog/sources"), { recursive: true });
    await rm(join(up, ".index"), { recursive: true, force: true });
    upSrv = await startServer({
      root: up,
      port: 0,
      user: "pat",
      version: "1.0.0",
      extend: (r, ctx) => extendUiRoutes(r, ctx),
    });
  }, 240_000);
  afterAll(async () => {
    await upSrv?.close();
    await rm(up, { recursive: true, force: true });
  });

  it("shows every file it writes and the copy it keeps, writes nothing on another plan, then upgrades", async () => {
    const before = await tree(join(up, "catalog/generated"));
    const b = await callUp("/api/build");
    expect(b.body.upgrade).toBe(true);
    expect(b.body.pending.refused.reasons).toContain("not-upgraded");
    // The upgrade's other steps wait here: they may change an input the slots record, so this
    // step waits for them (Run the upgrade, POST /api/upgrade, runs them and only shows this one).
    const first = await callUp("/api/build/upgrade");
    if (first.body.others.length) {
      const plan = { count: first.body.writes.length, plan: first.body.plan };
      expect((await callUp("/api/build/upgrade", "POST", plan)).status).toBe(409);
      expect(existsSync(join(up, "catalog/sources"))).toBe(false);
      const settings = await jobUp("/api/upgrade", {});
      expect(settings.state, settings.result?.lines.join("\n")).toBe("done");
      expect(existsSync(join(up, "catalog/sources"))).toBe(false);
    }
    const v = await callUp("/api/build/upgrade");
    expect(v.body.others).toEqual([]);
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({
      pending: true,
      applies: true,
      firstBuildChanges: [],
      run: "atticus upgrade --yes",
      copy: {
        dir: "catalog/sources/legacy/generated-before-upgrade",
        files: Object.keys(before).length,
      },
    });
    expect(v.body.records).toBe(Object.keys(before).length);
    const n = v.body.writes.length as number;
    expect(n).toBeGreaterThan(Object.keys(before).length);
    expect(v.body.plan).toMatch(/^[0-9a-f]{64}$/);
    // Nothing is written by looking, or by a confirm of another count or another plan.
    expect(existsSync(join(up, "catalog/sources"))).toBe(false);
    for (const wrong of [
      { count: n + 1, plan: v.body.plan },
      { count: n, plan: "0".repeat(64) },
    ])
      expect((await callUp("/api/build/upgrade", "POST", wrong)).status).toBe(409);
    expect((await callUp("/api/build/upgrade", "POST", { count: n })).status).toBe(400);
    expect(existsSync(join(up, "catalog/sources"))).toBe(false);
    const j = await jobUp("/api/build/upgrade", { count: n, plan: v.body.plan });
    expect(j.state, j.result?.lines.join("\n")).toBe("done");
    // Exactly the files listed, with the hashes listed; catalog/generated byte for byte.
    const { createHash } = await import("node:crypto");
    const written = await tree(join(up, "catalog/sources"));
    expect(
      Object.keys(written)
        .map((p) => `catalog/sources/${p}`)
        .sort(),
    ).toEqual((v.body.writes as { path: string }[]).map((w) => w.path).sort());
    for (const w of v.body.writes as { path: string; sha256: string }[])
      expect(
        createHash("sha256")
          .update(written[w.path.slice("catalog/sources/".length)]!)
          .digest("hex"),
      ).toBe(w.sha256);
    expect(await tree(join(up, "catalog/generated"))).toEqual(before);
    const after = await callUp("/api/build");
    expect(after.body.upgrade).toBeUndefined();
    expect(after.body.pending.upToDate).toBe(true);
    expect((await callUp("/api/build/upgrade")).body.pending).toBe(false);
    const again = await callUp("/api/build/upgrade", "POST", { count: n, plan: v.body.plan });
    expect(again.status).toBe(409);
  });
});

describe("an upgrade whose first build changes the catalog waits for the count of its changes (ADR 0195 point 6)", () => {
  let up: string;
  let upSrv: RunningServer;
  const callUp = callOn(() => upSrv);
  const jobUp = jobOn(callUp);
  beforeAll(async () => {
    // A catalog from before beta.27 that lacks a record the build makes from the org pack alone
    // (the vendor's System): the upgrade's first build adds it, so --yes waits for
    // --accept-changes 1, as CS2's CLI does.
    up = await mkdtemp(join(tmpdir(), "atticus-cs3-accept-"));
    await cp(join(FORGE, "metarepo/org-pack"), join(up, "org-pack"), { recursive: true });
    await writeFile(join(up, "org-pack/sources.yaml"), "schemaVersion: 1\nwikis: []\n");
    await cp(join(SLOTS, "readers"), join(up, "catalog/sources/readers"), { recursive: true });
    expect(await catalogBuild(up, {}, quiet)).toBe(0);
    await rm(join(up, "catalog/sources"), { recursive: true });
    await rm(join(up, ".index"), { recursive: true, force: true });
    await rm(join(up, "catalog/generated/system/northwind-pay.yaml"));
    upSrv = await startServer({
      root: up,
      port: 0,
      user: "pat",
      version: "1.0.0",
      extend: (r, ctx) => extendUiRoutes(r, ctx),
    });
    // The upgrade's other steps run first (Run the upgrade), as the page offers.
    if ((await callUp("/api/build/upgrade")).body.others.length) {
      const settings = await jobUp("/api/upgrade", {});
      expect(settings.state, settings.result?.lines.join("\n")).toBe("done");
    }
  }, 240_000);
  afterAll(async () => {
    await upSrv?.close();
    await rm(up, { recursive: true, force: true });
  });

  it("lists each change, refuses without the count or with another, then upgrades with it", async () => {
    const before = await tree(join(up, "catalog/generated"));
    const v = await callUp("/api/build/upgrade");
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({
      pending: true,
      applies: false,
      others: [],
      changes: [{ path: "system/northwind-pay.yaml", how: "added" }],
      acceptChanges: 1,
      firstBuildChanges: ["system/northwind-pay.yaml"],
      run: "atticus upgrade --yes --accept-changes 1",
    });
    const n = v.body.writes.length as number;
    const plan = v.body.plan as string;
    // Without the count of changes, or with another, nothing is written.
    for (const wrong of [
      { count: n, plan },
      { count: n, plan, acceptChanges: 2 },
    ])
      expect((await callUp("/api/build/upgrade", "POST", wrong)).status).toBe(409);
    expect(
      (await callUp("/api/build/upgrade", "POST", { count: n, plan, acceptChanges: 0 })).status,
    ).toBe(400);
    expect(existsSync(join(up, "catalog/sources"))).toBe(false);
    expect(await tree(join(up, "catalog/generated"))).toEqual(before);
    // Accepted with their count: the slots, the copy of the catalog as it was, and the first
    // build's catalog (the change it listed) are written, with an undo copy.
    const j = await jobUp("/api/build/upgrade", { count: n, plan, acceptChanges: 1 });
    expect(j.state, j.result?.lines.join("\n")).toBe("done");
    expect(existsSync(join(up, "catalog/sources/build.json"))).toBe(true);
    const after = await tree(join(up, "catalog/generated"));
    expect(Object.keys(after).sort()).toEqual(
      [...Object.keys(before), "system/northwind-pay.yaml"].sort(),
    );
    for (const [p, text] of Object.entries(before)) expect(after[p]).toBe(text);
    expect(await tree(join(up, "catalog/sources/legacy/generated-before-upgrade"))).toEqual(before);
    const b = await callUp("/api/build");
    expect(b.body.upgrade).toBeUndefined();
    expect(b.body.pending.upToDate).toBe(true);
    // Its undo copy, for Catalog builds' Undo (every write can be undone, point 7).
    expect((await callUp("/api/build/undo")).body.copies[0]).toMatchObject({
      command: "atticus upgrade --yes --accept-changes 1",
    });
  });
});
