import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { estateDependencies, uiGraphRoutes } from "../src/ui-api-graph.js";

/**
 * ADR 0192: the Architecture canvas draws a component's build dependency on a library another
 * repo of the estate publishes, joined from the verified facts on file
 * (`fixtures/library-deps/`, invented), beside the catalog's calls and never among them.
 */
const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/library-deps");

let srv: RunningServer;
let root: string;

const component = (id: string, repo: string, system: string) => {
  const p = parseRecord({
    schemaVersion: 1,
    status: "current",
    confidence: "verified",
    kind: "Component",
    id,
    repo,
    system,
    type: "service",
    evidence: [{ source: "code", repo, path: "pom.xml", line: 1 }],
  });
  if (!p.ok) throw new Error(JSON.stringify(p.issues));
  return p.record;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-ui-graph-deps-"));
  await cp(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(FIX, "facts"), join(root, "facts"), { recursive: true });
  for (const r of [
    component("payments-common", "forge-payments-common", "payments"),
    component("ledger-api", "forge-ledger", "ledger"),
    component("statements-api", "forge-statements", "ledger"),
    component("wallets-api", "forge-wallets", "wallets"),
    component("wallets-batch", "forge-wallets", "wallets"),
  ]) {
    const f = join(root, "catalog/generated", recordPath(r));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(r));
  }
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    extend: (r, ctx) => uiGraphRoutes(r, ctx),
  });
});
afterAll(async () => {
  await srv?.close();
});

const get = async (path: string) => {
  const r = await fetch(srv.url + path, { headers: { "X-Atticus-Token": srv.token } });
  return { status: r.status, body: (await r.json()) as unknown };
};

describe("depends-on edges from the facts on file (ADR 0192)", () => {
  it("joins each verified dependency to the component that publishes its coordinates", async () => {
    const links = await estateDependencies(root);
    expect(links.map((l) => `${l.from.component} > ${l.to.component}`)).toEqual([
      "ledger-api > payments-common",
      "statements-api > payments-common",
      "wallets-api > payments-common",
    ]);
  });

  it("is none with no org pack, and none with no dependency fact", async () => {
    const bare = await mkdtemp(join(tmpdir(), "atticus-ui-graph-deps-bare-"));
    expect(await estateDependencies(bare)).toEqual([]);
  });

  it("draws them on the canvas as depends-on edges, in the shape the contract gives", async () => {
    const r = await get("/api/graph/node/estate");
    expect(r.status).toBe(200);
    const v = Api.GraphNodeView.parse(r.body);
    expect(v.edges.map((e) => `${e.from} ${e.type} ${e.to} x${e.count}`).sort()).toEqual([
      "system:ledger depends-on system:payments x2",
      "system:wallets depends-on system:payments x1",
    ]);
    const e = v.edges.find((x) => x.from === "system:wallets")!;
    expect(e.joins?.[0]).toMatchObject({
      how: "coordinates",
      verified: true,
      dependency: { group: "forge.payments", name: "forge-payments-common" },
      caller: [
        { repo: "forge-wallets", at: "wallets-api/pom.xml:13" },
        { repo: "forge-wallets", at: "wallets-api/pom.xml:12" },
      ],
    });
  });
});
