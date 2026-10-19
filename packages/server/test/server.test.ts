import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import {
  Api,
  API_VERSION,
  Finding,
  SCHEMA_VERSION,
  parseRecord,
  recordPath,
  serializeRecord,
} from "@maycombhq/core";

const {
  ChangeSummary,
  Graph,
  Health,
  Impact,
  KindCount,
  OrgPackView,
  Problem,
  RecordPage,
  RepoView,
} = Api;
import { startServer, type RunningServer } from "../src/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

/** A Forge metarepo: the org pack, the expected catalog as files, and the seeded change. */
async function forgeMetarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-server-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  await cp(join(FIXTURES, "forge-change/openspec"), join(root, "openspec"), { recursive: true });
  const rows = parse(readFileSync(join(FIXTURES, "forge/expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[];
  for (const r of rows) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(`${String(r.id)}: ${JSON.stringify(p.issues)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  // One finding in round 1 of the plan gate, so the change has something open.
  const dir = join(root, "openspec/changes/add-transfer-limit/review/plan/1");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "b04-no-timeout.yaml"),
    [
      "schemaVersion: 1",
      "id: b04-no-timeout",
      "kind: issue",
      "change: add-transfer-limit",
      "gate: plan",
      "round: 1",
      "rule: timeout-on-external-call",
      "layer: org",
      "lens: architecture",
      "severity: blocking",
      "artifact: design.md",
      "locator:",
      "  heading: Northwind Pay",
      "summary: The call to Northwind Pay has no timeout.",
      "why: A slow vendor holds the transfer thread.",
      "fix:",
      "  text: Set a 3 second timeout.",
      "evidence:",
      "  - source: artifact",
      "    path: design.md",
      "waivable: false",
      "state: open",
      "createdAt: 2026-10-19T09:30:00Z",
      "",
    ].join("\n"),
  );
  return root;
}

let root: string;
let srv: RunningServer;

async function call(
  path: string,
  o: {
    token?: string | null;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; type: string; body: unknown }> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.token !== null) headers["X-Atticus-Token"] = o.token ?? srv.token;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(srv.url + path, {
    method: o.method ?? "GET",
    headers,
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
  const type = r.headers.get("content-type") ?? "";
  const text = await r.text();
  return { status: r.status, type, body: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  root = await forgeMetarepo();
  srv = await startServer({ root, port: 0, user: "priya", version: "9.9.9" });
});
afterAll(async () => {
  await srv?.close();
});

describe("the local server (ADR 0015)", () => {
  it("binds 127.0.0.1 and prints a fresh session token", async () => {
    expect(new URL(srv.url).hostname).toBe("127.0.0.1");
    expect(srv.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const other = await startServer({ root, port: 0 });
    expect(other.token).not.toBe(srv.token);
    await other.close();
  });

  it("refuses to bind anything but the loopback address", async () => {
    await expect(startServer({ root, port: 0, host: "0.0.0.0" })).rejects.toThrow(
      /only listens on 127.0.0.1/,
    );
  });

  it("answers every call without the right token with 401 problem details", async () => {
    for (const token of [null, "wrong"]) {
      const r = await call("/api/health", { token });
      expect(r.status).toBe(401);
      expect(r.type).toMatch(/^application\/problem\+json/);
      expect(Problem.parse(r.body)).toMatchObject({
        status: 401,
        title: "Missing or wrong session token",
      });
    }
  });

  it("refuses a page from another site driving it (Origin) and other host names (Host)", async () => {
    const raw = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          srv.url + "/api/health",
          { headers: { "X-Atticus-Token": srv.token, ...headers } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
    expect(await raw({ Origin: "https://evil.example" })).toBe(403);
    expect(await raw({ Host: "evil.example" })).toBe(403);
    expect(await raw({ Origin: srv.url })).toBe(200);
  });

  it("health: versions, the root and the user", async () => {
    const r = await call("/api/health");
    expect(r.status).toBe(200);
    expect(Health.parse(r.body)).toEqual({
      version: "9.9.9",
      apiVersion: API_VERSION,
      schemaVersion: SCHEMA_VERSION,
      root,
      openspec: "openspec",
      user: "priya",
    });
  });

  it("catalog: counts per kind, a filtered page, one record, and plain 400s and 404s", async () => {
    const kinds = z.array(KindCount).parse((await call("/api/catalog/kinds")).body);
    const comps = kinds.find((k) => k.kind === "Component");
    expect(comps?.count).toBeGreaterThan(0);

    const page = RecordPage.parse((await call("/api/catalog/Component?limit=2")).body);
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(comps!.count);
    expect(page.next).toBeDefined();
    const next = RecordPage.parse(
      (await call(`/api/catalog/Component?limit=2&cursor=${page.next}`)).body,
    );
    const idOf = (r: unknown) => (r as { id: string }).id;
    expect(idOf(next.items[0]) > idOf(page.items[1])).toBe(true);

    const one = await call(`/api/catalog/Component/${encodeURIComponent(idOf(page.items[0]))}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ kind: "Component", id: idOf(page.items[0]) });

    const bad = await call("/api/catalog/Nonsense");
    expect(bad.status).toBe(400);
    expect(Problem.parse(bad.body).detail).toMatch(/Nonsense is not a record kind/);
    expect((await call("/api/catalog/Component?limit=900")).status).toBe(400);
    const missing = await call("/api/catalog/Component/no-such-thing");
    expect(missing.status).toBe(404);
    expect(Problem.parse(missing.body).detail).toBe("There is no Component no-such-thing.");
  });

  it("search with the catalog query language, and a plain 400 for a bad query", async () => {
    const r = await call("/api/search?q=kind:component&limit=3");
    expect(r.status).toBe(200);
    const body = r.body as { rows: { kind: string; id: string }[]; total: number };
    expect(body.rows).toHaveLength(3);
    expect(body.rows.every((x) => x.kind === "Component")).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(3);
    expect((await call("/api/search")).status).toBe(400);
    expect((await call("/api/search?q=kind:nonsense")).status).toBe(400);
  });

  it("graph and impact", async () => {
    const g = Graph.parse((await call("/api/graph")).body);
    expect(g.nodes.length).toBeGreaterThan(0);
    expect(g.edges.length).toBeGreaterThan(0);
    const target = g.edges[0]!.to;
    const imp = await call(`/api/impact/${encodeURIComponent(target)}?depth=2`);
    expect(imp.status).toBe(200);
    expect(Impact.parse(imp.body).root).toBe(target);
    expect((await call("/api/impact/no-such-thing")).status).toBe(404);
    expect((await call("/api/graph?depth=9")).status).toBe(400);
  });

  it("repos from the manifests, with base-clone state", async () => {
    const repos = z.array(RepoView).parse((await call("/api/repos")).body);
    expect(repos.length).toBeGreaterThan(0);
    expect(repos.every((r) => r.platform === "forge" && r.baseClone.present === false)).toBe(true);
  });

  it("changes with their open findings, and findings filtered", async () => {
    const changes = z.array(ChangeSummary).parse((await call("/api/changes")).body);
    expect(changes.map((c) => c.id)).toEqual(["add-transfer-limit"]);
    expect(changes[0]!.openFindings).toEqual({ blocking: 1, gap: 0, risk: 0, idea: 0 });
    expect(z.array(ChangeSummary).parse((await call("/api/changes?state=released")).body)).toEqual(
      [],
    );

    const all = z
      .array(Finding)
      .parse((await call("/api/findings?change=add-transfer-limit")).body);
    expect(all.map((f) => f.id)).toEqual(["b04-no-timeout"]);
    expect(z.array(Finding).parse((await call("/api/findings?lens=ux")).body)).toEqual([]);
    const one = await call("/api/findings/add-transfer-limit/b04-no-timeout");
    expect(Finding.parse(one.body).summary).toBe("The call to Northwind Pay has no timeout.");
    expect((await call("/api/findings/add-transfer-limit/nope")).status).toBe(404);
  });

  it("org pack summary", async () => {
    const o = OrgPackView.parse((await call("/api/orgpack")).body);
    expect(o.counts.patterns).toBeGreaterThan(0);
    expect(o.problems).toEqual([]);
  });

  it("unknown paths and methods are 404 and 405 problem details", async () => {
    expect((await call("/api/nope")).status).toBe(404);
    const m = await call("/api/health", { method: "DELETE" });
    expect(m.status).toBe(405);
  });
});

