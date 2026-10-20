import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fsRepo, memoryRepo } from "@maycombhq/sdk";
import { learnJsFramework, learnJsFrameworkFromTarball } from "../src/index.js";

const MESSY = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/messy");
const LANTERN = join(MESSY, "repos/tide-lantern");
const SHA = "c".repeat(40);

/** What both the source and the published package say, whatever the ref. */
const lanternModel = (
  ref: (path: string) => string,
  files: { index: string; client: string; server: string; request: string },
) => ({
  schemaVersion: 1,
  name: "tide-lantern",
  packages: ["@tide/lantern"],
  artifacts: [],
  annotations: [],
  clients: [],
  calls: [
    {
      function: "call",
      receiver: "lantern",
      language: "js",
      kind: "http-call",
      service: { arg: 0 },
      httpMethod: { arg: 1 },
      path: { arg: 2 },
      source: { kind: "code", ref: ref(files.client) },
    },
    {
      function: "useApi",
      language: "js",
      kind: "http-call",
      service: { arg: 0, key: "service" },
      httpMethod: { arg: 0, key: "method" },
      path: { arg: 0, key: "path" },
      source: { kind: "code", ref: ref(files.index) },
    },
  ],
  routes: [
    {
      function: "defineRoute",
      language: "js",
      httpMethod: { arg: 0, key: "method" },
      path: { arg: 0, key: "path" },
      source: { kind: "code", ref: ref(files.server) },
    },
    {
      function: "route",
      receiver: "router",
      language: "js",
      httpMethod: { arg: 0 },
      path: { arg: 1 },
      source: { kind: "code", ref: ref(files.server) },
    },
  ],
  services: {},
  constants: {
    "Services.BFF": { value: "web-bff", source: { kind: "code", ref: ref(files.request) } },
    "Services.CARDS": { value: "cards", source: { kind: "code", ref: ref(files.request) } },
  },
  tests: [],
});

const NOTE =
  "Services.BFF, Services.CARDS look like service ids: their base URLs aren't in the code; add them under services: (from the registry's config or a person).";

describe("learning a JS or TS framework model (ADR 0055)", () => {
  it("reads its source: exported functions and the methods of exported clients and routers, by parameter names", async () => {
    const r = await learnJsFramework(fsRepo("tide-lantern", LANTERN, SHA), {
      name: "tide-lantern",
    });
    expect(r.model).toEqual(
      lanternModel((p) => `tide-lantern:${p}`, {
        index: "src/index.ts",
        client: "src/client.ts",
        server: "src/server.ts",
        request: "src/request.ts",
      }),
    );
    expect(r.notes).toEqual([NOTE]);
  });

  it("reads the same from a published package's typings, naming the tarball and its checksum", async () => {
    const bytes = await readFile(join(MESSY, "npm/tide-lantern-4.1.0.tgz"));
    const sha = createHash("sha256").update(bytes).digest("hex");
    const r = learnJsFrameworkFromTarball(bytes, {
      name: "tide-lantern",
      tarballName: "tide-lantern-4.1.0.tgz",
    });
    expect(r.model).toEqual(
      lanternModel((p) => `tide-lantern-4.1.0.tgz!${p} sha256:${sha}`, {
        index: "dist/index.d.ts",
        client: "dist/client.d.ts",
        server: "dist/server.d.ts",
        request: "dist/request.d.ts",
      }),
    );
  });

  it("reads events too, and leaves out what isn't exported or doesn't name a path or topic", async () => {
    const r = await learnJsFramework(
      memoryRepo("kit", SHA, {
        "package.json": '{ "name": "@tide/events" }',
        "src/index.ts": `export function publish(topic: string, payload: unknown): void {}
export function subscribe(topic: string, handler: (m: unknown) => void): void {}
function internal(path: string, method: string) {}
export function get(path: string): Promise<unknown> { return fetch(path); }
export function log(message: string): void {}`,
      }),
      { name: "tide-events" },
    );
    expect(
      [...r.model.calls, ...r.model.routes].map(
        (e) =>
          `${e.function} ${"kind" in e ? e.kind : "route"} ${JSON.stringify(e.httpMethod ?? null)} ${JSON.stringify(e.path)}`,
      ),
    ).toEqual([
      'get http-call {"value":"GET"} {"arg":0}',
      'publish event-publish null {"arg":0}',
      'subscribe event-subscribe null {"arg":0}',
    ]);
  });
});
