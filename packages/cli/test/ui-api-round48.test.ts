import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "@maycombhq/server";
import { extendUiRoutes } from "../src/ui-commands.js";

/**
 * Review round 48 (the app server): one sync and one reconcile at a time on a server, and a
 * change id or a view name from the address is checked before it is used, never joined into a
 * path or looked up on an object's prototype.
 */

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge/metarepo");
let root: string;
let srv: RunningServer;

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, text };
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-ui-r48-"));
  await cp(FORGE, root, { recursive: true });
  // A change.yaml outside openspec/changes, which a change id of ../.. would reach.
  await mkdir(join(root, "catalog"), { recursive: true });
  await writeFile(join(root, "catalog", "change.yaml"), "title: not a change of this metarepo\n");
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    watch: false,
    extend: (r, ctx) => extendUiRoutes(r, ctx),
  });
});
afterAll(() => srv?.close());

describe("one sync and one reconcile at a time", () => {
  for (const [kind, path, body] of [
    ["sync", "/api/workspace/sync", {}],
    ["reconcile", "/api/reconcile", { diagram: "context" }],
  ] as const) {
    it(`${path} is 409 while a ${kind} runs on this server`, async () => {
      let done!: () => void;
      const running = srv.jobs.start(kind, () => new Promise<void>((r) => (done = r)));
      try {
        const busy = await call("POST", path, body);
        expect(busy.status).toBe(409);
        expect(busy.text).toContain(running.id);
      } finally {
        done();
      }
      await new Promise((r) => setTimeout(r, 20));
      expect((await call("POST", path, body)).status).toBe(202);
    });
  }
});

describe("a change id from the address is checked first", () => {
  it("GET /api/past-changes?change= is 400 for an id that isn't one, never read outside", async () => {
    for (const bad of ["../../catalog", "..", "a/b", "Upper", "a\\b"]) {
      const r = await call("GET", `/api/past-changes?change=${encodeURIComponent(bad)}`);
      expect(r.status, bad).toBe(400);
      expect(r.text).not.toContain("not a change of this metarepo");
    }
    expect((await call("GET", "/api/past-changes?change=no-such-change")).status).toBe(404);
  });

  it("GET /api/changes/{changeId}/cockpit is 400 for an id that isn't one, 404 for none", async () => {
    for (const bad of ["..%2F..%2Fcatalog", "a%00b", "Upper", "x".repeat(300)]) {
      const r = await call("GET", `/api/changes/${bad}/cockpit`);
      expect(r.status, bad).toBe(400);
      expect(r.text).not.toMatch(/stack|at .*\.js|\/tmp\//);
    }
    expect((await call("GET", "/api/changes/no-such-change/cockpit")).status).toBe(404);
  });
});

describe("a view name is one of the views, never the prototype's", () => {
  it("/api/view/{name} is 404 for toString, __proto__, constructor and hasOwnProperty", async () => {
    for (const name of ["toString", "__proto__", "constructor", "hasOwnProperty", "valueOf"]) {
      expect((await call("GET", `/api/view/${name}`)).status, name).toBe(404);
      expect((await call("GET", `/api/view/${name}/x`)).status, name).toBe(404);
    }
  });
});
