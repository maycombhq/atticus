import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import type { ContractCheckOnFile } from "../src/contract-check-files.js";
import { uiContractsRoutes } from "../src/ui-api-contracts.js";
import { uiGraphRoutes } from "../src/ui-api-graph.js";

/**
 * The Architecture canvas never waits on the contract check: the picture is the graph API's,
 * and a first contract check (the estate joined and compared) can take a while on a big
 * estate. While one is pending, the graph still answers.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const servers: RunningServer[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
});

describe("GET /api/graph while the contract check is under way", () => {
  it("answers the picture's requests before a slow contract check is done", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-ui-contracts-graph-"));
    await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
    for (const r of parse(
      readFileSync(join(FIXTURES, "forge/expected/scan.yaml"), "utf8"),
    ) as Record<string, unknown>[]) {
      const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
      if (!p.ok) continue;
      const f = join(root, "catalog/generated", recordPath(p.record));
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, serializeRecord(p.record));
    }
    let finish!: (v: ContractCheckOnFile) => void;
    const slow = new Promise<ContractCheckOnFile>((r) => (finish = r));
    let asked = 0;
    const srv = await startServer({
      root,
      port: 0,
      user: "pat",
      extend: (r, ctx) =>
        uiContractsRoutes(uiGraphRoutes(r, ctx), ctx, {
          check: () => {
            asked++;
            return slow;
          },
        }),
    });
    servers.push(srv);
    const get = (path: string) =>
      fetch(srv.url + path, { headers: { "X-Atticus-Token": srv.token } });
    let contractsDone = false;
    const contracts = get("/api/contracts").then((r) => {
      contractsDone = true;
      return r;
    });
    // The check has started and is pending.
    for (let i = 0; i < 50 && asked === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(asked).toBe(1);
    const estate = await get("/api/graph/node/estate?lens=architecture");
    expect(estate.status).toBe(200);
    const layout = await get("/api/graph/layout/architecture.estate");
    expect(layout.status).toBe(200);
    expect(contractsDone).toBe(false);
    finish({
      result: { links: [], findings: [], counts: { links: 0, compared: 0, findings: 0 } },
      notes: [],
      outside: [],
      newBySystem: new Map(),
    } as unknown as ContractCheckOnFile);
    expect((await contracts).status).toBe(200);
  });
});
