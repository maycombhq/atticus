import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Api, catalogDirOf, type CatalogRecord } from "@maycombhq/core";
import {
  buildAndWrite,
  keepCatalogsInMemory,
  readBuildReport,
  readCatalog,
} from "@maycombhq/scanner";
import { startServer, type RunningServer } from "@maycombhq/server";
import { extendUiRoutes } from "../src/ui-commands.js";
import { bigGatewayId, bigRepoId } from "./big-estate.js";
import { makeFieldEstate, type FieldEstate } from "./field-estate.js";

/**
 * ADR 0204's journeys on the field-shaped estate (field-estate.ts, small; invented Forge names):
 * (1) connect a gateway proxy to a service it doesn't forward to: one button, the arrow drawn as
 * declared, Undo, then again; (2) connect boxes with no calls between them: an outside system to a
 * repo, two outside systems, a system holding several repos (pick one); (3) a later real call
 * (a person's pairing) retires a declared arrow: one arrow, the offer to retire, Retire, and the
 * profile no longer has the item. No network.
 */

let dir: string;
let estate: FieldEstate;
let srv: RunningServer;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a route's JSON, read loosely
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
  return { status: r.status, body: (text ? JSON.parse(text) : {}) as Json };
};
const job = async (path: string, body: unknown) => {
  const started = await call(path, "POST", body);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  for (let n = 0; n < 6000; n++) {
    const j = (await call(`/api/jobs/${String(started.body.jobId)}`)).body;
    if (j.state !== "running" && j.state !== "queued") return j;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${path} didn't end`);
};
const connect = async (from: string, to: string) => {
  const r = await call(`/api/connect?from=${from}&to=${to}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return Api.ConnectView.parse(r.body);
};
const declaredArrows = async () =>
  (await readCatalog(join(catalogDirOf(estate.root), "generated"), { fresh: true })).records.filter(
    (r): r is Extract<CatalogRecord, { kind: "Interface" }> =>
      r.kind === "Interface" && !!r.flags?.includes("declared-link"),
  );
const PROFILE = () => join(estate.root, "org-pack", "profiles", "github", "profile.yaml");
const links = async () =>
  ((parse(await readFile(PROFILE(), "utf8")) as { links?: Json[] }).links ?? []).length;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "b30-cn-field-"));
  estate = await makeFieldEstate(dir, {
    services: 6,
    gateways: 3,
    entries: 12,
    calls: 14,
    fieldNames: 40,
    legacy: 0,
    questions: 4,
    links: 4,
    suppressed: 0,
    checkouts: 6,
  });
  const built = await buildAndWrite(estate.root, { command: "atticus catalog build" });
  expect(built.guard.refused).toBeUndefined();
  keepCatalogsInMemory(true);
  srv = await startServer({
    root: estate.root,
    port: 0,
    user: "pat",
    version: "1.0.0",
    extend: (r, ctx) => extendUiRoutes(r, ctx),
  });
  // Two outside systems, added as the app adds them (Add to the picture…).
  for (const [id, name] of [
    ["harbor-audit", "Harbor Audit"],
    ["northwind-pay", "Northwind Pay"],
  ])
    expect(
      (
        await call("/api/boxes", "POST", {
          id,
          name,
          boundary: id === "northwind-pay" ? "vendor" : "internal",
        })
      ).status,
    ).toBe(200);
}, 600_000);
afterAll(async () => {
  keepCatalogsInMemory(false);
  await srv?.close();
  await rm(dir, { recursive: true, force: true });
}, 120_000);

describe("journey 1: a gateway proxy to a service that is no gateway", () => {
  it("offers its calls first, then declares the arrow in one go, Undo, and again", async () => {
    const gw = bigGatewayId(0);
    // A service the proxy's forwarding doesn't reach: no arrow from the proxy goes to it.
    let svc = "";
    for (const r of estate.repos.filter((x) => x.startsWith("forge-svc-"))) {
      const v = await connect(`repo:${gw}`, `repo:${r}`);
      expect(v.from).toEqual({ repo: gw });
      if (v.existing === 0) {
        svc = r;
        // B.1: the proxy has forwarding calls that go elsewhere, so they are listed to move.
        expect(["calls", "declare"]).toContain(v.mechanism);
        break;
      }
    }
    expect(svc, "a service the proxy doesn't forward to").not.toBe("");
    const link = {
      kind: "link",
      from: { repo: gw },
      to: { repo: svc },
      why: "The proxy's target is set at deploy time; the platform team confirmed it.",
    };
    const once = await job("/api/map/edits", { edits: [{ kind: "add", add: link }] });
    expect(once.result.built, (once.result.lines as string[]).join("\n")).toBe(true);
    const d = await declaredArrows();
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      confidence: "asserted",
      evidence: [{ source: "manual", by: "pat" }],
    });
    // The map draws it as declared, by its person, between its own two boxes (a focus on the
    // proxy). Between two systems the code links already it is neither counted nor listed (B.1).
    const focus = await call(`/api/graph/focus/component:${String(d[0]!.from)}?lens=architecture`);
    expect(JSON.stringify(focus.body)).toContain('"declaredBy":"pat"');
    const graph = (await call("/api/graph/node/estate?lens=architecture")).body as {
      edges: Api.HierEdgeT[];
    };
    for (const e of graph.edges)
      if (e.joins?.some((j) => j.declaredBy === "pat"))
        expect(e.joins.every((j) => j.declaredBy === "pat")).toBe(true);
    // The proxy's calls are still listed, the declared arrow beside them (B.1, the review).
    const after = await connect(`repo:${gw}`, `repo:${svc}`);
    expect(["calls", "declared"]).toContain(after.mechanism);
    expect(after.declared?.by).toBe("pat");
    const undo = await job("/api/map/edits/undo", { wrote: once.result.wrote });
    expect(undo.result.built).toBe(true);
    expect(await declaredArrows()).toHaveLength(0);
    expect(await links()).toBe(0);
    const again = await job("/api/map/edits", { edits: [{ kind: "add", add: link }] });
    expect(again.result.built).toBe(true);
    expect(await declaredArrows()).toHaveLength(1);
    // Remove it, through the guarded path (the map built again), for the next journey's count.
    const arrow = (await connect(`repo:${gw}`, `repo:${svc}`)).declared!;
    const removed = await job("/api/map/edits/undo", {
      wrote: [{ edit: 0, file: arrow.file, link: arrow }],
    });
    expect(removed.result.built).toBe(true);
    expect(await declaredArrows()).toHaveLength(0);
  }, 600_000);
});

describe("journey 2: two boxes with no calls between them", () => {
  it("declares an outside system to a repo, and two outside systems; asks which repo of several", async () => {
    for (const [from, to] of [
      ["system:harbor-audit", `repo:${bigRepoId(1)}`],
      ["system:harbor-audit", "system:northwind-pay"],
    ] as const) {
      const v = await connect(from, to);
      expect(v.mechanism, `${from} → ${to}`).toBe("declare");
    }
    // The gateways' system holds three repos: which one?
    const several = await connect("system:platform", `repo:${bigRepoId(1)}`);
    expect(several.mechanism).toBe("needs");
    expect(several.needs[0]).toMatchObject({
      need: "pick-repo",
      repos: expect.arrayContaining([bigGatewayId(0)]),
    });
    const j = await job("/api/map/edits", {
      edits: [
        {
          kind: "add",
          add: {
            kind: "link",
            from: { system: "harbor-audit" },
            to: { system: "northwind-pay" },
            why: "Harbor sends its audit fees to Northwind each month.",
            planned: true,
          },
        },
      ],
    });
    expect(j.result.built).toBe(true);
    const d = await declaredArrows();
    expect(d.map((x) => [x.from, x.to, x.status])).toEqual([
      ["harbor-audit", "northwind-pay", "planned-new"],
    ]);
  }, 600_000);
});

describe("journey 3: a later real call retires a declared arrow", () => {
  it("draws one arrow, the code's; offers to retire; Retire takes the item", async () => {
    // Two services with no call between them, and a loose call of the first to pair.
    let found: { a: string; b: string; v: Api.ConnectViewT } | undefined;
    const svcs = estate.repos.filter((x) => x.startsWith("forge-svc-"));
    for (const a of svcs)
      for (const b of svcs) {
        if (found || a === b) continue;
        const v = await connect(`repo:${a}`, `repo:${b}`);
        if (
          v.existing === 0 &&
          v.candidates?.apis.length &&
          v.candidates.calls.some((x) => !x.codeNames && !x.inside)
        )
          found = { a, b, v };
      }
    expect(found, "two services with no call between them").toBeDefined();
    const { a, b, v } = found!;
    const why = "The first service reads the second's holds through the shared client.";
    const w = await job("/api/map/edits", {
      edits: [{ kind: "add", add: { kind: "link", from: { repo: a }, to: { repo: b }, why } }],
    });
    expect(w.result.built).toBe(true);
    expect((await declaredArrows()).filter((x) => x.from !== "harbor-audit")).toHaveLength(1);
    // The person pairs a's loose call with b's API: a real call a → b.
    const c = v.candidates!;
    const pick = c.calls.find((x) => !x.codeNames && !x.inside);
    expect(pick, "a call to pair").toBeDefined();
    const p = await job("/api/map/edits", {
      edits: [
        {
          kind: "add",
          pair: {
            from: a,
            to: { repo: b },
            pairs: [{ call: pick!.fact, api: c.apis[0]!.id, reason: "Moved in the journey." }],
          },
        },
      ],
    });
    expect(p.result.built, (p.result.lines as string[]).join("\n")).toBe(true);
    expect((await declaredArrows()).filter((x) => x.from !== "harbor-audit")).toHaveLength(0);
    expect((await readBuildReport(estate.root))?.declaredSuperseded).toEqual([
      expect.objectContaining({ from: `repo:${a}`, to: `repo:${b}` }),
    ]);
    const after = await connect(`repo:${a}`, `repo:${b}`);
    expect(after.mechanism).toBe("declared");
    expect(after.superseded?.calls).toBeGreaterThan(0);
    expect(await readFile(PROFILE(), "utf8")).toContain(why);
    // Retire: its lines previewed, then the item out and the map built.
    const pre = await call("/api/declared-links/undo", "POST", {
      kind: "link",
      from: { repo: a },
      to: { repo: b },
      preview: true,
    });
    expect(pre.status, JSON.stringify(pre.body)).toBe(200);
    const d = after.declared!;
    const r = await job("/api/map/edits/undo", { wrote: [{ edit: 0, file: d.file, link: d }] });
    expect(r.result.built, (r.result.lines as string[]).join("\n")).toBe(true);
    expect(await readFile(PROFILE(), "utf8")).not.toContain(why);
  }, 600_000);
});
