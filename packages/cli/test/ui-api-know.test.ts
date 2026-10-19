import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiKnowRoutes } from "../src/ui-api-know.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

let srv: RunningServer;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "atticus-ui-views-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  await cp(join(FIXTURES, "forge-change/openspec"), join(root, "openspec"), { recursive: true });
  await cp(join(FIXTURES, "forge/inputs"), join(root, "inputs"), { recursive: true });
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
  srv = await startServer({ root, port: 0, extend: (r, ctx) => uiKnowRoutes(r, ctx) });
});
afterAll(() => srv?.close());

const get = async (path: string) => {
  const r = await fetch(srv.url + path, { headers: { "X-Atticus-Token": srv.token } });
  return { status: r.status, body: (await r.json()) as { data?: unknown; detail?: string } };
};

describe("read-only views run the CLI's --json commands", () => {
  it("coverage, features and the change's trace come back as the CLI prints them", async () => {
    const cov = await get("/api/view/coverage");
    expect(cov.status).toBe(200);
    expect(cov.body.data).toHaveProperty("systems");
    const f = await get("/api/view/features");
    expect((f.body.data as { features: unknown[] }).features.length).toBeGreaterThan(0);
    const t = await get("/api/view/trace/add-transfer-limit");
    expect(t.body.data).toMatchObject({ change: "add-transfer-limit" });
  });

  it("refuses an unknown view (404), a view that needs a change (400) and a bad id (400)", async () => {
    expect((await get("/api/view/delete-everything")).status).toBe(404);
    const need = await get("/api/view/trace");
    expect(need.status).toBe(400);
    expect(need.body.detail).toBe("The trace view needs an id: /api/view/trace/<id>.");
    expect((await get("/api/view/trace/..%2F..%2Fetc")).status).toBe(400);
  });

  it("lists initiatives with their status (none in the fixture)", async () => {
    const r = await fetch(srv.url + "/api/initiatives", {
      headers: { "X-Atticus-Token": srv.token },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });

  it("draws a catalog view as Mermaid text, and refuses an unknown view or a bad focus", async () => {
    const r = await fetch(srv.url + "/api/diagram/context", {
      headers: { "X-Atticus-Token": srv.token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { text: string };
    expect(body.text).toMatch(/^(flowchart|graph|C4Context)/m);
    expect((await get("/api/diagram/everything")).status).toBe(400);
    expect((await get("/api/diagram/container?focus=..%2Fx")).status).toBe(400);
  });

  it("decides a triage item as the signed-in person, and refuses an unknown item or a bad body", async () => {
    const before = (await get("/api/view/triage")).body.data as { items: { id: string }[] };
    const item = before.items.find((i) => i.id.startsWith("alias-needed."));
    expect(item).toBeDefined();
    const post = (path: string, body: unknown) =>
      fetch(srv.url + path, {
        method: "POST",
        headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const ok = await post(`/api/triage/${item!.id}/decide`, { option: 1 });
    expect(ok.status).toBe(200);
    const after = (await get("/api/view/triage")).body.data as { items: { id: string }[] };
    expect(after.items.map((i) => i.id)).not.toContain(item!.id);
    expect((await post("/api/triage/no-such-item/decide", { option: 1 })).status).toBe(404);
    expect((await post(`/api/triage/${before.items[0]!.id}/decide`, { option: 0 })).status).toBe(
      400,
    );
  });
});

describe("guided setup from the app (ADR 0047)", () => {
  it("shows the checklist, and accepts the catalog as the signed-in person", async () => {
    const before = (await get("/api/setup")).body as unknown as { baselined: boolean };
    expect(before.baselined).toBe(false);
    const r = await fetch(srv.url + "/api/baseline", {
      method: "POST",
      headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
      body: JSON.stringify({ note: "Walked the map" }),
    });
    expect(r.status).toBe(200);
    const after = (await r.json()) as {
      baselined: boolean;
      steps: { id: string; done: boolean }[];
    };
    expect(after.baselined).toBe(true);
    expect(after.steps.find((s) => s.id === "baseline")!.done).toBe(true);
  });
});

describe("a view on a metarepo with nothing scanned", () => {
  it("says to scan first as a not-yet answer, which the app shows as an empty state", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-ui-empty-"));
    await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
    const empty = await startServer({ root, port: 0, extend: (r, ctx) => uiKnowRoutes(r, ctx) });
    try {
      const r = await fetch(`${empty.url}/api/view/coverage`, {
        headers: { "X-Atticus-Token": empty.token },
      });
      const body = (await r.json()) as { detail?: string; notYet?: boolean };
      expect(body.detail).toMatch(/scan/i);
      expect(body.notYet).toBe(true);
    } finally {
      await empty.close();
    }
  });
});
