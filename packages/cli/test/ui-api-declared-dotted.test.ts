import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, loadOrgPack } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { extendUiRoutes } from "../src/ui-commands.js";
import { boxSystemOf } from "../src/ui-api-declared.js";

/**
 * Beta.28.1 (field hunt G4): Declare a link… from the box of a repo whose id has dots
 * (`forge.instruments.svc`) said "No system of the profiles is forge.instruments.svc": the canvas
 * draws that repo's box as the system `forge-instruments-svc` (its id's slug), and the request
 * named the repo. A repo's id names its box's system as well as the canvas's id does. On the
 * invented token-host estate with the service renamed; files only.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "token-host");
const DOTTED = "forge.instruments.svc";
const BOX = "forge-instruments-svc";
let root: string;
let srv: RunningServer;
const profile = () => join(root, "org-pack", "profiles", "forge", "profile.yaml");
const post = async (path: string, body: unknown) => {
  const r = await fetch(srv.url + path, {
    method: "POST",
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "atticus-declared-dotted-"));
  cpSync(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  const manifest = join(root, "org-pack", "profiles", "forge", "repos.manifest.yaml");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8").replace("  - id: forge-instruments\n", `  - id: ${DOTTED}\n`),
  );
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    version: "1.0.0",
    extend: (r, ctx) => extendUiRoutes(r, ctx),
  });
});
afterAll(async () => {
  await srv?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("a dotted repo id's box (field hunt G4)", () => {
  it("names the system its box is drawn as, and leaves any other id as it is", async () => {
    const op = await loadOrgPack(join(root, "org-pack"));
    expect(boxSystemOf(op, DOTTED)).toBe(BOX);
    expect(boxSystemOf(op, BOX)).toBe(BOX);
    // A repo the manifest gives a system: that system.
    expect(boxSystemOf(op, "forge_instruments_1-0")).toBe("platform");
    expect(boxSystemOf(op, "platform")).toBe("platform");
    expect(boxSystemOf(op, "forge-nowhere")).toBe("forge-nowhere");
  });

  it("declares a link from the repo's id: on its box's system, added to the profile first", async () => {
    const body = { kind: "call", system: DOTTED, route: "GET /forge/instruments/v1/ping" };
    const p = await post("/api/declared-links", { ...body, preview: true });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(Api.FileChangeResult.parse(p.body).created?.system).toBe(BOX);
    const w = await post("/api/declared-links", body);
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(readFileSync(profile(), "utf8")).toContain(`- id: ${BOX} #`);
    expect(readFileSync(profile(), "utf8")).not.toContain(`id: ${DOTTED}`);
    // And its Undo, by the repo's id too.
    const u = await post("/api/declared-links/undo", {
      kind: "call",
      system: DOTTED,
      value: "GET /forge/instruments/v1/ping",
    });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect(readFileSync(profile(), "utf8")).not.toContain(`id: ${BOX}`);
  });

  it("checks Edit the map's add from the repo's id as the declaration would make it", async () => {
    const { checkMapEdits } = await import("../src/map-edits.js");
    const { problems } = await checkMapEdits(root, [
      { kind: "add", add: { kind: "call", system: DOTTED, route: "GET /forge/instruments/v1" } },
    ]);
    expect(problems).toEqual([]);
  });
});