/** A bare WebSocket client: handshake, then read one text frame. */
function wsFirstMessage(path: string): Promise<{ status: number; message?: string }> {
  const u = new URL(srv.url);
  return new Promise((resolve, reject) => {
    const sock = connect(Number(u.port), "127.0.0.1");
    const key = randomBytes(16).toString("base64");
    let buf = Buffer.alloc(0);
    let upgraded = false;
    sock.on("connect", () =>
      sock.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${u.port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      ),
    );
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buf.subarray(0, end).toString();
        const status = Number(head.split(" ")[1]);
        if (status !== 101) {
          sock.destroy();
          return resolve({ status });
        }
        const accept = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64");
        if (!head.includes(`Sec-WebSocket-Accept: ${accept}`)) reject(new Error("bad accept"));
        upgraded = true;
        buf = buf.subarray(end + 4);
        srv.events.publish({ type: "index.rebuilt", records: 42 });
      }
      if (buf.length >= 2) {
        const len = buf[1]! & 0x7f;
        if (buf.length < 2 + len) return;
        const message = buf.subarray(2, 2 + len).toString("utf8");
        sock.destroy();
        resolve({ status: 101, message });
      }
    });
    sock.on("error", reject);
  });
}

describe("live events on /api/events", () => {
  it("needs the token, then streams events as JSON text frames", async () => {
    expect((await wsFirstMessage("/api/events")).status).toBe(401);
    const r = await wsFirstMessage(`/api/events?token=${srv.token}`);
    expect(r.status).toBe(101);
    expect(JSON.parse(r.message!)).toEqual({ type: "index.rebuilt", records: 42 });
  });
});

