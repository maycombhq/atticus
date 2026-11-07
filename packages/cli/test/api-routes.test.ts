import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openApiDocument } from "@maycombhq/core";
import { startServer, type Router, type RunningServer } from "@maycombhq/server";
import { extendUiRoutes } from "../src/ui-commands.js";

/**
 * The API document (C4) and the server agree: every path and method the document promises has a
 * route, so a caller following docs/api/openapi.json never meets "There is no API call". The
 * app's routes are registered the one way the app registers them (extendUiRoutes).
 */

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge/metarepo");
let srv: RunningServer;
let router: Router | undefined;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "atticus-api-routes-"));
  await cp(join(FORGE, "org-pack"), join(root, "org-pack"), { recursive: true });
  await writeFile(join(root, "org-pack/sources.yaml"), "schemaVersion: 1\nwikis: []\n");
  srv = await startServer({
    root,
    port: 0,
    extend: (r, ctx) => {
      router = extendUiRoutes(r, ctx);
      return router;
    },
  });
});
afterAll(() => srv?.close());

describe("the API document and the routes", () => {
  it("every documented path and method has a route", () => {
    const doc = openApiDocument() as { paths: Record<string, Record<string, unknown>> };
    const missing: string[] = [];
    for (const [path, ops] of Object.entries(doc.paths))
      for (const method of Object.keys(ops)) {
        const m = router!.match(method.toUpperCase(), path.replace(/\{[^}]+\}/g, "x"));
        if ("allowed" in m) missing.push(`${method.toUpperCase()} ${path}`);
      }
    expect(missing).toEqual([]);
  });
});
