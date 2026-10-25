import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { readZip } from "@maycombhq/core";

/**
 * ADR 0124 addendum D-bundle: the embeddings plugin zip (`pnpm bundle --embeddings-plugin`,
 * `scripts/bundle/embeddings-plugin.mjs`), installed next to the default offline bundle. Its
 * layout is tested on an invented deployed folder, without the model (Hugging Face isn't
 * reachable from a test, and nothing is downloaded); its fetch step (`fetch-model.mjs`) on
 * invented pins, from a folder, offline.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../..");
const SCRIPTS = join(REPO, "scripts/bundle");
const load = async () =>
  (await import(pathToFileURL(join(SCRIPTS, "embeddings-plugin.mjs")).href)) as {
    pluginName: (version: string) => string;
    layOutPlugin: (
      deployDir: string,
      outDir: string,
      o: { version: string; timestamp?: string },
    ) => { packages: string[]; left: string[]; fromRepo: string[] };
    writeZip: (o: {
      dir: string;
      name: string;
      outFile: string;
      now?: Date;
    }) => Promise<{ file: string; bytes: number; entries: number; sha256: string }>;
  };

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

const files = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const f = join(d, e);
      if (statSync(f).isDirectory()) walk(f);
      else out.push(relative(dir, f).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
};

async function put(file: string, text: string) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** A deployed Atticus (`pnpm deploy`'s hoisted layout) with the plugin's files filled in. */
async function deployed(o: { common?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-plugin-deploy-"));
  const nm = join(dir, "node_modules");
  const pkg = (name: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ name, version: "2.0.0", license: "Apache-2.0", ...extra });
  await put(join(dir, "package.json"), pkg("@maycombhq/cli"));
  await put(join(dir, "dist/bin.js"), "// the command line\n");
  await put(join(nm, "@maycombhq/embed/package.json"), pkg("@maycombhq/embed"));
  await put(join(nm, "@maycombhq/embed/dist/index.js"), "export {};\n");
  await put(
    join(nm, "@maycombhq/embed-model/package.json"),
    pkg("@maycombhq/embed-model", {
      atticusModel: { name: "all-minilm-l6-v2", sha256: "a".repeat(64) },
    }),
  );
  await put(join(nm, "@maycombhq/embed-model/atticus-model.yaml"), "name: all-minilm-l6-v2\n");
  await put(join(nm, "@maycombhq/embed-model/README.md"), "the model\n");
  // Filled in a checkout that ran pnpm model:fetch: the plugin never carries them.
  await put(join(nm, "@maycombhq/embed-model/model.onnx"), "weights");
  await put(join(nm, "@maycombhq/embed-model/tokenizer.json"), "{}");
  for (const p of ["linux-x64", "win32-x64", "darwin-arm64"]) {
    const d = join(nm, `@maycombhq/onnxruntime-${p}`);
    await put(
      join(d, "package.json"),
      pkg(`@maycombhq/onnxruntime-${p}`, {
        license: "MIT",
        atticusRepackaged: { from: "onnxruntime-node@1.30.0", platform: p },
      }),
    );
    await put(join(d, "README.md"), "onnxruntime\n");
    await put(join(d, "dist/index.js"), "module.exports = {};\n");
  }
  await put(
    join(nm, "@maycombhq/onnxruntime-wasm/package.json"),
    pkg("@maycombhq/onnxruntime-wasm", {
      license: "MIT",
      atticusRepackaged: { from: "onnxruntime-web@1.30.0" },
    }),
  );
  await put(join(nm, "@maycombhq/onnxruntime-wasm/dist/ort.wasm.min.mjs"), "export {};\n");
  if (o.common !== false) {
    await put(
      join(nm, "onnxruntime-common/package.json"),
      pkg("onnxruntime-common", { license: "MIT" }),
    );
    await put(join(nm, "onnxruntime-common/LICENSE"), "MIT License\n");
    await put(join(nm, "onnxruntime-common/dist/index.js"), "module.exports = {};\n");
  }
  // What the default bundle already carries: not in the plugin.
  await put(join(nm, "@maycombhq/index/package.json"), pkg("@maycombhq/index"));
  await put(join(nm, "yaml/package.json"), pkg("yaml", { license: "ISC" }));
  return dir;
}

