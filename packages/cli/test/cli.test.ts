import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

const SYSTEM = `schemaVersion: 1
kind: System
id: ledger
status: current
confidence: verified
accessGroup: everyone
boundary: product
evidence:
  - path: services.yaml
    source: config
name: Ledger
repos: []
tags: []
`;

async function catalogWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-cli-"));
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, text, "utf8");
  }
  return dir;
}

describe("atticus CLI", () => {
  it("prints help and version", async () => {
    const c = capture();
    expect(await main([], c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("catalog validate");
    const v = capture();
    expect(await main(["--version"], v.io)).toBe(0);
    expect(v.out[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("returns 2 for unknown commands", async () => {
    const c = capture();
    expect(await main(["frobnicate"], c.io)).toBe(2);
  });

  it("exports one JSON Schema per kind and the workspace schemas", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-schema-"));
    const c = capture();
    expect(await main(["schema", "export", dir], c.io)).toBe(0);
    expect(await readdir(join(dir, "catalog"))).toHaveLength(29);
    expect(await readdir(join(dir, "orgpack"))).toHaveLength(12);
    expect(JSON.parse(await readFile(join(dir, "api", "openapi.json"), "utf8")).openapi).toBe(
      "3.1.0",
    );
    expect((await readdir(join(dir, "ai"))).sort()).toEqual([
      "ContextPackManifest.json",
      "Recording.json",
      "RunSummary.json",
    ]);
    expect((await readdir(join(dir, "rules"))).sort()).toEqual([
      "ChecklistPack.json",
      "Dialect.json",
      "Finding.json",
    ]);
    expect((await readdir(join(dir, "workspace"))).sort()).toEqual([
      "ChangeLifecycle.json",
      "ChangeRepos.json",
      "RepoManifest.json",
    ]);
    const system = JSON.parse(await readFile(join(dir, "catalog", "System.json"), "utf8"));
    expect(system.title).toBe("System");
  });

  it("validates the Forge org pack and reports problems in a broken one", async () => {
    const forge = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../fixtures/forge/metarepo/org-pack",
    );
    const ok = capture();
    expect(await main(["orgpack", "validate", forge], ok.io)).toBe(0);
    expect(ok.out.at(-1)).toBe("Org pack is valid");
    const bad = await catalogWith({
      "org-pack/roles.yaml": "schemaVersion: 1\nmappings: [{ group: g, role: wizard }]\n",
    });
    const c = capture();
    expect(await main(["orgpack", "validate", "--root", bad], c.io)).toBe(1);
    expect(c.err[0]).toBe("roles.yaml (mappings.0.role): unknown role wizard");
  });

  it("passes a valid, canonical, correctly placed catalog", async () => {
    const dir = await catalogWith({ "system/ledger.yaml": SYSTEM });
    const c = capture();
    expect(await main(["catalog", "validate", dir], c.io)).toBe(0);
    expect(c.err).toEqual([]);
  });

  it("flags invalid, misplaced and non-canonical files with exit code 1", async () => {
    const reordered = SYSTEM.replace("name: Ledger\n", "").replace(
      "schemaVersion: 1\n",
      "name: Ledger\nschemaVersion: 1\n",
    );
    const dir = await catalogWith({
      "system/ledger.yaml": reordered,
      "wrong/place.yaml": SYSTEM,
      "system/bad.yaml": "kind: System\n",
    });
    const c = capture();
    expect(await main(["catalog", "validate", dir], c.io)).toBe(1);
    const errors = c.err.join("\n");
    expect(errors).toContain("system/bad.yaml");
    expect(errors).toContain("should be at system/ledger.yaml");
    expect(errors).toContain("not in canonical form");
  });

  it("rewrites non-canonical files with --fix", async () => {
    const reordered = SYSTEM.replace("name: Ledger\n", "").replace(
      "schemaVersion: 1\n",
      "name: Ledger\nschemaVersion: 1\n",
    );
    const dir = await catalogWith({ "system/ledger.yaml": reordered });
    const c = capture();
    expect(await main(["catalog", "validate", dir, "--fix"], c.io)).toBe(0);
    expect(await readFile(join(dir, "system/ledger.yaml"), "utf8")).toBe(SYSTEM);
  });
});
