import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiSpecRoutes } from "../src/ui-api-specs.js";

const ESTATE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/estate");

let srv: RunningServer;
let unjoined: RunningServer;

const start = (dir: string) =>
  startServer({ root: dir, port: 0, extend: (r, ctx) => uiSpecRoutes(r, ctx) });

beforeAll(async () => {
  // The estate fixture's specs, with the joins atticus estate join writes for them.
  const root = await mkdtemp(join(tmpdir(), "atticus-ui-specs-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await cp(join(ESTATE, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(ESTATE, "expected/estate.yaml"), join(root, "specs/estate.yaml"));
  // A flow file that doesn't read is reported, not fatal.
  await writeFile(join(root, "specs/forge-web/forge-web.broken.yaml"), "kind: Flow\nid: [\n");
  srv = await start(root);

  const bare = await mkdtemp(join(tmpdir(), "atticus-ui-specs-bare-"));
  await mkdir(join(bare, "org-pack"), { recursive: true });
  await cp(join(ESTATE, "specs"), join(bare, "specs"), { recursive: true });
  unjoined = await start(bare);
});

afterAll(async () => {
  await srv?.close();
  await unjoined?.close();
});

const get = async (s: RunningServer, path: string) => {
  const r = await fetch(s.url + path, { headers: { "X-Atticus-Token": s.token } });
  return { status: r.status, body: (await r.json()) as unknown };
};

describe("GET /api/specs (ADR 0092)", () => {
  it("lists the repos with a spec and how many flows each has", async () => {
    const r = await get(srv, "/api/specs");
    expect(r.status).toBe(200);
    expect(Api.SpecList.parse(r.body).repos).toEqual([
      { repo: "forge-customers", flows: 2 },
      { repo: "forge-web", flows: 3 },
    ]);
  });
});

describe("GET /api/specs/{repo}", () => {
  it("gives each flow's trigger, its counts, and the joins in and out", async () => {
    const r = await get(srv, "/api/specs/forge-customers");
    expect(r.status).toBe(200);
    const v = Api.SpecView.parse(r.body);
    expect(v.path).toBe("specs/forge-customers");
    expect(v.flows.map((f) => f.id)).toEqual([
      "forge-customers.create-customer",
      "forge-customers.get-customer",
    ]);
    expect(v.flows[0]).toMatchObject({
      name: "A client creates a customer",
      component: "forge-customers",
      trigger: { kind: "endpoint", what: "POST /customers is called" },
      steps: 4,
      errors: 0,
      calls: 0,
      calledBy: 1,
    });
  });

  it("names a file that doesn't read, and still lists the rest", async () => {
    const v = Api.SpecView.parse((await get(srv, "/api/specs/forge-web")).body);
    expect(v.flows).toHaveLength(3);
    expect(v.problems.map((p) => p.file)).toEqual(["specs/forge-web/forge-web.broken.yaml"]);
    expect(v.flows.find((f) => f.id === "forge-web.save-customer")!.calls).toBe(1);
  });

  it("is a 404 for a repo with no spec, and a 400 for a name that isn't an id", async () => {
    expect((await get(srv, "/api/specs/forge-ledger")).status).toBe(404);
    expect((await get(srv, "/api/specs/..%2Fetc")).status).toBe(400);
  });
});

describe("GET /api/specs/{repo}/flows/{flowId}", () => {
  it("gives the flow, the flows its call-outs start, and their names", async () => {
    const r = await get(srv, "/api/specs/forge-web/flows/forge-web.save-customer");
    expect(r.status).toBe(200);
    const v = Api.FlowView.parse(r.body);
    expect(v.file).toBe("specs/forge-web/forge-web.save-customer.yaml");
    expect(v.joined).toBe(true);
    expect(v.flow.steps).toHaveLength(2);
    expect(v.calls).toEqual([
      {
        step: 1,
        repo: "forge-customers",
        flow: "forge-customers.create-customer",
        name: "A client creates a customer",
        how: "interface",
      },
    ]);
    expect(v.calledBy).toEqual([]);
  });

  it("gives the flows that call it, by their step", async () => {
    const v = Api.FlowView.parse(
      (await get(srv, "/api/specs/forge-customers/flows/forge-customers.get-customer")).body,
    );
    expect(v.calledBy).toEqual([
      {
        step: 1,
        repo: "forge-web",
        flow: "forge-web.view-customer",
        name: expect.any(String),
        how: "path",
      },
    ]);
  });

  it("gives a call-out the estate pass couldn't join, with why", async () => {
    const v = Api.FlowView.parse(
      (await get(srv, "/api/specs/forge-web/flows/forge-web.remove-customer")).body,
    );
    expect(v.calls).toEqual([]);
    expect(v.unmatched).toEqual([
      {
        step: 1,
        entry: "forge-customers DELETE /api/customers/{id}",
        reason: "no-flow",
        message: expect.stringContaining("no flow of forge-customers starts there"),
      },
    ]);
  });

  it("says when the estate pass hasn't run", async () => {
    const v = Api.FlowView.parse(
      (await get(unjoined, "/api/specs/forge-web/flows/forge-web.save-customer")).body,
    );
    expect(v.joined).toBe(false);
    expect(v.calls).toEqual([]);
  });

  it("is a 404 for a flow the repo doesn't have", async () => {
    expect((await get(srv, "/api/specs/forge-web/flows/forge-web.nothing")).status).toBe(404);
  });
});
