import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiMeRoutes } from "../src/ui-api-me.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

let root: string;
let srv: RunningServer;

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-ui-me-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  await mkdir(join(root, ".github"), { recursive: true });
  await writeFile(
    join(root, ".github/CODEOWNERS"),
    "catalog/ @forge/platform\nopenspec/changes/*/design.md @priya @forge/architects\n",
  );
  srv = await startServer({ root, port: 0, user: "priya", extend: (r, ctx) => uiMeRoutes(r, ctx) });
});
afterAll(() => srv?.close());

describe("who is signed in, their view and what they can approve", () => {
  it("asks for a view when nothing maps the person to a role", async () => {
    const me = await call("GET", "/api/me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ user: "priya", view: null, source: "pick", groups: [] });
    const roles = me.body.roles as { id: string; core: boolean }[];
    expect(roles.map((r) => r.id)).toContain("architect");
    // Optional roles appear only when the org pack enables them.
    expect(roles.map((r) => r.id)).toContain("sre");
    expect(roles.map((r) => r.id)).not.toContain("security-reviewer");
  });

  it("defaults the view from a group the org pack maps, and names where it came from", async () => {
    await mkdir(join(root, ".atticus"), { recursive: true });
    await writeFile(join(root, ".atticus/me.yaml"), "groups: [Forge Architects]\n");
    const me = await call("GET", "/api/me");
    expect(me.body).toMatchObject({
      view: "architect",
      source: "group",
      sourceGroup: "Forge Architects",
    });
    // Approvals come from ownership: the group grants waivers; the view grants nothing.
    const approvals = me.body.approvals as { action: string; because: string }[];
    expect(approvals.map((a) => a.action)).toEqual(["waiver"]);
    expect(approvals[0]!.because).toMatch(/Forge Architects/);
    expect(me.body.owns).toEqual(["openspec/changes/*/design.md"]);
  });

  it("remembers a chosen view per person, keeps their groups, and refuses an unknown role", async () => {
    const put = await call("PUT", "/api/me", { view: "qa" });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ view: "qa", source: "chosen" });
    const saved = parse(await readFile(join(root, ".atticus/me.yaml"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(saved).toEqual({ groups: ["Forge Architects"], view: "qa" });
    // Choosing the QA view doesn't take away the approvals the group gives.
    expect((put.body.approvals as unknown[]).length).toBe(1);
    expect((await call("PUT", "/api/me", { view: "emperor" })).status).toBe(400);
    expect((await call("PUT", "/api/me", { view: "security-reviewer" })).status).toBe(400);
  });
});
