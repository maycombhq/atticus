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
 * Beta.28.1 (field report 4): connecting two boxes from the app never dead-ends. On the invented
 * estate of `fixtures/gateway-facts/token-host/`: a proxy whose forwarding calls go to a token
 * host nothing sets, and a Spring Boot service the manifest lists with no System of the profile.
 * Connect to… from the proxy's box lists the calls loose with the service's entries suggested;
 * the pairing written and verified draws the arrows "by a person"; a call with an arrow is then
 * listed as movable from any other box; Declare a link… from the service's box (a system of its
 * own id on the canvas) adds that System to the profile itself, and says so. Files only.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "token-host");
const PROXY = "forge_instruments_1-0";
const SERVICE = "forge-instruments";
const COMMIT: Record<string, string> = { [PROXY]: "8a1c0de", [SERVICE]: "5e1f00d" };
const MEANT: Record<string, string> = {
  "call.get.instruments-ping": "entry.get.instruments-ping",
  "call.post.instruments": "entry.post.instruments",
  "call.get.instruments-id": "entry.get.instruments-instrumentid",
  "call.post.instruments-id-status": "entry.post.instruments-instrumentid-status",
};
const AT = new Date("2026-11-13T10:00:00.000Z");
type Iface = Extract<CatalogRecord, { kind: "Interface" }>;

let root: string;
let srv: RunningServer;
const verify = async (repo: string) => {
  const out: string[] = [];
  const code = await verifyCommand(
    root,
    repo,
    { commit: COMMIT[repo]!, dir: join(root, "workspace", repo), write: true, now: () => AT },
    { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
  );
  expect(code, out.join("\n")).toBe(0);
};
const interfaces = async () =>
  (await readCatalog(join(root, "catalog", "generated"), { fresh: true })).records.filter(
    (r): r is Iface => r.kind === "Interface",
  );
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
const candidates = async (q: string) => {
  const r = await call(`/api/links/candidates?from=${PROXY}&${q}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return Api.LinkCandidatesView.parse(r.body);
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "atticus-token-host-"));
  cpSync(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
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

describe("Connect to… from a proxy whose target host is a token (field report 4)", () => {
  it("draws no arrow from the proxy, and lists its every call loose with the entry it is", async () => {
    expect((await interfaces()).filter((i) => i.from === "instruments-proxy")).toEqual([]);
    const v = await candidates(`to=${SERVICE}`);
    expect(v.noCalls).toBeUndefined();
    expect(v.noApis).toBeUndefined();
    expect(v.calls.map((c) => [c.fact, c.status]).sort()).toEqual(
      Object.keys(MEANT)
        .sort()
        .map((c) => [c, "asked"]),
    );
    for (const c of v.calls) {
      expect(c.suggestion?.api, c.fact).toBe(MEANT[c.fact]);
      expect(c.confident, c.fact).toBe(true);
    }
  });

  it("pairs them, and verify --write draws each arrow to the service by a person", async () => {
    const pairs = Object.entries(MEANT).map(([c, a]) => ({ call: c, api: a }));
    const w = await call("/api/links/connect", "POST", {
      from: PROXY,
      to: { repo: SERVICE },
      pairs,
    });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(Api.ConnectLinksResult.parse(w.body).lines.length).toBe(4);
    await verify(PROXY);
    const drawn = (await interfaces()).filter((i) => i.from === "instruments-proxy");
    expect(drawn.map((i) => i.to)).toEqual(Array(4).fill(SERVICE));
    for (const i of drawn) expect(i.flags).toContain("joined-by-person");
    const after = await candidates(`to=${SERVICE}`);
    expect(after.calls.map((c) => c.status)).toEqual(Array(4).fill("paired"));
  });

  it("lists a call with an arrow as movable from another box, never hidden", async () => {
    // An outside system of the profile, with no spec yet: the panel still names every call.
    const profile = join(root, "org-pack", "profiles", "forge", "profile.yaml");
    writeFileSync(
      profile,
      readFileSync(profile, "utf8").replace(
        "environments:",
        "  - { id: northwind-ledger, name: Northwind Ledger, boundary: vendor, aliases: [] }\nenvironments:",
      ),
    );
    const v = await candidates("system=northwind-ledger");
    expect(v.calls.map((c) => [c.status, c.joins])).toEqual(Array(4).fill(["joined", SERVICE]));
  });

  it("lists a call whose arrow was deleted on the canvas as loose (undrawn), with where it went", async () => {
    const one = (await interfaces()).find(
      (i) =>
        i.from === "instruments-proxy" && i.method === "GET" && i.normalizedPath?.endsWith("/ping"),
    )!;
    const dir = join(root, "catalog", "curated", "curateddecision");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `cd-link-delete-${one.id}.yaml`), "kind: CuratedDecision\n");
    const v = await candidates("system=northwind-ledger");
    const ping = v.calls.find((c) => c.fact === "call.get.instruments-ping")!;
    expect([ping.status, ping.joins]).toEqual(["undrawn", SERVICE]);
    rmSync(join(dir, `cd-link-delete-${one.id}.yaml`));
  });
});

describe("Declare a link… from a box no System of the profiles is (field report 4)", () => {
  it("adds the System to the repo's profile first, says so, and declares the link on it", async () => {
    const body = { kind: "call", system: SERVICE, route: "GET /forge/instruments/v1/ping" };
    const p = await call("/api/declared-links", "POST", { ...body, preview: true });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const pv = Api.FileChangeResult.parse(p.body);
    expect(pv).toMatchObject({
      written: false,
      created: { system: SERVICE, file: "org-pack/profiles/forge/profile.yaml" },
    });
    const profile = join(root, "org-pack", "profiles", "forge", "profile.yaml");
    expect(readFileSync(profile, "utf8")).not.toContain(`id: ${SERVICE}`);
    const w = Api.FileChangeResult.parse((await call("/api/declared-links", "POST", body)).body);
    expect(w.written).toBe(true);
    expect(w.created?.system).toBe(SERVICE);
    const after = parse(readFileSync(profile, "utf8")) as {
      systems: { id: string; boundary: string; owner?: string; calls?: { route: string }[] }[];
    };
    expect(after.systems.find((s) => s.id === SERVICE)).toMatchObject({
      boundary: "product",
      owner: "team-instruments",
      calls: [{ route: "GET /forge/instruments/v1/ping" }],
    });
    // A second declaration finds the System there: none is added again.
    const again = Api.FileChangeResult.parse(
      (
        await call("/api/declared-links", "POST", {
          ...body,
          route: "POST /forge/instruments/v1",
          preview: true,
        })
      ).body,
    );
    expect(again.created).toBeUndefined();
  });

  it("still refuses a system no profile has and no repo of the manifest is drawn in", async () => {
    const r = await call("/api/declared-links", "POST", {
      kind: "call",
      system: "forge-nowhere",
      route: "GET /x",
    });
    expect(r.status).toBe(404);
  });
});
