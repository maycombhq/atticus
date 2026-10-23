import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { main } from "../src/main.js";
import { uiSpecRoutes } from "../src/ui-api-specs.js";

/** atticus change estimate (ADR 0109): a change's size and ranges, from its target flows. */

const STAGES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/stages");

const ESTIMATES = [
  "schemaVersion: 1",
  'source: "the Forge platform team, September 2026 (invented figures)"',
  "classes:",
  "  - { match: add/call-out/*, days: { p20: 1, p50: 2, p80: 4 } }",
  "  - { match: add/branch, days: { p20: 0.25, p50: 0.5, p80: 1 } }",
  "",
].join("\n");

async function metarepo(o: { targets: boolean; estimates?: string }) {
  const root = await mkdtemp(join(tmpdir(), "atticus-estimate-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  if (o.estimates !== undefined)
    await writeFile(join(root, "org-pack/estimates.yaml"), o.estimates);
  await cp(join(STAGES, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(STAGES, "changes"), join(root, "openspec/changes"), { recursive: true });
  if (o.targets) {
    const target = join(root, "openspec/changes/add-fraud-check/target-flows");
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, "forge-orders.place-order.yaml"),
      [
        "schemaVersion: 1",
        "flow: forge-orders.place-order",
        "repo: forge-orders",
        "change: modify",
        "why: The order is screened before stock is reserved.",
        "steps:",
        "  - { op: add, after: 1, kind: call-out, what: Northwind Pay screens the order, to: { component: northwind-pay, entry: POST /v1/screenings, new: true } }",
        "  - { op: add, after: 1, kind: branch, what: A rejected order is refused with 422 }",
        "  - { op: add, after: 1, kind: log, what: The verdict is logged }",
        "",
      ].join("\n"),
    );
  }
  return root;
}

const run = async (args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    args,
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    {
      quiet: true,
    },
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
};

describe("atticus change estimate", () => {
  it("counts the work from the target flows, sums the org pack's ranges, and names who agreed them", async () => {
    const root = await metarepo({ targets: true, estimates: ESTIMATES });
    const r = await run(["change", "estimate", "add-fraud-check", "--json", "--root", root]);
    expect(r.code).toBe(0);
    const e = Api.ChangeEstimate.parse(JSON.parse(r.out));
    expect(e.units.map((u) => u.class)).toEqual([
      "add/call-out/new-entry",
      "add/branch",
      "add/log",
    ]);
    expect(e.needsClass).toBe(1);
    expect(e.effort!.p50).toBeGreaterThan(2);
    expect(e.effort!.p50).toBeLessThan(3.5);
    expect(e.table).toBe("org-pack/estimates.yaml");
    expect(e.calibration).toEqual({
      calibrated: false,
      source: "the Forge platform team, September 2026 (invented figures)",
    });
    expect(e.units[0]!.source).toBe(
      "openspec/changes/add-fraud-check/target-flows/forge-orders.place-order.yaml",
    );
  });

  it("prints the range, the work and what needs a class", async () => {
    const root = await metarepo({ targets: true, estimates: ESTIMATES });
    const r = await run(["change", "estimate", "add-fraud-check", "--root", root]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Estimate for add-fraud-check: /);
    expect(r.out).toMatch(/Effort: [\d.]+-[\d.]+ days \(p50 [\d.]+\), from 2 of 3 units of work\./);
    expect(r.out).toContain("Not calibrated yet: the ranges are the Forge platform team");
    expect(r.out).toMatch(/add\/log {2}needs a class {2}The verdict is logged/);
  });

  it("without estimates.yaml sizes the work and gives no days; a broken one is said", async () => {
    const plain = await run([
      "change",
      "estimate",
      "add-fraud-check",
      "--root",
      await metarepo({ targets: true }),
    ]);
    expect(plain.out).toContain(
      "Size: 3 units of work. No days: the org pack has no estimates.yaml.",
    );
    const broken = await run([
      "change",
      "estimate",
      "add-fraud-check",
      "--root",
      await metarepo({ targets: true, estimates: "schemaVersion: 1\nclasses: []\n" }),
    ]);
    expect(broken.err).toMatch(/^estimates\.yaml: /m);
  });

  it("says what to run before the architecture stage, and refuses a change that isn't there", async () => {
    const root = await metarepo({ targets: false, estimates: ESTIMATES });
    const r = await run(["change", "estimate", "add-fraud-check", "--root", root]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("atticus change architecture add-fraud-check");
    expect((await run(["change", "estimate", "no-such", "--root", root])).code).toBe(2);
  });
});

describe("GET /api/changes/{id}/estimate (ADR 0109)", () => {
  let srv: RunningServer;
  beforeAll(async () => {
    const root = await metarepo({ targets: true, estimates: ESTIMATES });
    srv = await startServer({ root, port: 0, extend: (r, ctx) => uiSpecRoutes(r, ctx) });
  });
  afterAll(async () => srv?.close());
  const get = async (path: string) => {
    const r = await fetch(srv.url + path, { headers: { "X-Atticus-Token": srv.token } });
    return { status: r.status, body: (await r.json()) as unknown };
  };

  it("answers the estimate, and a 404 for a change that isn't there", async () => {
    const r = await get("/api/changes/add-fraud-check/estimate");
    expect(r.status).toBe(200);
    expect(Api.ChangeEstimate.parse(r.body).units).toHaveLength(3);
    expect((await get("/api/changes/no-such/estimate")).status).toBe(404);
  });
});
