import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Api, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiCiteRoutes } from "../src/ui-api-cites.js";

const ESTATE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/estate");

let srv: RunningServer;
let root: string;

beforeAll(async () => {
  // The estate fixture: its catalog, the two repos' specs, and the joins.
  root = await mkdtemp(join(tmpdir(), "atticus-ui-cites-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  for (const r of parse(await readFile(join(ESTATE, "catalog.yaml"), "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    const file = join(root, "catalog", "generated", recordPath(p.record));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, serializeRecord(p.record));
  }
  await cp(join(ESTATE, "specs"), join(root, "specs"), { recursive: true });
  srv = await startServer({ root, port: 0, extend: (r, ctx) => uiCiteRoutes(r, ctx) });
});

afterAll(async () => {
  await srv?.close();
});

const get = async (path: string) => {
  const r = await fetch(srv.url + path, { headers: { "X-Atticus-Token": srv.token } });
  return { status: r.status, body: (await r.json()) as unknown };
};

describe("GET /api/cites (ADR 0094)", () => {
  it("gives each cited line of a file with the flow steps and records that cite it", async () => {
    const r = await get(
      "/api/cites?repo=forge-customers&path=src/main/java/forge/customers/CustomerController.java",
    );
    expect(r.status).toBe(200);
    const v = Api.CiteList.parse(r.body);
    const at = (n: number) => v.lines.find((l) => l.line === n);
    expect(v.lines.map((l) => l.line)).toEqual(
      [...v.lines.map((l) => l.line)].sort((a, b) => a - b),
    );
    // Line 10: the trigger of create-customer, and the Endpoint record read from it.
    expect(at(10)!.flows).toEqual([
      {
        repo: "forge-customers",
        flow: "forge-customers.create-customer",
        name: "A client creates a customer",
        step: 0,
        kind: "endpoint",
      },
    ]);
    expect(at(10)!.records).toContainEqual({
      kind: "Endpoint",
      id: "forge-customers.post-customer",
      source: "code",
    });
    // Line 12: the write step.
    expect(at(12)!.flows[0]).toMatchObject({ step: 3, kind: "write" });
  });

  it("is empty for a file nothing cites, and needs both repo and path", async () => {
    const r = await get("/api/cites?repo=forge-web&path=src/nothing.ts");
    expect(Api.CiteList.parse(r.body).lines).toEqual([]);
    expect((await get("/api/cites?repo=forge-web")).status).toBe(400);
    expect((await get("/api/cites?path=src/x.ts")).status).toBe(400);
  });

  it("reads a spec again after it changes", async () => {
    const path = "src/app/customers/customer-form.component.ts";
    const before = Api.CiteList.parse((await get(`/api/cites?repo=forge-web&path=${path}`)).body);
    const f = join(root, "specs/forge-web/forge-web.save-customer.yaml");
    const text = await readFile(f, "utf8");
    await writeFile(f, text.replace("A person saves a new customer", "Someone saves a customer"));
    const after = Api.CiteList.parse((await get(`/api/cites?repo=forge-web&path=${path}`)).body);
    expect(
      before.lines.some((l) => l.flows.some((x) => x.name === "A person saves a new customer")),
    ).toBe(true);
    expect(
      after.lines.some((l) => l.flows.some((x) => x.name === "Someone saves a customer")),
    ).toBe(true);
  });
});

describe("changes in flight on a cited line (WP7.3)", () => {
  it("names the changes whose target flows touch a flow that cites the line, and not a released one", async () => {
    const changes = join(root, "openspec", "changes");
    for (const [id, state] of [
      ["add-customer-tags", "design"],
      ["old-customer-fix", "released"],
    ] as const) {
      await mkdir(join(changes, id, "target-flows"), { recursive: true });
      await writeFile(
        join(changes, id, "change.yaml"),
        `schemaVersion: 1\nid: ${id}\nstate: ${state}\n`,
      );
      await writeFile(
        join(changes, id, "target-flows", "forge-customers.create-customer.yaml"),
        "schemaVersion: 2\nflow: forge-customers.create-customer\n",
      );
    }
    const r = await get(
      "/api/cites?repo=forge-customers&path=src/main/java/forge/customers/CustomerController.java",
    );
    const v = Api.CiteList.parse(r.body);
    const line10 = v.lines.find((l) => l.line === 10)!;
    expect(line10.flows[0]!.changes).toEqual(["add-customer-tags"]);
  });
});
