import { appendFile, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Api } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiDeclaredRoutes } from "../src/ui-api-declared.js";

/**
 * G3 (ADR 0174): add a box, declare a link the code can't show, and a box's corrections with
 * Undo. On the invented Forge estate of fixtures/prototype-compare with Northwind Pay, an
 * invented vendor. Files only.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FX = join(HERE, "../../../fixtures/prototype-compare");

let srv: RunningServer;
let root: string;
const profile = () => join(root, "org-pack/profiles/forge/profile.yaml");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-declared-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await writeFile(join(root, "org-pack/sources.yaml"), "schemaVersion: 1\nwikis: []\n");
  await cp(join(FX, "org-pack/profiles/forge"), join(root, "org-pack/profiles/forge"), {
    recursive: true,
  });
  await mkdir(join(root, "facts"), { recursive: true });
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    extend: (r, ctx) => uiDeclaredRoutes(r, ctx, { now: () => new Date("2026-11-06T12:00:00Z") }),
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

describe("add a box (ADR 0174, G3)", () => {
  it("lists what can be added: repos read or not, systems and teams", async () => {
    const v = Api.AddableView.parse((await call("GET", "/api/boxes/addable")).body);
    expect(v.repos.map((r) => r.id)).toContain("forge-billing");
    expect(v.systems.map((s) => s.id)).toContain("northwind-pay");
  });

  it("adds a new team's system to the profile for review, and refuses one that is there", async () => {
    const body = { id: "harbor-audit", name: "Harbor audit", boundary: "internal" };
    const p = Api.FileChangeResult.parse(
      (await call("POST", "/api/boxes", { ...body, preview: true })).body,
    );
    expect(p.written).toBe(false);
    const w = Api.FileChangeResult.parse((await call("POST", "/api/boxes", body)).body);
    expect(w.written).toBe(true);
    const systems = (parse(await readFile(profile(), "utf8")) as { systems: { id: string }[] })
      .systems;
    expect(systems.map((s) => s.id)).toContain("harbor-audit");
    expect((await call("POST", "/api/boxes", body)).status).toBe(409);
    expect((await call("POST", "/api/boxes", { ...body, id: "Not An Id" })).status).toBe(400);
  });
});

describe("declare a link, and undo it", () => {
  it("writes a topic a team publishes, lists it on the box with who, and undoes exactly it", async () => {
    const d = {
      kind: "topic",
      system: "harbor-audit",
      topic: "harbor.audit.events",
      side: "publishes",
    };
    const p = Api.FileChangeResult.parse(
      (await call("POST", "/api/declared-links", { ...d, preview: true })).body,
    );
    expect(p.written).toBe(false);
    expect(p.files[0]!.changes.some((c) => c.now?.includes("harbor.audit.events"))).toBe(true);
    expect((await call("POST", "/api/declared-links", d)).status).toBe(200);
    expect((await call("POST", "/api/declared-links", d)).status).toBe(409);
    const list = Api.BoxCorrections.parse(
      (await call("GET", "/api/boxes/corrections?system=harbor-audit")).body,
    );
    expect(list.items).toEqual([
      {
        kind: "topic",
        says: "publishes harbor.audit.events",
        by: "pat",
        at: "2026-11-06",
        file: "org-pack/profiles/forge/profile.yaml",
        undo: { kind: "topic", system: "harbor-audit", value: "harbor.audit.events" },
      },
    ]);
    expect((await call("POST", "/api/declared-links/undo", list.items[0]!.undo)).status).toBe(200);
    expect(
      Api.BoxCorrections.parse(
        (await call("GET", "/api/boxes/corrections?system=harbor-audit")).body,
      ).items,
    ).toEqual([]);
  });

  it("writes a route a vendor calls, and refuses a topic for a system whose repos are read", async () => {
    const w = await call("POST", "/api/declared-links", {
      kind: "call",
      system: "northwind-pay",
      route: "POST /partners/northwind/webhooks",
    });
    expect(w.status).toBe(200);
    const billing = await call("POST", "/api/declared-links", {
      kind: "topic",
      system: "billing",
      topic: "forge.invoices.paid",
      side: "publishes",
    });
    expect(billing.status).toBe(409);
    expect(
      (
        await call("POST", "/api/declared-links", {
          kind: "topic",
          system: "nowhere",
          topic: "x",
          side: "listens",
        })
      ).status,
    ).toBe(404);
  });

  it("lists a repo's corrections, each with the line Undo removes", async () => {
    const line = JSON.stringify({
      schemaVersion: 1,
      fact: "call.post.capture-charge",
      target: {
        kind: "call",
        file: "src/main/java/forge/billing/PartnerClient.java",
        line: 31,
        value: "captureChargePath",
      },
      action: "link",
      link: {
        repo: "forge-partner-gateway",
        method: "POST",
        path: "/partners/northwind/charges/{chargeId}/capture",
      },
      by: "pat",
      at: "2026-11-06T12:00:00.000Z",
    });
    await appendFile(join(root, "facts/forge-billing.corrections.jsonl"), `${line}\nnot json\n`);
    const v = Api.BoxCorrections.parse(
      (await call("GET", "/api/boxes/corrections?repo=forge-billing")).body,
    );
    expect(v.items).toEqual([
      {
        kind: "link",
        says: "call captureChargePath (src/main/java/forge/billing/PartnerClient.java:31) goes to POST /partners/northwind/charges/{chargeId}/capture on forge-partner-gateway",
        by: "pat",
        at: "2026-11-06T12:00:00.000Z",
        file: "facts/forge-billing.corrections.jsonl",
        undo: { repo: "forge-billing", line },
      },
    ]);
    expect((await call("GET", "/api/boxes/corrections")).status).toBe(400);
  });
});
