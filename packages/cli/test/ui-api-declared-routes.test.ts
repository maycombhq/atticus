import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Api, type CatalogRecord } from "@maycombhq/core";
import { keepCatalogsInMemory, readCatalog } from "@maycombhq/scanner";
import { startServer, type RunningServer } from "@maycombhq/server";
import { extendUiRoutes } from "../src/ui-commands.js";
import { verifyConfirmed as verifyCommand } from "./seed-slots.js";

/**
 * ADR 0200 (a field report on 2.0.0-beta.28.4): another team's system calls a gateway proxy of
 * the estate. The routes of the proxy are listed to pick from, several are declared in one
 * write, and after Apply the catalog has the declared Interface from the system, through the
 * gateway. On the invented Forge estate of `fixtures/gateway-facts/token-host/` (a proxy that is
 * its own repo, and the service behind it) with Harbor Audit, an invented team's system no repo
 * of the estate is in. Files only.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "token-host");
const PROXY = "forge_instruments_1-0";
const SERVICE = "forge-instruments";
const COMMIT: Record<string, string> = { [PROXY]: "8a1c0de", [SERVICE]: "5e1f00d" };
const HARBOR = "harbor-audit";
type Iface = Extract<CatalogRecord, { kind: "Interface" }>;

let root: string;
let srv: RunningServer;
const profile = () => join(root, "org-pack", "profiles", "forge", "profile.yaml");
const verify = async (repo: string) => {
  const out: string[] = [];
  const code = await verifyCommand(
    root,
    repo,
    {
      commit: COMMIT[repo]!,
      dir: join(root, "workspace", repo),
      write: true,
      now: () => new Date("2026-11-17T10:00:00.000Z"),
    },
    { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
  );
  expect(code, out.join("\n")).toBe(0);
};
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
  return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
};
const routes = async (q: string) => {
  const r = await call(`/api/declared-links/routes?${q}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return Api.DeclarableRoutesView.parse(r.body);
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "atticus-declared-routes-"));
  cpSync(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  writeFileSync(
    profile(),
    readFileSync(profile(), "utf8").replace(
      "environments:",
      `  - { id: ${HARBOR}, name: Harbor Audit, boundary: internal, owner: team-harbor, aliases: [] }\nenvironments:`,
    ),
  );
  mkdirSync(join(root, "facts"), { recursive: true });
  for (const r of Object.keys(COMMIT)) {
    cpSync(join(FIX, "repos", r), join(root, "workspace", r), { recursive: true });
    writeFileSync(
      join(root, "facts", `${r}.jsonl`),
      readFileSync(join(FIX, "facts", `${r}.jsonl`), "utf8"),
    );
  }
  for (const r of Object.keys(COMMIT)) await verify(r);
  keepCatalogsInMemory(true);
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    version: "1.0.0",
    extend: (r, ctx) => extendUiRoutes(r, ctx),
  });
}, 300_000);
afterAll(async () => {
  keepCatalogsInMemory(false);
  await srv?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

const PING = "GET /forge/instruments/v1/ping";
const CREATE = "POST /forge/instruments/v1";

describe("the routes a caller can be declared on (ADR 0200)", () => {
  it("lists the repos that have gateway routes, and nothing of a target when none is named", async () => {
    const v = await routes(`system=${HARBOR}`);
    expect(v.system).toBe(HARBOR);
    expect(v.gateways).toEqual([{ repo: PROXY, routes: 4 }]);
    expect(v.target).toBeUndefined();
  });

  it("lists the proxy's routes by path then method, each with its handler and the line it was read from", async () => {
    const v = await routes(`system=${HARBOR}&repo=${PROXY}`);
    expect(v.target).toMatchObject({ repo: PROXY, gateway: true, entries: 4 });
    expect(v.target!.routes.map((r) => [r.say, r.handler, r.declared ?? false])).toEqual([
      [CREATE, `${PROXY}/CreateInstrument`, false],
      ["GET /forge/instruments/v1/ping", `${PROXY}/Ping`, false],
      ["GET /forge/instruments/v1/{id}", `${PROXY}/RetrieveInstrument`, false],
      ["POST /forge/instruments/v1/{id}/status", `${PROXY}/InstrumentStatus`, false],
    ]);
    expect(v.target!.routes[1]!.at).toBe("apiproxy/proxies/default.xml:4");
  });

  it("says an ordinary service is no gateway, with how many entries it has, and offers none of them", async () => {
    const v = await routes(`system=${HARBOR}&repo=${SERVICE}`);
    expect(v.target).toMatchObject({ repo: SERVICE, gateway: false, routes: [] });
    expect(v.target!.entries).toBeGreaterThan(0);
  });

  it("says a repo with nothing read how to read it, and refuses a repo or a system nobody knows", async () => {
    rmSync(join(root, "facts", `${SERVICE}.jsonl`));
    try {
      const v = await routes(`system=${HARBOR}&repo=${SERVICE}`);
      expect(v.target).toMatchObject({
        gateway: false,
        entries: 0,
        notRead: { why: "not-read", command: `atticus map --all --repos ${SERVICE}` },
      });
    } finally {
      writeFileSync(
        join(root, "facts", `${SERVICE}.jsonl`),
        readFileSync(join(FIX, "facts", `${SERVICE}.jsonl`), "utf8"),
      );
    }
    expect((await call(`/api/declared-links/routes?system=${HARBOR}&repo=nowhere`)).status).toBe(
      404,
    );
    expect((await call(`/api/declared-links/routes`)).status).toBe(400);
  });
});

describe("several routes declared in one request (ADR 0200)", () => {
  it("refuses a request with no route, or with a route and routes both", async () => {
    const none = await call("/api/declared-links", "POST", { kind: "call", system: HARBOR });
    expect(none.status).toBe(400);
    const both = await call("/api/declared-links", "POST", {
      kind: "call",
      system: HARBOR,
      route: PING,
      routes: [CREATE],
    });
    expect(both.status).toBe(400);
  });

  it("previews, then writes each route once in a fixed order, and the preview is what is written", async () => {
    const was = readFileSync(profile(), "utf8");
    const body = { kind: "call", system: HARBOR, routes: [CREATE, PING, CREATE] };
    const p = await call("/api/declared-links", "POST", { ...body, preview: true });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const pv = Api.FileChangeResult.parse(p.body);
    expect(pv.written).toBe(false);
    expect(readFileSync(profile(), "utf8")).toBe(was);
    const w = Api.FileChangeResult.parse((await call("/api/declared-links", "POST", body)).body);
    expect(w.written).toBe(true);
    expect(w.files).toEqual(pv.files);
    expect(w.commit).toContain(`${HARBOR} calls 2 gateway routes, declared on the canvas`);
    const text = readFileSync(profile(), "utf8");
    const after = parse(text) as { systems: { id: string; calls?: { route: string }[] }[] };
    expect(after.systems.find((s) => s.id === HARBOR)!.calls).toEqual([
      { route: PING },
      { route: CREATE },
    ]);
    expect(text.match(/declared by pat on \d{4}-\d{2}-\d{2}/g)).toHaveLength(2);
    // Declared again, in any order: refused whole, naming what is there.
    const again = await call("/api/declared-links", "POST", {
      kind: "call",
      system: HARBOR,
      routes: [PING, "GET /forge/instruments/v1/{id}"],
    });
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toContain(PING);
    expect(readFileSync(profile(), "utf8")).toBe(text);
  });

  it("marks the routes declared already, and lists each under the system's declarations with Undo", async () => {
    const v = await routes(`system=${HARBOR}&repo=${PROXY}`);
    expect(v.target!.routes.filter((r) => r.declared).map((r) => r.say)).toEqual([CREATE, PING]);
    const list = Api.BoxCorrections.parse(
      (await call(`/api/boxes/corrections?system=${HARBOR}`)).body,
    );
    expect(list.items.map((i) => i.says)).toEqual([`calls ${PING}`, `calls ${CREATE}`]);
  });

  it("after Apply, the catalog has the declared Interface from the system through the gateway, and the map draws it as declared", async () => {
    await verify(PROXY);
    const ifaces = (
      await readCatalog(join(root, "catalog", "generated"), { fresh: true })
    ).records.filter((r): r is Iface => r.kind === "Interface" && r.from === HARBOR);
    expect(ifaces.map((i) => [i.to, i.via, i.method, i.confidence, i.flags])).toEqual([
      ["instruments-proxy", "gateway", "GET", "asserted", ["declared-caller"]],
      ["instruments-proxy", "gateway", "POST", "asserted", ["declared-caller"]],
    ]);
    expect(ifaces.every((i) => i.evidence.some((e) => e.source === "manual"))).toBe(true);
    // The picture is checked against the catalog's files at most once a second (an Apply run
    // from the app says the files changed; this one ran beside the server).
    await new Promise((r) => setTimeout(r, 1100));
    const g = await call("/api/graph/node/estate");
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    const view = Api.GraphNodeView.parse(g.body);
    const edge = view.edges.find((e) => e.from === `system:${HARBOR}`);
    expect(edge, JSON.stringify(view.edges)).toBeDefined();
    expect(edge!.to).toBe("system:platform");
    expect((edge!.joins ?? []).map((j) => j.how)).toEqual(["declared", "declared"]);
  });
});