describe("the embeddings plugin zip", () => {
  it("holds the plugin's packages, their pins and the fetch step, and no model or runtime bytes", async () => {
    const { layOutPlugin, pluginName, writeZip } = await load();
    const deploy = await deployed();
    const out = join(await mkdtemp(join(tmpdir(), "atticus-plugin-")), pluginName("2.0.0"));
    const r = layOutPlugin(deploy, out, { version: "2.0.0", timestamp: "2026-10-25T00:00:00Z" });
    expect(r.packages).toEqual([
      "@maycombhq/embed",
      "@maycombhq/embed-model",
      "@maycombhq/onnxruntime-darwin-arm64",
      "@maycombhq/onnxruntime-linux-arm64",
      "@maycombhq/onnxruntime-linux-x64",
      "@maycombhq/onnxruntime-wasm",
      "@maycombhq/onnxruntime-win32-arm64",
      "@maycombhq/onnxruntime-win32-x64",
      "onnxruntime-common",
    ]);
    // pnpm deploy installs this machine's runtime only: the other platforms' come from the repo,
    // so the zip is the same on every platform.
    expect(r.fromRepo).toEqual([
      "@maycombhq/onnxruntime-linux-arm64",
      "@maycombhq/onnxruntime-win32-arm64",
    ]);
    expect(r.left).toEqual(
      expect.arrayContaining([
        "@maycombhq/embed-model/model.onnx",
        "@maycombhq/embed-model/tokenizer.json",
        "@maycombhq/onnxruntime-linux-x64/dist/index.js",
        "@maycombhq/onnxruntime-wasm/dist/ort.wasm.min.mjs",
      ]),
    );
    const all = files(out);
    expect(all).toEqual([
      "README.txt",
      "SHA256SUMS",
      "THIRD-PARTY-LICENSES.txt",
      "fetch-model.mjs",
      "install.ps1",
      "install.sh",
      "node_modules/@maycombhq/embed-model/README.md",
      "node_modules/@maycombhq/embed-model/atticus-model.yaml",
      "node_modules/@maycombhq/embed-model/package.json",
      "node_modules/@maycombhq/embed-model/pins.json",
      "node_modules/@maycombhq/embed/dist/index.js",
      "node_modules/@maycombhq/embed/package.json",
      "node_modules/@maycombhq/onnxruntime-darwin-arm64/README.md",
      "node_modules/@maycombhq/onnxruntime-darwin-arm64/package.json",
      "node_modules/@maycombhq/onnxruntime-darwin-arm64/pins.json",
      "node_modules/@maycombhq/onnxruntime-linux-arm64/README.md",
      "node_modules/@maycombhq/onnxruntime-linux-arm64/package.json",
      "node_modules/@maycombhq/onnxruntime-linux-arm64/pins.json",
      "node_modules/@maycombhq/onnxruntime-linux-x64/README.md",
      "node_modules/@maycombhq/onnxruntime-linux-x64/package.json",
      "node_modules/@maycombhq/onnxruntime-linux-x64/pins.json",
      "node_modules/@maycombhq/onnxruntime-wasm/package.json",
      "node_modules/@maycombhq/onnxruntime-wasm/pins.json",
      "node_modules/@maycombhq/onnxruntime-win32-arm64/README.md",
      "node_modules/@maycombhq/onnxruntime-win32-arm64/package.json",
      "node_modules/@maycombhq/onnxruntime-win32-arm64/pins.json",
      "node_modules/@maycombhq/onnxruntime-win32-x64/README.md",
      "node_modules/@maycombhq/onnxruntime-win32-x64/package.json",
      "node_modules/@maycombhq/onnxruntime-win32-x64/pins.json",
      "node_modules/onnxruntime-common/LICENSE",
      "node_modules/onnxruntime-common/dist/index.js",
      "node_modules/onnxruntime-common/package.json",
      "sbom.cdx.json",
    ]);
    // The pins are the repo's own, so the fetch step checks what the default bundle would carry.
    expect(readFileSync(join(out, "node_modules/@maycombhq/embed-model/pins.json"), "utf8")).toBe(
      readFileSync(join(REPO, "packages/embed-model/pins.json"), "utf8"),
    );
    expect(readFileSync(join(out, "fetch-model.mjs"), "utf8")).toBe(
      readFileSync(join(SCRIPTS, "fetch-model.mjs"), "utf8"),
    );
    // The install scripts add it to the installed Atticus of the same version, and say the step.
    const sh = readFileSync(join(out, "install.sh"), "utf8");
    expect(sh).toMatch(/version="2\.0\.0"/);
    expect(sh).toMatch(/atticus\/\$version/);
    expect(sh).toMatch(/embeddings-plugin\/fetch-model\.mjs/);
    expect(readFileSync(join(out, "install.ps1"), "utf8")).toMatch(/Programs\\Atticus\\\$version/);
    // The SBOM and the licences list what the zip carries, the model and runtime by their source.
    const sbom = JSON.parse(readFileSync(join(out, "sbom.cdx.json"), "utf8")) as {
      metadata: { component: { name: string } };
      components: { name: string; type: string }[];
    };
    expect(sbom.metadata.component.name).toBe("atticus-embeddings-plugin");
    expect(sbom.components.map((c) => c.name)).toContain("all-minilm-l6-v2");
    expect(sbom.components.map((c) => c.name)).not.toContain("yaml");
    // Every file is in SHA256SUMS, with its bytes.
    const sums = readFileSync(join(out, "SHA256SUMS"), "utf8").trim().split("\n");
    expect(sums.map((l) => l.split("  ")[1]).sort()).toEqual(all.filter((f) => f !== "SHA256SUMS"));
    for (const l of sums) {
      const [h, f] = l.split("  ");
      expect(sha(readFileSync(join(out, f!))), f).toBe(h);
    }

    // The zip: one folder named for the version, install.sh executable.
    const zipFile = join(dirname(out), "plugin.zip");
    const z = await writeZip({ dir: out, name: pluginName("2.0.0"), outFile: zipFile });
    expect(z.entries).toBe(all.length);
    const read = readZip(await readFile(zipFile));
    expect([...read.names].sort()).toEqual(all.map((f) => `atticus-2.0.0-embeddings-plugin/${f}`));
    expect(readFileSync(`${zipFile}.sha256`, "utf8")).toBe(`${z.sha256}  plugin.zip\n`);
  });
});

