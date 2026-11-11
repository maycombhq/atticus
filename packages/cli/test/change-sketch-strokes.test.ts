import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { loadEstate, readDeltas, sketchOf } from "@maycombhq/planner";
import { startServer, type RunningServer } from "@maycombhq/server";
import { changeSketchCommand, readStrokesFile, suggestComponents } from "../src/change-sketch.js";
import { changeMapOf, targetFlowsOf } from "../src/change-map.js";
import { uiSketchRoutes } from "../src/ui-api-sketch.js";

/**
 * ADR 0193: a consolidation imported from a strokes file, without drawing it. Three pass-through
 * wrappers are absorbed into a new forge-api service; their gateway proxies keep their entries
 * and route to forge-api. On the invented consolidation fixture; no network, no git.
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/consolidation");
const CHANGE = "consolidate-wrappers";
let root: string;
let srv: RunningServer;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-sketch-strokes-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  for (const r of parse(await readFile(join(FIX, "catalog.yaml"), "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    const file = join(root, "catalog", "generated", recordPath(p.record));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, serializeRecord(p.record));
  }
  await cp(join(FIX, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "changes"), join(root, "openspec/changes"), { recursive: true });
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    extend: (r, ctx) => uiSketchRoutes(r, ctx),
  });
});
afterAll(() => srv?.close());

const io = () => {
  const out: string[] = [];
  return { out, io: { out: (l: string) => out.push(l), err: (l: string) => out.push(`! ${l}`) } };
};
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

describe("reading a strokes file", () => {
  it("reads YAML or JSON, a list or { strokes: [...] }, and says which entry isn't a stroke", () => {
    const one = { kind: "retire", component: "forge-cards-wrapper", why: "Gone" };
    expect(readStrokesFile(JSON.stringify([one]), "s.json")).toEqual({
      strokes: [{ stroke: one, at: "stroke 1" }],
      problems: [],
    });
    const r = readStrokesFile(
      "strokes:\n  - kind: retire\n    component: a\n    why: x\n  - kind: fly\n",
      "s.yaml",
    );
    expect(r.strokes).toHaveLength(1);
    expect(r.problems).toEqual([expect.stringMatching(/^stroke 2: isn't a stroke Atticus draws/)]);
    expect(readStrokesFile("- [", "s.yaml").problems[0]).toMatch(/^s\.yaml doesn't read/);
    expect(readStrokesFile("hello: 1", "s.yaml").problems).toEqual([
      "s.yaml has no strokes: write a list of strokes, or strokes: [ ... ].",
    ]);
  });

  it("suggests the nearest components for an id the map doesn't have", () => {
    expect(
      suggestComponents("forge-acounts-wrapper", [
        "forge-accounts-wrapper",
        "forge-accounts-proxy",
        "forge-cards-wrapper",
        "northwind-pay-gateway",
      ]),
    ).toEqual(["forge-accounts-wrapper", "forge-cards-wrapper", "forge-accounts-proxy"]);
    expect(suggestComponents("zzz", ["forge-api"])).toEqual([]);
  });
});

describe("atticus change sketch --from strokes.yaml (ADR 0193)", () => {
  it("previews, says what it can't draw with a did-you-mean, then draws the consolidation", async () => {
    const typo = join(root, "typo.yaml");
    await writeFile(
      typo,
      "- kind: absorb\n  component: forge-acounts-wrapper\n  into: { component: forge-api }\n  why: One service\n",
    );
    const t = io();
    expect(await changeSketchCommand(root, CHANGE, { from: typo, by: "pat" }, t.io)).toBe(1);
    expect(t.out.join("\n")).toContain(
      "forge-acounts-wrapper isn't a component of today's map. Did you mean forge-accounts-wrapper",
    );

    const file = join(FIX, "strokes.yaml");
    const a = io();
    expect(await changeSketchCommand(root, CHANGE, { from: file, by: "pat" }, a.io)).toBe(0);
    expect(a.out).toEqual([
      "Would draw: absorb forge-accounts-wrapper into forge-api (stroke 1)",
      "Would draw: absorb forge-cards-wrapper into forge-api (stroke 2)",
      "Would draw: absorb forge-limits-wrapper into forge-api (stroke 3)",
      "3 strokes to draw; nothing written. Add --save to draw them.",
    ]);
    expect(
      await readdir(join(root, `openspec/changes/${CHANGE}/target-flows`)).catch(() => []),
    ).toEqual([]);

    const b = io();
    expect(
      await changeSketchCommand(root, CHANGE, { from: file, save: true, by: "pat" }, b.io),
    ).toBe(0);
    expect(b.out.at(-1)).toContain("3 strokes written");
    const files = (await readdir(join(root, `openspec/changes/${CHANGE}/target-flows`))).sort();
    expect(files).toEqual([
      "forge-accounts-proxy.route-accounts.yaml",
      "forge-accounts-wrapper.get-accounts.yaml",
      "forge-api.get-accounts.yaml",
      "forge-api.get-cards.yaml",
      "forge-api.get-limits.yaml",
      "forge-cards-proxy.route-cards.yaml",
      "forge-cards-wrapper.get-cards.yaml",
      "forge-limits-proxy.route-limits.yaml",
      "forge-limits-wrapper.get-limits.yaml",
    ]);
    const { deltas } = await readDeltas(join(root, `openspec/changes/${CHANGE}`));
    const by = new Map(deltas.map((d) => [d.flow, d]));
    // The moved flows keep their entries; the new box says where it runs.
    expect(by.get("forge-api.get-cards")).toMatchObject({
      change: "new",
      trigger: { entry: "GET /cards/{id}" },
      runsOn: { component: "forge-api" },
    });
    expect(by.get("forge-api.get-accounts")!.runsOn).toEqual({
      component: "forge-api",
      type: "service",
      platform: "cloud-run",
    });
    // The proxies' entries don't change; their call now goes to forge-api at the same entry.
    for (const n of ["accounts", "cards", "limits"]) {
      const p = by.get(`forge-${n}-proxy.route-${n}`)!;
      expect(p.change).toBe("modify");
      expect(p.steps.find((s) => s.op === "add")!.to).toEqual({
        component: "forge-api",
        entry: `GET /${n}/{id}`,
        new: false,
      });
      expect(by.get(`forge-${n}-wrapper.get-${n}`)!.change).toBe("remove");
    }
    // Saving again draws nothing twice.
    const again = io();
    expect(
      await changeSketchCommand(root, CHANGE, { from: file, save: true, by: "pat" }, again.io),
    ).toBe(1);
    expect(again.out.join("\n")).toContain("the map shows nothing new of it since");

    // The architecture stage keeps every drawn step: the sketch is its whole frame here.
    const estate = await loadEstate(root, (await targetFlowsOf(root, CHANGE))!.records);
    expect(estate.flows).toHaveLength(6);
    expect(
      sketchOf(deltas)
        .map((d) => d.flow)
        .sort(),
    ).toEqual(files.map((f) => f.replace(/\.yaml$/, "")));
  });

  it("the change's picture shows the new box, the absorbed boxes retired and the proxies' lines to the new box", async () => {
    const m = (await changeMapOf(root, CHANGE))!;
    const node = (id: string) => m.view.nodes.find((n) => n.id === id);
    expect(node("forge-api")?.legend).toBe("new");
    for (const n of ["accounts", "cards", "limits"]) {
      expect(node(`forge-${n}-wrapper`)?.legend).toBe("retire");
      const edges = m.view.edges.filter((e) => e.from === `forge-${n}-proxy`);
      expect(edges.find((e) => e.to === "forge-api")?.legend).toBe("new");
      expect(edges.find((e) => e.to === `forge-${n}-wrapper`)?.legend).toBe("retire");
    }
    expect(m.problems).toEqual([]);
  });

  it("the canvas lists each absorb once and its Undo takes the whole absorb back", async () => {
    const g = Api.SketchResult.parse((await call("GET", `/api/changes/${CHANGE}/sketch`)).body);
    const absorbs = g.drawn.filter((d) => d.what.startsWith("absorbed "));
    expect(absorbs.map((d) => d.what).sort()).toEqual([
      "absorbed forge-accounts-wrapper into forge-api",
      "absorbed forge-cards-wrapper into forge-api",
      "absorbed forge-limits-wrapper into forge-api",
    ]);
    expect(g.drawn).toHaveLength(3);
    const cards = absorbs.find((d) => d.what.includes("cards"))!;
    const undo = { kind: "undo", flow: cards.flow, index: cards.index };
    const p = Api.SketchResult.parse(
      (await call("POST", `/api/changes/${CHANGE}/sketch`, { stroke: undo, preview: true })).body,
    );
    expect(p.problem).toBeUndefined();
    const w = Api.SketchResult.parse(
      (await call("POST", `/api/changes/${CHANGE}/sketch`, { stroke: undo, expect: p.fingerprint }))
        .body,
    );
    expect(w.written).toBe(true);
    const files = (await readdir(join(root, `openspec/changes/${CHANGE}/target-flows`))).sort();
    expect(files.filter((f) => f.includes("cards"))).toEqual([]);
    expect(files).toHaveLength(6);
    expect(w.drawn).toHaveLength(2);
  });
});
