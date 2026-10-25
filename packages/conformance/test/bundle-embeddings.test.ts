import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ADR 0124 addendum D-bundle: the offline bundle leaves out the embedding plugin by default
 * (`scripts/bundle/inventory.mjs`, tested as a module, on an invented deployed folder).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "../../../scripts/bundle/inventory.mjs");
const load = async () =>
  (await import(pathToFileURL(SCRIPT).href)) as {
    embeddingPackage: (name: string) => boolean;
    removePackages: (dir: string, drop: (name: string) => boolean) => string[];
  };

const pkg = async (dir: string, name: string) => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
};

describe("the default bundle without embeddings", () => {
  it("names the plugin's packages and nothing else", async () => {
    const { embeddingPackage } = await load();
    for (const n of [
      "@maycombhq/embed",
      "@maycombhq/embed-model",
      "@maycombhq/onnxruntime-linux-x64",
      "@maycombhq/onnxruntime-win32-arm64",
      "@maycombhq/onnxruntime-wasm",
      "onnxruntime-common",
    ])
      expect(embeddingPackage(n), n).toBe(true);
    for (const n of ["@maycombhq/index", "@maycombhq/cli", "@maycombhq/embedder", "yaml", "onnx"])
      expect(embeddingPackage(n), n).toBe(false);
  });

  it("refuses a model or runtime package that ships a third party's files without their licence (ADR 0124 addendum D-npm)", async () => {
    const { inventory, unlicensedThirdParty } = (await import(pathToFileURL(SCRIPT).href)) as {
      inventory: (dir: string) => { name: string; carriesPinned?: boolean }[];
      unlicensedThirdParty: (items: unknown[]) => string[];
    };
    const dir = await mkdtemp(join(tmpdir(), "atticus-deploy-licence-"));
    const ort = join(dir, "node_modules/@maycombhq/onnxruntime-linux-x64");
    await mkdir(join(ort, "dist"), { recursive: true });
    await writeFile(
      join(ort, "package.json"),
      JSON.stringify({
        name: "@maycombhq/onnxruntime-linux-x64",
        version: "1.0.0",
        license: "MIT",
        atticusRepackaged: { from: "onnxruntime-node@1.0.0" },
      }),
    );
    await writeFile(
      join(ort, "pins.json"),
      JSON.stringify({
        sources: {},
        files: [
          { path: "dist/index.js", source: "a", sha256: "0" },
          { path: "LICENSE", source: "b", sha256: "1" },
        ],
      }),
    );
    // The plugin zip's layout: the pins, none of the files, no licence yet. Nothing ships.
    expect(unlicensedThirdParty(inventory(dir))).toEqual([]);
    // An npm install: the runtime's files are there, so its licence must be too.
    await writeFile(join(ort, "dist/index.js"), "module.exports = {};");
    expect(unlicensedThirdParty(inventory(dir))).toEqual([
      "@maycombhq/onnxruntime-linux-x64@1.0.0 ships onnxruntime-node@1.0.0's files without their licence text",
    ]);
    await writeFile(join(ort, "LICENSE"), "MIT License");
    expect(unlicensedThirdParty(inventory(dir))).toEqual([]);
  });

  it("removes them from a deployed folder, nested copies too, and keeps the rest", async () => {
    const { embeddingPackage, removePackages } = await load();
    const dir = await mkdtemp(join(tmpdir(), "atticus-deploy-test-"));
    const nm = join(dir, "node_modules");
    await pkg(join(nm, "@maycombhq/embed"), "@maycombhq/embed");
    await pkg(join(nm, "@maycombhq/embed-model"), "@maycombhq/embed-model");
    await pkg(join(nm, "@maycombhq/onnxruntime-linux-x64"), "@maycombhq/onnxruntime-linux-x64");
    await pkg(join(nm, "@maycombhq/index"), "@maycombhq/index");
    await pkg(join(nm, "@maycombhq/index/node_modules/onnxruntime-common"), "onnxruntime-common");
    await pkg(join(nm, "yaml"), "yaml");
    expect(removePackages(dir, embeddingPackage)).toEqual([
      "@maycombhq/embed",
      "@maycombhq/embed-model",
      "@maycombhq/onnxruntime-linux-x64",
      "onnxruntime-common",
    ]);
    expect(existsSync(join(nm, "@maycombhq/embed"))).toBe(false);
    expect(existsSync(join(nm, "@maycombhq/index/node_modules/onnxruntime-common"))).toBe(false);
    expect(existsSync(join(nm, "@maycombhq/index/package.json"))).toBe(true);
    expect(existsSync(join(nm, "yaml/package.json"))).toBe(true);
  });
});
