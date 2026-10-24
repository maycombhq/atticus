import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrgPack, ModelProviderPlugin, orgPackJsonSchemas } from "../src/index.js";

/**
 * A model-provider plugin (ADR 0121 item 4): org-pack/plugins/model-providers/<id>/plugin.yaml.
 * Its code only turns a prompt into a request and an answer into text, sandboxed; Atticus makes
 * the call, to the hosts the manifest names, and adds the key itself.
 */

const good = {
  schemaVersion: 1,
  id: "northwind-gateway",
  version: "1.0.0",
  description: "Northwind's own model gateway.",
  entry: "index.js",
  settings: ["region", "project"],
  hosts: ["{region}-llm.northwind.example", "llm.northwind.example"],
  sha256: "a".repeat(64),
};

describe("model-provider plugin manifests (ADR 0121)", () => {
  it("parses a manifest, with bearer auth and default limits", () => {
    expect(ModelProviderPlugin.parse(good)).toEqual({
      ...good,
      auth: "bearer",
      limits: { timeoutMs: 5000, memoryMb: 64 },
    });
  });

  it("refuses an unsafe entry, no hosts, a host with a scheme or path, a key setting, a bad pin", () => {
    const ok = (patch: object) => ModelProviderPlugin.safeParse({ ...good, ...patch }).success;
    expect(ok({})).toBe(true);
    expect(ok({ entry: "../x/index.js" })).toBe(false);
    expect(ok({ hosts: [] })).toBe(false);
    expect(ok({ hosts: ["https://llm.northwind.example"] })).toBe(false);
    expect(ok({ hosts: ["llm.northwind.example/v1"] })).toBe(false);
    expect(ok({ settings: ["apiKey"] })).toBe(false);
    expect(ok({ sha256: "nope" })).toBe(false);
    expect(ok({ auth: "x-api-key" })).toBe(true);
    expect(ok({ auth: "header:x-northwind-key" })).toBe(true);
    expect(ok({ auth: "none" })).toBe(true);
    expect(ok({ auth: "cookie" })).toBe(false);
  });

  it("is loaded from plugins/model-providers/, apart from the scanner plugins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-mpp-"));
    const at = join(dir, "plugins", "model-providers", "northwind-gateway");
    await mkdir(at, { recursive: true });
    await writeFile(join(at, "plugin.yaml"), JSON.stringify(good));
    const wrong = join(dir, "plugins", "model-providers", "elsewhere");
    await mkdir(wrong, { recursive: true });
    await writeFile(join(wrong, "plugin.yaml"), JSON.stringify(good));
    const op = await loadOrgPack(dir);
    expect(op.modelProviders.map((p) => p.manifest.id)).toEqual(["northwind-gateway"]);
    expect(op.modelProviders[0]!.dir).toBe(at);
    expect(op.plugins).toEqual([]);
    expect(op.problems.map((p) => p.message)).toEqual([
      "is northwind-gateway; keep it in plugins/model-providers/northwind-gateway/",
    ]);
  });

  it("has a JSON Schema", () => {
    expect(orgPackJsonSchemas()).toHaveProperty("ModelProviderPlugin");
  });
});
