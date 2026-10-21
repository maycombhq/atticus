import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrgPack, orgPackJsonSchemas, ScannerPlugin } from "../src/index.js";

const good = {
  schemaVersion: 1,
  id: "forge-house-routes",
  version: "1.0.0",
  description: "Reads the Forge house web framework's route tables.",
  emits: ["Interface"],
  appliesTo: { repoTypes: ["forge-house"] },
  entry: "index.js",
  sha256: "a".repeat(64),
};

describe("scanner plugin manifests (ADR 0080)", () => {
  it("parses a manifest, with default limits, enabled, and no dialects", () => {
    expect(ScannerPlugin.parse(good)).toEqual({
      ...good,
      appliesTo: { repoTypes: ["forge-house"], dialects: [] },
      limits: { timeoutMs: 10000, memoryMb: 64 },
      enabled: true,
    });
  });

  it("refuses an unsafe entry, an unknown record kind, a bad pin, no target, or wild limits", () => {
    const ok = (patch: object) => ScannerPlugin.safeParse({ ...good, ...patch }).success;
    expect(ok({})).toBe(true);
    expect(ok({ entry: "../other/index.js" })).toBe(false);
    expect(ok({ entry: "/abs/index.js" })).toBe(false);
    expect(ok({ entry: "index.ts" })).toBe(false);
    expect(ok({ emits: ["Spaceship"] })).toBe(false);
    expect(ok({ emits: [] })).toBe(false);
    expect(ok({ sha256: "not-a-hash" })).toBe(false);
    expect(ok({ appliesTo: { repoTypes: [], dialects: [] } })).toBe(false);
    expect(ok({ appliesTo: { dialects: ["forge-routes"] } })).toBe(true);
    expect(ok({ limits: { timeoutMs: 10, memoryMb: 64 } })).toBe(false);
    expect(ok({ limits: { timeoutMs: 10000, memoryMb: 100000 } })).toBe(false);
    // Unpinned parses, so a draft can be tested before `atticus plugin pin`; the scanner refuses it.
    expect(ok({ sha256: undefined })).toBe(true);
  });

  it("loads org-pack/plugins/<id>/plugin.yaml and reports a folder that doesn't match its id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-plugins-"));
    await mkdir(join(dir, "plugins", "forge-house-routes", "test", "a", "repo"), {
      recursive: true,
    });
    await writeFile(
      join(dir, "plugins", "forge-house-routes", "plugin.yaml"),
      JSON.stringify(good),
    );
    // A plugin.yaml inside a plugin's test repo is test data, not a plugin.
    await writeFile(
      join(dir, "plugins", "forge-house-routes", "test", "a", "repo", "plugin.yaml"),
      "nonsense: [",
    );
    await mkdir(join(dir, "plugins", "misnamed"), { recursive: true });
    await writeFile(join(dir, "plugins", "misnamed", "plugin.yaml"), JSON.stringify(good));
    const op = await loadOrgPack(dir);
    expect(op.plugins.map((p) => [p.manifest.id, p.dir])).toEqual([
      ["forge-house-routes", join(dir, "plugins", "forge-house-routes")],
    ]);
    expect(op.problems.filter((p) => p.file.startsWith("plugins/"))).toEqual([
      expect.objectContaining({
        file: "plugins/misnamed/plugin.yaml",
        path: "id",
        message: "is forge-house-routes; keep it in plugins/forge-house-routes/",
      }),
    ]);
    expect(Object.keys(orgPackJsonSchemas())).toContain("ScannerPlugin");
  });
});
