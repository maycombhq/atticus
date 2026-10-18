import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readWorkItemExport, readWorkItemExports } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "fixtures/work-items");
const FORGE = join(HERE, "../../../fixtures/forge");
const bytes = (p: string) => new Uint8Array(readFileSync(p));

/**
 * Exported work items (ADR 0032: when the work tracker can't be reached, its exports in
 * inputs/ are read instead). Expected values are written by hand from the fixture files.
 */
describe("readWorkItemExport", () => {
  it("reads an Azure DevOps REST export: types, parents, tags and linked pull requests", () => {
    const path = "inputs/tickets/ado-rest-export.json";
    expect(readWorkItemExport(path, bytes(join(ROOT, path)))).toEqual([
      {
        system: "ado",
        id: "7001",
        type: "epic",
        title: "Move money between accounts",
        state: "Active",
        tags: ["payments", "ledger"],
        url: "https://dev.example.com/contoso/payments/_workitems/edit/7001",
        pullRequests: [
          {
            id: "42",
            repo: "forge-ledger",
            paths: ["src/main/java/forge/ledger/LedgerEndpoints.java"],
          },
        ],
        source: { path, line: 5 },
      },
      {
        system: "ado",
        id: "7002",
        type: "feature",
        title: "Account balance in the portal",
        state: "Closed",
        tags: [],
        parent: "7001",
        description: "Customers see their balance.",
        pullRequests: [],
        source: { path, line: 25 },
      },
      {
        system: "ado",
        id: "7003",
        type: "task",
        title: "Write release notes",
        state: "New",
        tags: [],
        pullRequests: [],
        source: { path, line: 40 },
      },
    ]);
  });

  it("reads a CSV query export, quotes and all", () => {
    const path = "inputs/tickets/ado-query.csv";
    expect(readWorkItemExport(path, bytes(join(ROOT, path)))).toEqual([
      {
        system: "ado",
        id: "8001",
        type: "feature",
        title: "Daily entries report",
        state: "Active",
        tags: ["reporting"],
        pullRequests: [],
        source: { path, line: 2 },
      },
      {
        system: "ado",
        id: "8002",
        type: "story",
        title: "Download the report as CSV, with totals",
        state: "New",
        tags: ["reporting", "export"],
        parent: "8001",
        pullRequests: [],
        source: { path, line: 3 },
      },
      {
        system: "ado",
        id: "8003",
        type: "bug",
        title: 'Report shows "yesterday" twice',
        state: "Closed",
        tags: [],
        parent: "8001",
        pullRequests: [],
        source: { path, line: 4 },
      },
    ]);
  });

  it("reads the flat shape of the Forge ticket export", () => {
    const path = "inputs/tickets/ado-stories.json";
    const items = readWorkItemExport(path, bytes(join(FORGE, path)))!;
    expect(items.map((i) => [i.id, i.type, i.title, i.source.line])).toEqual([
      ["101", "story", "As a customer I can see my available balance", 2],
      ["102", "story", "Transfers", 3],
    ]);
  });

  it("says a file isn't a work-item export rather than guessing", () => {
    const snow = "inputs/tickets/service-requests.json";
    expect(readWorkItemExport(snow, bytes(join(ROOT, snow)))).toBeUndefined();
    expect(readWorkItemExport("notes.md", new TextEncoder().encode("# Notes\n"))).toBeUndefined();
    expect(readWorkItemExport("x.json", new TextEncoder().encode("{ not json"))).toBeUndefined();
  });
});

describe("readWorkItemExports", () => {
  it("collects every work-item export under inputs/, in path order", async () => {
    const res = await readWorkItemExports({ root: ROOT });
    expect(res.files).toEqual([
      "inputs/tickets/ado-query.csv",
      "inputs/tickets/ado-rest-export.json",
    ]);
    expect(res.items.map((i) => i.id)).toEqual(["8001", "8002", "8003", "7001", "7002", "7003"]);
    expect(res.problems).toEqual([]);
  });

  it("reads the Forge inputs, which sit beside the metarepo", async () => {
    const res = await readWorkItemExports({
      root: join(FORGE, "metarepo"),
      inputsDir: join(FORGE, "inputs"),
    });
    expect(res.files).toEqual(["inputs/tickets/ado-stories.json"]);
    expect(res.items.map((i) => i.id)).toEqual(["101", "102"]);
  });
});