describe("the embeddings plugin zip, from a deploy without onnxruntime-common", () => {
  it("takes onnxruntime-common from the repo, as the runtime packages need it", async () => {
    const { layOutPlugin } = await load();
    const out = join(await mkdtemp(join(tmpdir(), "atticus-plugin-")), "plugin");
    const r = layOutPlugin(await deployed({ common: false }), out, { version: "2.0.0" });
    expect(r.fromRepo).toContain("onnxruntime-common");
    const pj = JSON.parse(
      readFileSync(join(out, "node_modules/onnxruntime-common/package.json"), "utf8"),
    ) as { name: string; version: string; license: string };
    expect(pj).toMatchObject({ name: "onnxruntime-common", version: "1.30.0", license: "MIT" });
  });
});

describe("the plugin's fetch step", () => {
  const here = `onnxruntime-${process.platform}-${process.arch}`;

  /** An installed Atticus with the plugin added: invented pins, the real @maycombhq/embed. */
  async function installed() {
    const dir = await mkdtemp(join(tmpdir(), "atticus-plugin-installed-"));
    const scoped = join(dir, "node_modules", "@maycombhq");
    await mkdir(scoped, { recursive: true });
    // A junction works on Windows without administrator rights.
    await symlink(join(REPO, "packages/embed"), join(scoped, "embed"), "junction");
    await mkdir(join(dir, "embeddings-plugin"));
    await copyFile(
      join(SCRIPTS, "fetch-model.mjs"),
      join(dir, "embeddings-plugin", "fetch-model.mjs"),
    );
    const bytes: Record<string, string> = {
      "embed-model": "invented weights",
      [here]: "invented runtime",
      "onnxruntime-wasm": "invented wasm",
    };
    for (const [p, b] of Object.entries(bytes)) {
      const file = p === "embed-model" ? "model.onnx" : "dist/index.js";
      await put(
        join(scoped, p, "pins.json"),
        JSON.stringify({
          sources: { it: { url: `https://example.invalid/${p}`, sha256: sha(b) } },
          files: [{ path: file, source: "it", sha256: sha(b) }],
        }),
      );
    }
    // What a person fetched through a mirror, under its own names, and a file that isn't pinned.
    const mirror = join(dir, "from-the-mirror");
    for (const [p, b] of Object.entries(bytes)) await put(join(mirror, "sub", `${p}.bin`), b);
    await put(join(mirror, "wrong.bin"), "not the pinned bytes");
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [join(dir, "embeddings-plugin", "fetch-model.mjs"), ...args], {
        encoding: "utf8",
        timeout: 60_000,
      });
    return { dir, scoped, mirror, bytes, run };
  }

  it("lists what it needs, says what is missing, and fills it from a folder, offline", async () => {
    const { scoped, mirror, bytes, run } = await installed();
    const list = run("--list");
    expect(list.status, list.stderr).toBe(0);
    for (const b of Object.values(bytes)) expect(list.stdout).toContain(sha(b));
    expect(list.stdout).toContain("https://example.invalid/embed-model");

    const before = run("--check");
    expect(before.status).toBe(1);
    expect(before.stdout).toMatch(
      /@maycombhq\/embed-model: 1 missing or not the pinned bytes: model\.onnx/,
    );

    // Offline with nothing to take from: it fails, and says how to bring the files.
    const none = run("--offline");
    expect(none.status).toBe(1);
    expect(none.stderr).toMatch(/isn't in the cache and this run may not download/);
    expect(none.stderr).toMatch(/--list names every file it needs/);
    expect(existsSync(join(scoped, "embed-model/model.onnx"))).toBe(false);

    const filled = run("--from", mirror, "--offline");
    expect(filled.status, filled.stderr).toBe(0);
    expect(filled.stdout).toMatch(/3 of the 3 pinned files are there/);
    expect(filled.stdout).toMatch(/Search by meaning is ready/);
    expect(readFileSync(join(scoped, "embed-model/model.onnx"), "utf8")).toBe(bytes["embed-model"]);
    expect(readFileSync(join(scoped, here, "dist/index.js"), "utf8")).toBe(bytes[here]);
    expect(run("--check").status).toBe(0);
  });

  it("says the plugin isn't installed where it isn't", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-plugin-none-"));
    await mkdir(join(dir, "embeddings-plugin"));
    await copyFile(
      join(SCRIPTS, "fetch-model.mjs"),
      join(dir, "embeddings-plugin/fetch-model.mjs"),
    );
    const r = spawnSync(process.execPath, [join(dir, "embeddings-plugin/fetch-model.mjs")], {
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(
      /The embedding plugin isn't installed in .*: run the plugin zip's install script first/,
    );
  });
});
