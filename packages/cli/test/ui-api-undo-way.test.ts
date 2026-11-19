import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import {
  keepCatalogsInMemory,
  parseReadersSlot,
  readersSlotPath,
  serializeReadersSlot,
} from "@maycombhq/scanner";
import { startServer, type RunningServer } from "@maycombhq/server";
import { undoMark, undoWayOf } from "../src/build-report.js";
import { catalogBuild } from "../src/catalog-build-commands.js";
import { extendUiRoutes } from "../src/ui-commands.js";

/**
 * ADR 0202 point 3: a local job that ends failed or refused, and a build route's 409, carry
 * `undo` when a build can be taken back: what GET /api/build/undo?n=1 would confirm (n, files,
 * the plan's hash), that undo copy's command and time, and whether the job that failed took it
 * (`ofThis`). After a refusal nothing was written, so it is an earlier, good build's. The Forge
 * estate's golden slots; no network.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const quiet = { out: () => undefined, err: () => undefined };

let root: string;
let srv: RunningServer;
const on =
  (s: () => RunningServer) =>
  async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(s().url + path, {
      method,
      headers: {
        "X-Atticus-Token": s().token,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any -- a route's JSON, read loosely
  };
const call = on(() => srv);
const jobOf = async (c: ReturnType<typeof on>, path: string, body: unknown = {}) => {
  const started = await c(path, "POST", body);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  for (let n = 0; n < 1200; n++) {
    const j = await c(`/api/jobs/${String(started.body.jobId)}`);
    if (j.body.state !== "running" && j.body.state !== "queued") return Api.Job.parse(j.body);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${path} didn't end`);
};
const serve = (at: string) =>
  startServer({
    root: at,
    port: 0,
    user: "pat",
    version: "1.0.0",
    watch: false,
    extend: (r, ctx) => extendUiRoutes(r, ctx),
  });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-undo-way-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await writeFile(join(root, "org-pack/sources.yaml"), "schemaVersion: 1\nwikis: []\n");
  await cp(join(FORGE, "slots/readers"), join(root, "catalog/sources/readers"), {
    recursive: true,
  });
  await cp(join(FORGE, "slots/facts"), join(root, "catalog/sources/facts"), { recursive: true });
  await mkdir(join(root, "facts"), { recursive: true });
  expect(await catalogBuild(root, {}, quiet)).toBe(0);
  // A second build that rewrites records, so there is a build to take back: a repo's slot loses
  // most of its records, confirmed with the count the refusal names.
  const slot = readersSlotPath(root, "forge-gateway");
  const p = parseReadersSlot(await readFile(slot, "utf8"), "forge-gateway");
  if (!p.ok) throw new Error("slot");
  await writeFile(slot, serializeReadersSlot({ ...p.slot, records: p.slot.records.slice(0, 1) }));
  keepCatalogsInMemory(true);
  srv = await serve(root);
  const refused = (await call("/api/build")).body.pending;
  const n = refused.refused.allowRemovals as number;
  const built = await jobOf(call, "/api/build", { allowRemovals: n, plan: refused.plan });
  expect(built.state).toBe("done");
  // A build that ended well offers no undo of itself as a way on from an error.
  expect(built.result!.undo).toBeUndefined();
}, 300_000);
afterAll(async () => {
  keepCatalogsInMemory(false);
  await srv.close();
});

/** A file of catalog/generated changed by hand: the next build refuses (hand-edits). */
async function handEdit(): Promise<void> {
  const dir = join(root, "catalog/generated/table");
  const file = join(dir, (await readdir(dir)).sort()[0]!);
  const text = await readFile(file, "utf8");
  await writeFile(file, text.replace(/^name: (.+)$/m, "name: $1-by-hand"));
}

describe("undo as a way on from a failed or refused build (ADR 0202 point 3)", () => {
  it("a refused build carries the earlier build's undo, not its own; a 409 carries it too; a stale plan is 409", async () => {
    await handEdit();
    const listed = (await call("/api/build/undo?n=1")).body;
    const j = await jobOf(call, "/api/build");
    expect(j.state).toBe("failed");
    expect((j.result!.lines as string[]).join(" ")).toMatch(/--discard-edits 1/);
    const way = Api.UndoWay.parse(j.result!.undo);
    expect(way).toEqual({
      n: 1,
      files: listed.plan.files.length,
      plan: listed.plan.hash,
      command: listed.copies[0].command,
      at: listed.copies[0].at,
      ofThis: false,
    });
    expect(way.command).toBe("atticus catalog build");
    expect(way.plan).toMatch(/^[0-9a-f]{64}$/);

    // A build route's 409 (a confirm of a list that isn't the one shown) carries the same.
    const conflict = await call("/api/build", "POST", { discardEdits: 1, plan: "0".repeat(64) });
    expect(conflict.status).toBe(409);
    expect(Api.Problem.parse(conflict.body).undo).toEqual(way);

    // A job that took an undo copy itself: ofThis. (Worked out as a job does: the newest copy
    // before the work, then the way after it.)
    const mark = await undoMark(root);
    const pending = (await call("/api/build")).body.pending;
    expect(
      await catalogBuild(
        root,
        { discardEdits: pending.refused.discardEdits as number, plan: pending.plan as string },
        quiet,
      ),
    ).toBe(0);
    const mine = await undoWayOf(root, { mark });
    expect(mine).toMatchObject({ n: 1, ofThis: true });
    expect(mine!.command).toBe("atticus catalog build");
    expect((await undoWayOf(root, { mark: await undoMark(root) }))!.ofThis).toBe(false);
    expect((await undoWayOf(root))!.ofThis).toBe(false);

    // The list changed meanwhile: the way the refusal carried is refused, as today.
    const stale = await call("/api/build/undo", "POST", {
      n: way.n,
      files: way.files,
      plan: way.plan,
    });
    expect(stale.status).toBe(409);
    // The one of now is taken, on the person's confirm.
    const undone = await jobOf(call, "/api/build/undo", {
      n: mine!.n,
      files: mine!.files,
      plan: mine!.plan,
    });
    expect(undone.state).toBe("done");
  }, 300_000);

  it("a fresh metarepo, with no build to take back, carries none", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "atticus-undo-way-fresh-"));
    await cp(join(FORGE, "metarepo/org-pack"), join(fresh, "org-pack"), { recursive: true });
    await writeFile(join(fresh, "org-pack/sources.yaml"), "schemaVersion: 1\nwikis: []\n");
    expect(await undoWayOf(fresh)).toBeUndefined();
    const s = await serve(fresh);
    try {
      const c = on(() => s);
      const conflict = await c("/api/build", "POST", { discardEdits: 1, plan: "0".repeat(64) });
      expect(conflict.status).toBe(409);
      expect(conflict.body.undo).toBeUndefined();
    } finally {
      await s.close();
    }
  }, 120_000);
});
