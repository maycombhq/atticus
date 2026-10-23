import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiHistoryRoutes } from "../src/ui-api-history.js";

/**
 * ADR 0110: the prompt and response history in the local API, read-only: the turns (a prompt
 * with the response that followed it), filtered by change, session and words, and one record
 * with its pair. Invented Forge data (fixtures/history).
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/history");
let root: string;
let srv: RunningServer;
const call = async (path: string) => {
  const r = await fetch(srv.url + path, { headers: { "X-Atticus-Token": srv.token } });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  root = join(await mkdtemp(join(tmpdir(), "atticus-ui-history-")), "meta");
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeFile(join(root, "org-pack", "sources.yaml"), "schemaVersion: 1\n");
  await mkdir(join(root, ".atticus", "history"), { recursive: true });
  for (const f of ["2026-09.jsonl", "2026-10.jsonl"])
    await copyFile(join(FIXTURES, f), join(root, ".atticus", "history", f));
  srv = await startServer({
    root,
    user: "pat",
    version: "1.0.0",
    extend: (r, ctx) => uiHistoryRoutes(r, ctx),
  });
});
afterAll(async () => srv?.close());

describe("the prompt history API (ADR 0110)", () => {
  it("lists the turns newest first, each prompt with its response, and whether it records", async () => {
    const r = await call("/api/history");
    expect(r.status).toBe(200);
    const list = Api.HistoryList.parse(r.body);
    expect(list.total).toBe(4);
    expect(list.recording).toEqual({ on: true });
    expect(list.turns.map((t) => [t.prompt?.id, t.response?.id])).toEqual([
      ["h-20261023102000-0a0b0c", undefined],
      ["h-20261023101500-a1b2c3", "h-20261023101530-d4e5f6"],
      ["h-20261023091500-111111", "h-20261023091610-222222"],
      ["h-20260930160000-0c0c0c", "h-20260930160200-0d0d0d"],
    ]);
  });

  it("filters by change, session and words, and limits", async () => {
    const ids = async (q: string) =>
      Api.HistoryList.parse((await call(`/api/history?${q}`)).body).turns.map((t) => t.prompt?.id);
    expect(await ids("change=refunds-through-northwind-pay")).toEqual(["h-20260930160000-0c0c0c"]);
    expect(await ids("session=vscode-20261023091500-7a7a7a")).toEqual(["h-20261023091500-111111"]);
    expect(await ids("q=forge-ledger")).toEqual(["h-20261023102000-0a0b0c"]);
    const one = Api.HistoryList.parse((await call("/api/history?limit=1")).body);
    expect([one.turns.length, one.total]).toEqual([1, 4]);
    expect((await call("/api/history?limit=0")).status).toBe(400);
  });

  it("gives one record and its pair, and 404 for one it hasn't", async () => {
    const r = await call("/api/history/h-20261023101500-a1b2c3");
    expect(r.status).toBe(200);
    const e = Api.HistoryEntry.parse(r.body);
    expect(e.record.text).toBe("/atticus-needs add-transfer-limit");
    expect(e.pair!.id).toBe("h-20261023101530-d4e5f6");
    expect((await call("/api/history/h-20991231000000-ffffff")).status).toBe(404);
    expect((await call("/api/history/not-an-id")).status).toBe(404);
  });
});
