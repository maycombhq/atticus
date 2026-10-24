import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { cockpit } from "../src/cockpit.js";
import { uiCockpitRoutes } from "../src/ui-api-cockpit.js";

/**
 * The change cockpit (WP7.1): one change at a glance, from what change status, next and the
 * stage files already say. Over the invented Forge fixtures of the fast path (ADR 0113).
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const CHANGE = "return-order-time";

async function estate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-cockpit-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const rows = [
    ...(parse(readFileSync(join(FIXTURES, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIXTURES, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error("bad fixture record");
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIXTURES, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIXTURES, "stages/changes"), join(root, "openspec/changes"), { recursive: true });
  await cp(join(FIXTURES, "stages/small", CHANGE), join(root, "openspec/changes", CHANGE), {
    recursive: true,
  });
  return root;
}

let root: string;
let srv: RunningServer;

beforeAll(async () => {
  root = await estate();
  srv = await startServer({
    root,
    port: 0,
    user: "priya.nair",
    watch: false,
    extend: (r, ctx) => uiCockpitRoutes(r, ctx),
  });
});
afterAll(() => srv?.close());

describe("the change cockpit (WP7.1)", () => {
  it("says where the change is, its next step with the slash command, and each stage", async () => {
    const c = await cockpit(root, CHANGE);
    expect(c.id).toBe(CHANGE);
    expect(c.state).toBeTruthy();
    expect(c.nextStep).toBeTruthy();
    expect(c.stages.map((s) => s.stage)).toEqual(["feature", "architecture", "stories"]);
    expect(c.stages.every((s) => s.state === "not-started" && s.drafts === 0)).toBe(true);
    // The next step atticus next gives for this change: the fast path, in the assistant.
    expect(c.next?.change).toBe(CHANGE);
    expect(c.next?.slash).toMatch(/^\/atticus-/);
    expect(c.repos).toEqual([]);
  });

  it("is served by the local API, and a change that isn't there is not found", async () => {
    const call = async (path: string) => {
      const r = await fetch(srv.url + path, { headers: { "X-Atticus-Token": srv.token } });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const ok = await call(`/api/changes/${CHANGE}/cockpit`);
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe(CHANGE);
    expect((await call("/api/changes/no-such-change/cockpit")).status).toBe(404);
  });
});
