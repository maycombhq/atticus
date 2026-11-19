import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Api, DiagramLayout, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiGraphRoutes, vscodeFileLink } from "../src/ui-api-graph.js";
import { seedForgeField, type ForgeField } from "./forge-field.js";

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

describe("GET /api/graph/edge-calls: every call on one edge (review of beta.24)", () => {
  it("gives the edge's calls as its view merged them, every one, and refuses what isn't there", async () => {
    const v = Api.GraphNodeView.parse((await get("/api/graph/node/estate")).body);
    const e = v.edges.find((x) => x.from === "system:portal" && x.to === "system:ledger")!;
    const r = await get(`/api/graph/edge-calls?node=estate&edge=${encodeURIComponent(e.id)}`);
    expect(r.status).toBe(200);
    const c = Api.GraphEdgeCallsView.parse(r.body);
    expect(c.edge).toBe(e.id);
    expect(c.count).toBe(e.count);
    expect(c.joins.map((j) => j.interface)).toEqual((e.joins ?? []).map((j) => j.interface));
    expect((await get(`/api/graph/edge-calls?node=estate&edge=calls:nope>nope`)).status).toBe(404);
    expect((await get(`/api/graph/edge-calls?edge=${encodeURIComponent(e.id)}`)).status).toBe(400);
  });

  it("finds an edge of a deeper view by the view's own depth (3.11.0)", async () => {
    const one = Api.GraphNodeView.parse((await get("/api/graph/node/estate")).body);
    const two = Api.GraphNodeView.parse((await get("/api/graph/node/estate?depth=2")).body);
    const e = two.edges.find((x) => !one.edges.some((y) => y.id === x.id) && x.joins?.length)!;
    expect(e).toBeDefined();
    const at = `/api/graph/edge-calls?node=estate&edge=${encodeURIComponent(e.id)}`;
    expect((await get(at)).status).toBe(404);
    const r = await get(`${at}&depth=2`);
    expect(r.status).toBe(200);
    expect(Api.GraphEdgeCallsView.parse(r.body).count).toBe(e.count);
    expect((await get(`${at}&depth=7`)).status).toBe(400);
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

describe("the estate is built once per catalog state (beta.21, G7)", () => {
  it("answers again from what it built, and sees a record added to the catalog", async () => {
    const before = await get("/api/graph/node/estate");
    const again = await get("/api/graph/node/estate");
    expect(again.body).toEqual(before.body);
    const ids = (b: Record<string, unknown>) =>
      JSON.stringify(b).includes("system:vault-memo-test");
    expect(ids(before.body)).toBe(false);
    const p = parseRecord({
      schemaVersion: 1,
      status: "current",
      kind: "System",
      id: "vault-memo-test",
      confidence: "verified",
      name: "Vault",
      boundary: "product",
      owner: "team-vault",
      repos: [],
      evidence: [{ source: "config", repo: "forge-ledger", path: "forge.yaml" }],
    });
    if (!p.ok) throw new Error("bad fixture record");
    const f = join(root, "catalog/curated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
    // The files are checked at most once a second unless the app sees the change.
    await new Promise((r) => setTimeout(r, 1100));
    const after = await get("/api/graph/node/estate");
    expect(ids(after.body)).toBe(true);
  });
});

describe("canvas views kept in the metarepo, and a cited line to open (ADR 0175, G6)", () => {
  it("keeps a named view, lists it, and refuses a name that isn't one", async () => {
    const body = JSON.stringify({
      lens: "architecture",
      node: "estate",
      filter: "team:team-ledger",
      layers: { guessed: false },
      overlay: "gaps",
    });
    const put = await call(srv, "/api/graph/views/ledger-only", { method: "PUT", body });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ name: "ledger-only", by: "pat", filter: "team:team-ledger" });
    const list = Api.SavedCanvasViews.parse((await get("/api/graph/views")).body);
    expect(list.views.map((v) => v.name)).toEqual(["ledger-only"]);
    expect((await call(srv, "/api/graph/views/Not%20One", { method: "PUT", body })).status).toBe(
      400,
    ); // A view kept already is replaced only when asked.
    expect((await call(srv, "/api/graph/views/ledger-only", { method: "PUT", body })).status).toBe(
      409,
    );
    expect(
      (await call(srv, "/api/graph/views/ledger-only?replace=1", { method: "PUT", body })).status,
    ).toBe(200);
  });

  it("says when a repo has no checkout here, and refuses a path that climbs out", async () => {
    const r = Api.CodeLink.parse(
      (
        await get(
          "/api/code-link?repo=forge-ledger&at=src/main/java/forge/ledger/LedgerEndpoints.java:8",
        )
      ).body,
    );
    expect(r.line).toBe(8);
    expect(r.path ?? r.missing).toBeTruthy();
    expect((await get("/api/code-link?repo=forge-ledger&at=../../etc/passwd:1")).status).toBe(400);
    // A folder with a # or ? in its name keeps its path; a drive's colon stays as it is.
    expect(vscodeFileLink("/home/pat/forge #2/A?.java", 8)).toBe(
      "vscode://file/home/pat/forge%20%232/A%3F.java:8",
    );
    expect(vscodeFileLink("C:\\work\\forge\\A.java", 3)).toBe(
      "vscode://file/C:/work/forge/A.java:3",
    );
  });
});

// Beta.30 (slice 9): the same graph on the field-shaped estate (fixtures/forge-field): gateway
// proxies, a repo with no System, an id with dots, a topic with two consumers, a legacy slot.
describe("the field-shaped estate", () => {
  let fsrv: RunningServer;
  let dir: string;
  let e: ForgeField & { root: string };
  const fget = (path: string) => call(fsrv, path);
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "b30-fd-graph-"));
    e = await seedForgeField(dir);
    fsrv = await startServer({
      root: e.root,
      port: 0,
      user: "pat",
      extend: (r, ctx) => uiGraphRoutes(r, ctx),
    });
  }, 300_000);
  afterAll(async () => {
    await fsrv?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("opens on its systems, and every repo read from facts is a box at depth 2, its dots and missing System too", async () => {
    const top = Api.GraphNodeView.parse((await fget("/api/graph/node/estate")).body);
    expect(top.children.map((c) => c.id)).toContain(`system:${e.topic!.publisher}`);
    const deep = Api.GraphNodeView.parse((await fget("/api/graph/node/estate?depth=2&all=1")).body);
    const ids = deep.children.map((c) => c.id);
    // A repo's box keeps its id as it is, dots and all; a repo with no System is a system's box
    // of its own, as a legacy repo's is.
    for (const c of [
      ...e.repos,
      ...e.legacy,
      "forge-nosystem-svc",
      "forge-nested-svc",
      "forge.instruments.svc",
    ])
      expect(ids, c).toContain(`repo:${c}`);
    expect(ids).toContain("system:forge-nosystem-svc");
    // The topic is a box inside each of its two consumers, both named for it, each published to.
    const topics = deep.children.filter((c) => c.kind === "topic");
    expect(topics.map((t) => [t.label, t.parent]).sort()).toEqual(
      e.topic!.listeners.map((l) => [e.topic!.name, `component:${l}`]).sort(),
    );
    for (const t of topics)
      expect(
        deep.edges.some(
          (x) => x.type === "publishes" && x.from === `repo:${e.topic!.publisher}` && x.to === t.id,
        ),
        t.id,
      ).toBe(true);
    // The topic's publisher calls both of its consumers.
    for (const to of e.topic!.listeners)
      expect(
        top.edges.some((x) => x.from === `system:${e.topic!.publisher}` && x.to === `system:${to}`),
        to,
      ).toBe(true);
  });

  it("gives every edge's calls, each edge's count, at both depths", async () => {
    for (const depth of [1, 2]) {
      const v = Api.GraphNodeView.parse((await fget(`/api/graph/node/estate?depth=${depth}`)).body);
      expect(v.edges.length).toBeGreaterThan(0);
      for (const x of v.edges.filter((y) => y.type === "calls")) {
        const r = await fget(
          `/api/graph/edge-calls?node=estate&edge=${encodeURIComponent(x.id)}${depth === 2 ? "&depth=2" : ""}`,
        );
        expect(r.status, x.id).toBe(200);
        expect(Api.GraphEdgeCallsView.parse(r.body).count, x.id).toBe(x.count);
      }
    }
    // The call joined to the wrong box is on the edge to the box it names.
    const w = e.wrongBox!;
    const v = Api.GraphNodeView.parse((await fget("/api/graph/node/estate")).body);
    expect(v.edges.some((x) => x.from === `system:${w.from}` && x.to === `system:${w.joins}`)).toBe(
      true,
    );
  }, 120_000);
});
