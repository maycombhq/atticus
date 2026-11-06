import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, interfaceId, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiGraphRoutes } from "../src/ui-api-graph.js";

/**
 * G7 (beta.21): the canvas at a real estate's size. 40 Forge systems of one service each, 60
 * endpoints and 60 calls apiece: about 4,900 records. The first box opened builds the estate;
 * every box after that is answered from it until a catalog file changes.
 */
const SYSTEMS = 40;
const PER = 60;

let srv: RunningServer;

const put = async (root: string, r: Record<string, unknown>) => {
  const p = parseRecord({ schemaVersion: 1, status: "current", confidence: "verified", ...r });
  if (!p.ok) throw new Error(`bad record ${JSON.stringify(r)}: ${JSON.stringify(p)}`);
  const f = join(root, "catalog/generated", recordPath(p.record));
  await mkdir(dirname(f), { recursive: true });
  await writeFile(f, serializeRecord(p.record));
};

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "atticus-graph-speed-"));
  const writes: Promise<void>[] = [];
  for (let s = 0; s < SYSTEMS; s++) {
    const sys = `forge-sys-${s}`;
    const comp = `${sys}-api`;
    const ev = [{ source: "code", repo: sys, path: "src/App.java", line: 1 }];
    writes.push(
      put(root, {
        kind: "System",
        id: sys,
        name: sys,
        boundary: "product",
        owner: "team-forge",
        repos: [sys],
        evidence: ev,
      }),
      put(root, {
        kind: "Component",
        id: comp,
        system: sys,
        repo: sys,
        type: "spring-boot",
        evidence: ev,
      }),
    );
    for (let e = 0; e < PER; e++) {
      writes.push(
        put(root, {
          kind: "Endpoint",
          id: `${comp}.op-${e}`,
          component: comp,
          endpointType: "rest",
          method: "GET",
          pathOrTopic: `/v1/items-${e}/{id}`,
          normalizedPath: `/v1/items-${e}/{}`,
          evidence: [{ ...ev[0], side: "callee" }],
        }),
      );
      const to = `forge-sys-${(s + 1 + (e % (SYSTEMS - 1))) % SYSTEMS}-api`;
      writes.push(
        put(root, {
          kind: "Interface",
          id: interfaceId(comp, to, "GET", `/v1/items-${e}/{}`),
          from: comp,
          to,
          endpoint: `${to}.op-${e}`,
          via: "direct",
          method: "GET",
          normalizedPath: `/v1/items-${e}/{}`,
          sync: "sync",
          evidence: [{ ...ev[0], side: "caller" }],
        }),
      );
    }
  }
  await Promise.all(writes);
  srv = await startServer({ root, port: 0, extend: (r, ctx) => uiGraphRoutes(r, ctx) });
}, 120_000);
afterAll(async () => {
  await srv?.close();
});

const timed = async (path: string) => {
  const t = performance.now();
  const r = await fetch(srv.url + path, { headers: { "X-Atticus-Token": srv.token } });
  const body = await r.json();
  return { ms: performance.now() - t, status: r.status, body };
};

describe("the canvas at a real estate's size (G7)", () => {
  it("opens the estate, then each box after it without reading the catalog again", async () => {
    const first = await timed("/api/graph/node/estate");
    expect(first.status).toBe(200);
    expect(Api.GraphNodeView.parse(first.body)).toBeTruthy();
    const opens = [];
    for (let s = 0; s < 10; s++) opens.push(await timed(`/api/graph/node/system:forge-sys-${s}`));
    for (const o of opens) expect(o.status, JSON.stringify(o.body)).toBe(200);
    const focus = await timed("/api/graph/focus/component:forge-sys-3-api?lens=architecture");
    expect(focus.status, JSON.stringify(focus.body)).toBe(200);
    const worst = Math.max(...opens.map((o) => o.ms), focus.ms);
    // The first open reads ~4,900 files; the ones after read none. Generous bound for CI.
    expect(worst).toBeLessThan(Math.max(first.ms, 1500));
    expect(worst).toBeLessThan(1500);
    console.log(`graph-speed: first ${first.ms.toFixed(0)}ms, worst after ${worst.toFixed(0)}ms`);
  }, 120_000);
});