describe("the app's files", () => {
  it("hands out index.html with the session token, the app's assets, and routes unknown screens to the app", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-ui-dist-"));
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(
      join(dir, "index.html"),
      '<!doctype html><html><head><meta name="atticus-token" content="" /></head><body></body></html>',
    );
    await writeFile(join(dir, "assets/app-AbCdEf12.js"), "console.log(1)");
    const s = await startServer({ root, port: 0, staticDir: dir });
    try {
      const html = await fetch(s.url + "/");
      expect(html.status).toBe(200);
      expect(await html.text()).toContain(`<meta name="atticus-token" content="${s.token}" />`);
      expect(html.headers.get("content-security-policy")).toMatch(/default-src 'self'/);
      const js = await fetch(s.url + "/assets/app-AbCdEf12.js");
      expect(js.headers.get("content-type")).toMatch(/^text\/javascript/);
      expect(js.headers.get("cache-control")).toMatch(/immutable/);
      expect(await (await fetch(s.url + "/changes/add-transfer-limit")).text()).toContain(
        "atticus-token",
      );
      expect((await fetch(s.url + "/assets/missing.js")).status).toBe(404);
      expect((await fetch(s.url + "/..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
      const rebinding = await new Promise<number>((resolve, reject) => {
        const r = request(s.url + "/", { headers: { Host: "evil.example" } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        r.on("error", reject);
        r.end();
      });
      expect(rebinding).toBe(403);
    } finally {
      await s.close();
    }
  });
});

describe("the index on a fresh metarepo", () => {
  it("answers calls made at once while it builds the index the first time", async () => {
    const root = await forgeMetarepo();
    const s = await startServer({ root, port: 0 });
    try {
      const calls = [
        "kind:interface",
        "ledger",
        "kind:table",
        "portal",
        "kind:column",
        "audit",
      ].map((q) =>
        fetch(`${s.url}/api/search?q=${encodeURIComponent(q)}`, {
          headers: { "X-Atticus-Token": s.token },
        }).then((r) => r.status),
      );
      calls.push(
        fetch(`${s.url}/api/catalog/kinds`, { headers: { "X-Atticus-Token": s.token } }).then(
          (r) => r.status,
        ),
      );
      expect(await Promise.all(calls)).toEqual([200, 200, 200, 200, 200, 200, 200]);
    } finally {
      await s.close();
    }
  });
});

describe("Ask", () => {
  it("answers a question with the query it ran, an impact walk or an owner", async () => {
    const root = await forgeMetarepo();
    const s = await startServer({ root, port: 0 });
    const ask = async (q: string) =>
      (await (
        await fetch(`${s.url}/api/ask?q=${encodeURIComponent(q)}`, {
          headers: { "X-Atticus-Token": s.token },
        })
      ).json()) as Record<string, unknown>;
    try {
      const calls = await ask("Who calls ledger-api?");
      expect(calls).toMatchObject({ action: "query", query: "kind:interface to:ledger-api" });
      expect((calls.result as { total: number }).total).toBeGreaterThan(0);
      const breaks = await ask("what breaks if ledger-api changes");
      expect(breaks).toMatchObject({ action: "impact", id: "ledger-api" });
      expect((breaks.impact as { affected: unknown[] }).affected.length).toBeGreaterThan(0);
      expect(await ask("who owns ledger-api")).toMatchObject({
        action: "owner",
        owner: "team-ledger",
      });
    } finally {
      await s.close();
    }
  });
});

describe("incident mode", () => {
  it("gives the blast radius, the owners to call, what watches it and recent nearby changes", async () => {
    const root = await forgeMetarepo();
    const s = await startServer({ root, port: 0 });
    try {
      const r = await fetch(`${s.url}/api/incident/ledger-api`, {
        headers: { "X-Atticus-Token": s.token },
      });
      expect(r.status).toBe(200);
      const b = (await r.json()) as {
        blastRadius: number;
        call: { owner: string; systems: string[] }[];
        ownerUnknown: string[];
        watch: { name: string }[];
        recentChanges: { id: string }[];
      };
      expect(b.blastRadius).toBeGreaterThan(0);
      expect(b.call.map((c) => c.owner)).toEqual(
        expect.arrayContaining(["team-ledger", "team-portal"]),
      );
      expect(b.watch.map((w) => w.name)).toContain("Ledger API error rate");
      expect(b.recentChanges.map((c) => c.id)).toContain("add-transfer-limit");
      const missing = await fetch(`${s.url}/api/incident/atlantis`, {
        headers: { "X-Atticus-Token": s.token },
      });
      expect(missing.status).toBe(404);
    } finally {
      await s.close();
    }
  });
});
