import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { forgetCatalogs, keepCatalogsInMemory, readCatalog, writeCatalog } from "../src/files.js";

/**
 * The local server keeps the catalog it read in memory until a file changes (ADR 0119): a
 * metarepo's 1,500 records took 3 s to read on every request. A one-shot command reads as before.
 */

/** A data store record, with the store type the tests change. */
const record = (id: string, storeType: string) =>
  [
    "schemaVersion: 2",
    "kind: DataStore",
    `id: ${id}`,
    "status: current",
    "confidence: verified",
    "evidence:",
    "  - commit: 6ef8ed0f115024e860c495e84875f1926c412036",
    "    extractor: migrations@1.3.0",
    "    line: 1",
    "    path: shop/db/V1__init.sql",
    "    repo: shop",
    "    scannedAt: 2026-10-20T20:14:16.096Z",
    "    source: migration",
    "ownerComponent: shop",
    `storeType: ${storeType}`,
    "",
  ].join("\n");

const dirs: string[] = [];
async function catalog(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-catalog-memory-"));
  dirs.push(dir);
  await mkdir(join(dir, "datastore"), { recursive: true });
  await writeFile(join(dir, "datastore", "shop-db.yaml"), record("shop-db", "postgres"));
  return dir;
}

afterEach(async () => {
  keepCatalogsInMemory(false);
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const names = async (dir: string) =>
  (await readCatalog(dir)).records.map((r) => (r as { storeType?: string }).storeType);

describe("the catalog kept in memory (ADR 0119)", () => {
  it("reads the files every time when nothing keeps it", async () => {
    const dir = await catalog();
    const first = await readCatalog(dir);
    expect(first.problems).toEqual([]);
    expect(first.records.map((r) => (r as { storeType?: string }).storeType)).toEqual(["postgres"]);
    await writeFile(join(dir, "datastore", "shop-db.yaml"), record("shop-db", "h2"));
    expect(await names(dir)).toEqual(["h2"]);
  });

  it("keeps what it read until told the files changed", async () => {
    keepCatalogsInMemory(true);
    const dir = await catalog();
    expect(await names(dir)).toEqual(["postgres"]);
    await writeFile(join(dir, "datastore", "shop-db.yaml"), record("shop-db", "h2"));
    expect(await names(dir)).toEqual(["postgres"]);
    forgetCatalogs();
    expect(await names(dir)).toEqual(["h2"]);
  });

  it("hands each caller its own copy, so one caller's change never reaches the next", async () => {
    keepCatalogsInMemory(true);
    const dir = await catalog();
    const a = await readCatalog(dir);
    (a.records[0] as { storeType: string }).storeType = "changed by a caller";
    a.records.push(a.records[0]!);
    expect(await names(dir)).toEqual(["postgres"]);
  });

  it("forgets what it kept when it writes the catalog itself", async () => {
    keepCatalogsInMemory(true);
    const dir = await catalog();
    const kept = await readCatalog(dir);
    await writeCatalog(dir, [
      { ...kept.records[0]!, storeType: "oracle" } as (typeof kept.records)[number],
    ]);
    expect(await names(dir)).toEqual(["oracle"]);
  });
});
