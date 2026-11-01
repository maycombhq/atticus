import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { main } from "../src/main.js";
import { uiSpecRoutes } from "../src/ui-api-specs.js";

/**
 * atticus change impact (ADR 0144, V1): what a change's target flows break across the estate,
 * each part with its owner team; a guessed link may break and isn't counted. The hold-stock
 * scenario with fixtures/stages/hold-stock/impact added.
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const HOLD = join(FIX, "stages/hold-stock");
const yaml = (f: string) => parse(readFileSync(f, "utf8")) as unknown;

async function metarepo(o: { targets: boolean }) {
  const root = await mkdtemp(join(tmpdir(), "atticus-change-impact-"));
  const rows = [
    ...(yaml(join(FIX, "specs/catalog.yaml")) as unknown[]),
    ...(yaml(join(FIX, "stages/catalog-extra.yaml")) as unknown[]),
    ...(yaml(join(FIX, "stages/pin-table/catalog.yaml")) as unknown[]),
    ...(yaml(join(HOLD, "catalog.yaml")) as unknown[]),
    ...(yaml(join(HOLD, "impact/catalog.yaml")) as unknown[]),
  ];
  for (const row of rows) {
    const p = parseRecord(row);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "stages/specs"), join(root, "specs"), { recursive: true });
  const change = join(root, "openspec/changes/hold-stock");
  await cp(join(HOLD, "hold-stock"), change, { recursive: true });
  if (o.targets) {
    await mkdir(join(change, "target-flows"), { recursive: true });
    for (const f of (yaml(join(HOLD, "drafts/clean.yaml")) as { flows: { flow: string }[] }).flows)
      await writeFile(
        join(change, "target-flows", `${f.flow}.yaml`),
        stringify({ schemaVersion: 2, ...f }),
      );
  }
  const owned = yaml(join(HOLD, "impact/owners.yaml")) as {
    owners: Record<string, string>;
    teams: unknown[];
  };
  await mkdir(join(root, "org-pack/profiles/forge"), { recursive: true });
  await writeFile(
    join(root, "org-pack/profiles/forge/repos.manifest.yaml"),
    stringify({
      schemaVersion: 1,
      platform: "forge",
      repos: Object.entries(owned.owners).map(([id, owner]) => ({
        id,
        url: `https://git.example.com/forge/${id}.git`,
        type: "spring-boot",
        owner,
        system: "forge",
      })),
    }),
  );
  await writeFile(
    join(root, "org-pack/roles.yaml"),
    stringify({ schemaVersion: 2, teams: owned.teams }),
  );
  return root;
}

const run = async (args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    args,
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    { quiet: true },
  );
  return { code, out, err: err.join("\n") };
};

describe("atticus change impact", () => {
  it("says what breaks, what only may (link guessed), the fields and routes, and whose each is", async () => {
    const root = await metarepo({ targets: true });
    const r = await run(["change", "impact", "hold-stock", "--root", root]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      "hold-stock: 3 callers break, 1 caller may break (link guessed), 1 gateway route to update.",
      "Up the chain (who calls the callers): 1 more breaks, 0 may break (resting on a guessed link).",
      "forge-orders-db.orders (a table forge-orders.place-order writes), owned by team-orders (Orders team): it changes the type of quantity from INT to BIGINT.",
      "  Breaks: forge-reports, owned by no team (no repos.manifest.yaml lists forge-reports, so no team owns it).",
      "POST /stock/reservations (forge-stock.reserve-stock), owned by team-stock (Stock team): it no longer returns reservationId.",
      "  Stops crossing: reservationId.",
      "  May break (link guessed by path): forge-mobile, owned by team-mobile; at forge-mobile src/stock/reserve.ts:7. Not counted as a break until someone confirms the link.",
      "  Breaks: forge-orders, owned by team-orders (Orders team); at forge-orders src/main/java/forge/orders/StockClient.java:14, its flow forge-orders.place-order.",
      "  Breaks: forge-partner, owned by team-partners; at forge-partner src/partner/StockClient.java:22, through gw-stock-v1.",
      "    Breaks via forge-orders (forge-orders.post-orders): forge-web, owned by no team (no repos.manifest.yaml lists forge-web, so no team owns it); at forge-web src/app/orders/order.service.ts:12.",
      "  The critic's constitution.change-links-known asks the caller's owner to confirm each guessed link: atticus critic hold-stock.",
      "  Gateway route to update: gw-stock-v1 (stock-v1, /stock/v1, in forge-gateway), owned by team-platform; forge-partner calls through it.",
      "Teams to involve:",
      "  team-mobile: forge-mobile",
      "  team-orders (Orders team): forge-orders",
      "  team-partners: forge-partner",
      "  team-platform: forge-gateway",
      "  team-stock (Stock team): forge-stock",
      "  no team (no repos.manifest.yaml lists forge-reports, so no team owns it): forge-reports",
      "  no team (no repos.manifest.yaml lists forge-web, so no team owns it): forge-web",
      ...["forge-orders.place-order", "forge-stock.reserve-stock"].map(
        (f) =>
          `Note: This target of ${f} was written before target flows were pinned to today's flow, so a change to today's flow can't be seen. Check its step numbers, then run atticus change architecture again to pin it.`,
      ),
    ]);
  });

  it("--json gives the API's body; a change with no target flows says to run its architecture", async () => {
    const root = await metarepo({ targets: false });
    const r = await run(["change", "impact", "hold-stock", "--json", "--root", root]);
    expect(r.code).toBe(0);
    const body = Api.ChangeImpact.parse(JSON.parse(r.out.join("\n")));
    expect(body).toMatchObject({ flows: 0, items: [], breaks: 0 });
    const words = await run(["change", "impact", "hold-stock", "--root", root]);
    expect(words.out[0]).toContain("atticus change architecture hold-stock");
    expect((await run(["change", "impact", "no-such", "--root", root])).code).toBe(1);
    expect((await run(["change", "impact", "--root", root])).code).toBe(2);
  });
});

describe("GET /api/changes/{id}/impact (ADR 0144)", () => {
  let srv: RunningServer;
  beforeAll(async () => {
    srv = await startServer({
      root: await metarepo({ targets: true }),
      port: 0,
      extend: (r, ctx) => uiSpecRoutes(r, ctx),
    });
  });
  afterAll(async () => srv?.close());
  const get = async (path: string) => {
    const r = await fetch(srv.url + path, { headers: { "X-Atticus-Token": srv.token } });
    return { status: r.status, body: (await r.json()) as unknown };
  };

  it("answers the impact, and a 404 for a change that isn't there", async () => {
    const r = await get("/api/changes/hold-stock/impact");
    expect(r.status).toBe(200);
    const body = Api.ChangeImpact.parse(r.body);
    expect([body.breaks, body.mayBreak, body.routes, body.flows]).toEqual([3, 1, 1, 2]);
    // ADR 0156: up the chain, forge-web calls forge-orders.
    expect(body.upstream).toEqual({ breaks: 1, mayBreak: 0 });
    const stock = body.items.find((i) => i.kind === "endpoint")!;
    expect(stock.chain?.map((h) => [h.component, h.depth, h.via])).toEqual([
      ["forge-web", 2, ["forge-orders"]],
    ]);
    expect((await get("/api/changes/no-such/impact")).status).toBe(404);
  });
});
