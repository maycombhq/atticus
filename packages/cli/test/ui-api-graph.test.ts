import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Api, DiagramLayout, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiGraphRoutes } from "../src/ui-api-graph.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

let srv: RunningServer;
let empty: RunningServer;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-ui-graph-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  for (const r of parse(readFileSync(join(FIXTURES, "forge/expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) continue;
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    extend: (r, ctx) => uiGraphRoutes(r, ctx),
  });
  const bare = await mkdtemp(join(tmpdir(), "atticus-ui-graph-empty-"));
  await cp(join(FIXTURES, "forge/metarepo"), bare, { recursive: true });
  empty = await startServer({ root: bare, port: 0, extend: (r, ctx) => uiGraphRoutes(r, ctx) });
});
afterAll(async () => {
  await srv?.close();
  await empty?.close();
});

const call = async (s: RunningServer, path: string, init: RequestInit = {}) => {
  const r = await fetch(s.url + path, {
    ...init,
    headers: { "X-Atticus-Token": s.token, "Content-Type": "application/json" },
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const get = (path: string) => call(srv, path);

describe("GET /api/graph/node/{id}: the estate, one level at a time (ADR 0081)", () => {
  it("opens the estate on its systems, in the shape the contract gives", async () => {
    const r = await get("/api/graph/node/estate");
    expect(r.status).toBe(200);
    const v = Api.GraphNodeView.parse(r.body);
    expect(v.lens).toBe("architecture");
    expect(v.children.map((c) => c.id)).toContain("system:ledger");
    const calls = v.edges.find((e) => e.from === "system:portal" && e.to === "system:ledger");
    expect(calls).toMatchObject({ type: "calls", count: 2 });
  });

  it("takes a lens, a depth and all", async () => {
    const d = Api.GraphNodeView.parse(
      (await get("/api/graph/node/store:ledger-db?lens=data")).body,
    );
    expect(d.children.map((c) => c.id)).toEqual([
      "table:ledger-db.account",
      "table:ledger-db.entry",
    ]);
    expect(d.suggest).toEqual({ mode: "focus", id: "table:ledger-db.account" });
    const deep = Api.GraphNodeView.parse(
      (await get("/api/graph/node/system:ledger?depth=2&all=1")).body,
    );
    expect(deep.children.map((c) => c.id)).toContain("component:ledger-api");
    expect(deep.reduced).toBe(false);
  });

  it("refuses a bad id, lens or depth (400) and a node it doesn't have (404)", async () => {
    expect((await get("/api/graph/node/system:..%2Fx")).status).toBe(400);
    expect((await get("/api/graph/node/estate?lens=flow")).status).toBe(400);
    expect((await get("/api/graph/node/estate?depth=9")).status).toBe(400);
    const none = await get("/api/graph/node/system:nowhere");
    expect(none.status).toBe(404);
    expect(none.body.detail).toBe("There is no node system:nowhere.");
  });

  it("says to read the repos first when the catalog is empty (422, not yet)", async () => {
    const r = await call(empty, "/api/graph/node/estate");
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ notYet: true });
    expect(String(r.body.detail)).toMatch(/atticus map <repo>/);
  });
});

describe("GET /api/graph/focus/{id}: a node and its neighbours", () => {
  it("opens a table in focus in the data lens by default", async () => {
    const r = await get("/api/graph/focus/table:ledger-db.entry");
    expect(r.status).toBe(200);
    const v = Api.GraphFocusView.parse(r.body);
    expect(v.lens).toBe("data");
    expect(v.neighbours.map((n) => n.id)).toEqual([
      "component:ledger-api",
      "component:reports-job",
      "table:ledger-db.account",
    ]);
  });
});

describe("kept arrangements: diagrams/layouts/<view-key>.yaml", () => {
  it("has none until one is kept", async () => {
    const r = await get("/api/graph/layout/architecture.estate");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      view: "architecture.estate",
      saved: false,
      path: "diagrams/layouts/architecture.estate.yaml",
      positions: {},
    });
  });

  it("writes the file as the signed-in person and reads it back", async () => {
    const put = await call(srv, "/api/graph/layout/architecture.system-ledger", {
      method: "PUT",
      body: JSON.stringify({
        lens: "architecture",
        node: "system:ledger",
        positions: { "repo:forge-ledger": { x: 40, y: 80 } },
      }),
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      saved: true,
      path: "diagrams/layouts/architecture.system-ledger.yaml",
    });
    const file = parse(
      await readFile(join(root, "diagrams/layouts/architecture.system-ledger.yaml"), "utf8"),
    ) as unknown;
    expect(DiagramLayout.parse(file)).toMatchObject({
      schemaVersion: 1,
      view: "architecture.system-ledger",
      lens: "architecture",
      node: "system:ledger",
      by: "pat",
      positions: { "repo:forge-ledger": { x: 40, y: 80 } },
    });
    const back = await get("/api/graph/layout/architecture.system-ledger");
    expect(back.body).toMatchObject({
      saved: true,
      positions: { "repo:forge-ledger": { x: 40, y: 80 } },
    });
  });

  it("refuses a key that isn't the view's, a bad key and a bad body (400)", async () => {
    const body = JSON.stringify({ lens: "architecture", node: "system:ledger", positions: {} });
    expect((await call(srv, "/api/graph/layout/data.estate", { method: "PUT", body })).status).toBe(
      400,
    );
    expect((await get("/api/graph/layout/..%2Fescape")).status).toBe(400);
    const bad = JSON.stringify({ lens: "architecture", node: "estate", positions: { x: 1 } });
    expect(
      (await call(srv, "/api/graph/layout/architecture.estate", { method: "PUT", body: bad }))
        .status,
    ).toBe(400);
  });
});
