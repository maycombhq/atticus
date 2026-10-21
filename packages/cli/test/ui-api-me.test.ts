import { execFileSync } from "node:child_process";
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

/**
 * ADR 0073: the person is the metarepo's Git user. The temporary metarepo has its own
 * user.name and user.email, so the machine's own Git user doesn't matter. No network.
 */
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-ui-me-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Priya Nair"]);
  execFileSync("git", ["-C", root, "config", "user.email", "priya.nair@forge.example"]);
  // Left from ADR 0044: a view and groups, which nothing reads any more.
  await mkdir(join(root, ".atticus"), { recursive: true });
  await writeFile(
    join(root, ".atticus/me.yaml"),
    "groups: [Forge Architects]\nview: architect\nnotify: { digest: weekly }\n",
  );
  srv = await startServer({ root, port: 0, extend: (r, ctx) => uiMeRoutes(r, ctx) });
});
afterAll(() => srv?.close());

describe("who is using the app (ADR 0073)", () => {
  it("is the metarepo's Git user, with no view, roles or approvals", async () => {
    const me = await call("GET", "/api/me");
    expect(me.status).toBe(200);
    expect(me.body).toEqual({
      user: "priya.nair",
      name: "Priya Nair",
      email: "priya.nair@forge.example",
      source: "git",
      ai: "on",
      notify: { digest: "weekly" },
    });
  });

  it("has no call to choose a view or to list approvals any more", async () => {
    expect((await call("PUT", "/api/me", { view: "qa" })).status).toBe(405);
    expect((await call("GET", "/api/me/approvals")).status).toBe(404);
  });

  it("keeps the digest settings, and drops the old view and groups when it saves", async () => {
    const put = await call("PUT", "/api/me/notify", { digest: "daily" });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ user: "priya.nair", notify: { digest: "daily" } });
    expect(parse(await readFile(join(root, ".atticus/me.yaml"), "utf8"))).toEqual({
      notify: { digest: "daily" },
    });
  });

  it("hands the person to whoever started the server, and --by still names someone", async () => {
    expect(srv.person).toMatchObject({ handle: "priya.nair", source: "git" });
    const other = await startServer({ root, port: 0, user: "ari" });
    try {
      expect(other.person).toEqual({ handle: "ari", source: "given" });
      const h = await fetch(other.url + "/api/health", {
        headers: { "X-Atticus-Token": other.token },
      });
      expect(((await h.json()) as { user: string }).user).toBe("ari");
    } finally {
      await other.close();
    }
  });
});
