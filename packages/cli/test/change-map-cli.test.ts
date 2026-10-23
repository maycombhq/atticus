import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";

/** atticus change map (ADR 0108): a change's picture, from its target flows. */

const STAGES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/stages");

async function metarepo(withTargets: boolean) {
  const root = await mkdtemp(join(tmpdir(), "atticus-change-map-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await cp(join(STAGES, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(STAGES, "changes"), join(root, "openspec/changes"), { recursive: true });
  if (withTargets) {
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

describe("atticus change map", () => {
  it("prints the change's picture as Mermaid, each part's mark in its words", async () => {
    const root = await metarepo(true);
    const r = await run(["change", "map", "add-fraud-check", "--root", root]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^%% Change add-fraud-check: /);
    expect(r.out).toContain('northwind_pay["+ northwind-pay"]');
    expect(r.out).toContain('forge_orders["◇ forge-orders"]');
    expect(r.out).toContain('-->|"+ POST /v1/screenings"|');
  });

  it("draws it as draw.io too", async () => {
    const root = await metarepo(true);
    const r = await run(["change", "map", "add-fraud-check", "--format", "drawio", "--root", root]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^<mxfile/);
  });

  it("says what to run when the change has no target flows yet; as JSON that is flows: 0", async () => {
    const root = await metarepo(false);
    const r = await run(["change", "map", "add-fraud-check", "--root", root]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("atticus change architecture add-fraud-check");
    const j = await run(["change", "map", "add-fraud-check", "--json", "--root", root]);
    expect(j.code).toBe(0);
    expect(JSON.parse(j.out)).toMatchObject({ flows: 0, nodes: [], edges: [] });
  });

  it("refuses a change that isn't there, and a format it can't draw", async () => {
    const root = await metarepo(true);
    expect((await run(["change", "map", "no-such", "--root", root])).code).toBe(2);
    expect(
      (await run(["change", "map", "add-fraud-check", "--format", "png", "--root", root])).code,
    ).toBe(2);
  });
});
