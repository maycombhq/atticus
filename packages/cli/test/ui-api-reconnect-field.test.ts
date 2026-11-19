import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { buildAndWrite, keepCatalogsInMemory } from "@maycombhq/scanner";
import { startServer, type RunningServer } from "@maycombhq/server";
import { extendUiRoutes } from "../src/ui-commands.js";
import { bigRepoId } from "./big-estate.js";
import { makeFieldEstate, type FieldEstate } from "./field-estate.js";

/**
 * Beta.30 ("it's connected to the wrong box") on the field-shaped estate (field-estate.ts, small):
 * services whose calls go to other services by their address, through gateway proxies, by a
 * person's pairings, and by arrows kept from before the upgrade (a legacy service's). Connect from a service to a box none of its calls goes to lists every such
 * call with how it was decided, and the preview of moving one never says the Apply would refuse.
 */

let dir: string;
let estate: FieldEstate;
let srv: RunningServer;
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

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "b30-rc-field-"));
  estate = await makeFieldEstate(dir, {
    services: 6,
    gateways: 3,
    entries: 12,
    calls: 14,
    fieldNames: 40,
    legacy: 1,
    questions: 6,
    links: 6,
    suppressed: 0,
    checkouts: 6,
  });
  const built = await buildAndWrite(estate.root, { command: "atticus catalog build" });
  expect(built.guard.refused).toBeUndefined();
  keepCatalogsInMemory(true);
  srv = await startServer({
    root: estate.root,
    port: 0,
    user: "sam",
    version: "1.0.0",
    extend: (r, ctx) => extendUiRoutes(r, ctx),
  });
}, 600_000);
afterAll(async () => {
  keepCatalogsInMemory(false);
  await srv?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the field-shaped estate: a service's calls that go elsewhere", () => {
  it("lists them with how each was decided (its address, a gateway, pat's pairing, an arrow kept from before the upgrade), and previews a move of each kind with no refusal", async () => {
    const from = bigRepoId(2);
    // The box none of the service's calls goes to, of those read from facts.
    let view: Api.LinkCandidatesViewT | undefined;
    let to = "";
    for (const repo of estate.repos.filter((r) => r !== from && r.startsWith("forge-svc-"))) {
      const r = await call(`/api/links/candidates?from=${from}&to=${repo}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const v = Api.LinkCandidatesView.parse(r.body);
      if (v.apis.length && !v.calls.some((c) => c.status === "here" || c.status === "paired")) {
        view = v;
        to = repo;
        break;
      }
    }
    expect(view, "a service none of its calls goes to").toBeDefined();
    const joined = view!.calls.filter((c) => c.status === "joined");
    // Every call with an arrow says how it was decided, in a kind the panel has words for.
    expect(joined.length).toBeGreaterThan(0);
    for (const c of joined) expect(c.how, c.fact).toBeDefined();
    const kinds = new Set(joined.map((c) => c.how!.by));
    expect([...kinds].sort()).toEqual(["address", "gateway", "kept", "paired"]);
    // An arrow to a service whose records are kept from before the upgrade says so.
    for (const c of joined.filter((x) => x.how!.by === "kept"))
      expect(estate.legacy).toContain(c.joins);
    const paired = joined.find((c) => c.how!.by === "paired")!;
    expect(paired.how).toEqual({ by: "paired", who: "pat", at: "2026-11-10T09:00:00Z" });
    expect(joined.find((c) => c.how!.by === "gateway")!.how!.through).toMatch(/^forge-gw-/);
    // One of each kind moved to the box: the preview says the arrow moves, and never refuses.
    const api = view!.apis[0]!.id;
    for (const by of ["address", "gateway", "paired", "kept"] as const) {
      const c = joined.find((x) => x.how!.by === by)!;
      const p = await call("/api/links/connect", "POST", {
        from,
        to: { repo: to },
        pairs: [{ call: c.fact, api, reason: "Moved in a test of the field shape." }],
        preview: true,
      });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      const v = Api.VerifyPreviewView.parse(Api.ConnectLinksResult.parse(p.body).preview).preview!;
      // The API picked here is the box's first, not the call's own path, so the preview says
      // the old arrow removed and the new one added (the same path would say "moves").
      const gained = [...(v.links?.moved ?? []), ...(v.links?.added ?? [])].map((m) => m.to);
      expect(gained, `${by}: ${JSON.stringify(v.links)}`).toHaveLength(1);
      expect(v.catalog?.removed, by).toBeGreaterThanOrEqual(1);
      expect(v.confirm, `${by}: ${JSON.stringify(v.confirm)}`).toBeUndefined();
    }
  }, 300_000);
});
