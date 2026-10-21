import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CatalogBaseline, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { main } from "../src/main.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

async function metarepo(scanned: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-baseline-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  if (scanned)
    for (const r of parse(
      readFileSync(join(FIXTURES, "forge/expected/scan.yaml"), "utf8"),
    ) as Record<string, unknown>[]) {
      const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
      if (!p.ok) continue;
      const f = join(root, "catalog/generated", recordPath(p.record));
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, serializeRecord(p.record));
    }
  return root;
}

const run = async (root: string, ...args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...args, "--root", root], {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

interface Step {
  id: string;
  done: boolean;
  fix?: string;
}

describe("atticus setup: the checklist until the catalog is accepted", () => {
  it("lists every step with a plain fix for what isn't done", async () => {
    const r = await run(await metarepo(false), "setup", "--json");
    expect(r.code).toBe(1);
    const steps = (JSON.parse(r.out) as { steps: Step[] }).steps;
    expect(steps.map((s) => s.id)).toEqual([
      "machine",
      "org-pack",
      "repos",
      "clones",
      "scan",
      "knowledge",
      "baseline",
    ]);
    const byId = new Map(steps.map((s) => [s.id, s]));
    expect(byId.get("org-pack")!.done).toBe(true);
    expect(byId.get("repos")!.done).toBe(true);
    expect(byId.get("scan")!.done).toBe(false);
    expect(byId.get("scan")!.fix).toMatch(/atticus scan/);
    expect(byId.get("baseline")!.fix).toMatch(/atticus baseline/);
    expect(byId.get("baseline")!.fix).toMatch(/pull request/);
    // ADR 0073: no step maps groups to roles any more.
    expect(steps.some((s) => /role/i.test(`${s.id} ${s.fix ?? ""}`))).toBe(false);
  });
});

describe("atticus baseline", () => {
  it("refuses an empty catalog, saying to scan first", async () => {
    const r = await run(await metarepo(false), "baseline", "--by", "priya");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/scan first/i);
  });

  it("records the metarepo's Git user when --by isn't given (ADR 0073)", async () => {
    const root = await metarepo(true);
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "config", "user.name", "Priya Nair"]);
    execFileSync("git", ["-C", root, "config", "user.email", "priya.nair@forge.example"]);
    const r = await run(root, "baseline");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Accepted the catalog as the baseline as priya\.nair/);
    expect(r.out).toMatch(/open a pull request/);
    const b = CatalogBaseline.parse(
      parse(await readFile(join(root, "catalog/baseline.yaml"), "utf8")),
    );
    expect(b.acceptedBy).toBe("priya.nair");
  });

  it("records who accepted the catalog and what it held, and the checklist is done", async () => {
    const root = await metarepo(true);
    const r = await run(
      root,
      "baseline",
      "--by",
      "priya",
      "--note",
      "Walked the map with the architects",
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(
      /Accepted the catalog as the baseline as priya: 46 records in 14 kinds, 5 systems/,
    );
    const b = CatalogBaseline.parse(
      parse(await readFile(join(root, "catalog/baseline.yaml"), "utf8")),
    );
    expect(b).toMatchObject({
      acceptedBy: "priya",
      systems: ["audit", "ledger", "northwind-pay", "portal", "reports"],
    });
    expect(b.kinds.Interface).toBe(7);
    const s = JSON.parse((await run(root, "setup", "--json")).out) as {
      steps: Step[];
      baselined: boolean;
    };
    expect(s.baselined).toBe(true);
    expect(s.steps.find((x) => x.id === "baseline")!.done).toBe(true);
  });
});
