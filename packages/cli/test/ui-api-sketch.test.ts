import { cp, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiSketchRoutes } from "../src/ui-api-sketch.js";

/**
 * ADR 0179: a change drawn on the canvas, stroke by stroke, into its target flows: preview first,
 * written on the yes, each stroke one line the change diagram then draws. On the invented Forge
 * stages fixture; no network, no git.
 */

const STAGES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/stages");
let srv: RunningServer;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-sketch-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await cp(join(STAGES, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(STAGES, "changes"), join(root, "openspec/changes"), { recursive: true });
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    extend: (r, ctx) => uiSketchRoutes(r, ctx),
  });
});
afterAll(() => srv?.close());

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

describe("a change drawn on the canvas", () => {
  it("previews a call stroke as the delta file's lines, writes it on the yes, and the picture shows it marked new", async () => {
    const stroke = {
      kind: "call",
      from: { component: "forge-orders" },
      to: { component: "northwind-pay", entry: "POST /v1/screenings", new: true },
      what: "Northwind Pay screens the order.",
    };
    const p = Api.SketchResult.parse(
      (await call("POST", "/api/changes/add-fraud-check/sketch", { stroke, preview: true })).body,
    );
    expect(p.written).toBe(false);
    expect(p.files.map((f) => f.file)).toEqual([
      "openspec/changes/add-fraud-check/target-flows/forge-orders.place-order.yaml",
    ]);
    expect(p.files[0]!.changes.some((c) => c.now?.includes("POST /v1/screenings"))).toBe(true);
    expect(
      await readdir(join(root, "openspec/changes/add-fraud-check/target-flows")).catch(() => []),
    ).toEqual([]);
    const w = Api.SketchResult.parse(
      (await call("POST", "/api/changes/add-fraud-check/sketch", { stroke })).body,
    );
    expect(w.written).toBe(true);
    // The write is what the preview showed.
    expect(w.files).toEqual(p.files);
    const text = await readFile(
      join(root, "openspec/changes/add-fraud-check/target-flows/forge-orders.place-order.yaml"),
      "utf8",
    );
    expect(text).toContain("Drafted by pat on the canvas");
    expect(text).toContain("why: Drawn on the canvas by pat on the canvas.");
    expect(w.map?.nodes.find((n) => n.id.includes("northwind"))?.legend).toBe("new");
    expect(w.drawn).toEqual([
      {
        flow: "forge-orders.place-order",
        index: 0,
        what: "call-out → northwind-pay POST /v1/screenings",
      },
    ]);
  });

  it("says why a stroke can't be drawn, and lists the flows to pick from", async () => {
    const r = Api.SketchResult.parse(
      (
        await call("POST", "/api/changes/add-fraud-check/sketch", {
          stroke: {
            kind: "call",
            from: { component: "no-such" },
            to: { component: "forge-orders", entry: "GET /x" },
          },
        })
      ).body,
    );
    expect(r.written).toBe(false);
    expect(r.problem).toContain("no flow on the map yet");
  });

  it("takes a stroke back, and refuses a stroke that isn't one, or a change that isn't there", async () => {
    const g = Api.SketchResult.parse(
      (await call("GET", "/api/changes/add-fraud-check/sketch")).body,
    );
    expect(g.drawn).toHaveLength(1);
    const u = Api.SketchResult.parse(
      (
        await call("POST", "/api/changes/add-fraud-check/sketch", {
          stroke: { kind: "undo", flow: "forge-orders.place-order", index: 0 },
        })
      ).body,
    );
    expect(u.written).toBe(true);
    expect(u.drawn).toEqual([]);
    expect(await readdir(join(root, "openspec/changes/add-fraud-check/target-flows"))).toEqual([]);
    expect(
      (await call("POST", "/api/changes/add-fraud-check/sketch", { stroke: { kind: "fly" } }))
        .status,
    ).toBe(400);
    expect((await call("GET", "/api/changes/no-such/sketch")).status).toBe(404);
  });
});
