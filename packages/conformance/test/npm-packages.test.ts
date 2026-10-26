import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

/**
 * ADR 0124 addendum D-npm: the npm packages carry their bytes. `scripts/bundle/npm-packages.mjs`
 * holds the rules a publish and the bank-style install test check: every publishable package is
 * public, has no install script, and a package that carries the model or onnxruntime holds every
 * pinned file with its pinned sha256 and its licence. Tested on invented tarballs written here
 * (nothing is packed, downloaded or published), and on the repo's own manifests.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../..");
interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  files?: string[];
  os?: string[];
  cpu?: string[];
  scripts?: Record<string, string>;
  publishConfig?: { access?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  atticusModel?: unknown;
  atticusRepackaged?: unknown;
}
const load = async () =>
  (await import(pathToFileURL(join(REPO, "scripts/bundle/npm-packages.mjs")).href)) as {
    publishablePackages: (repo?: string) => { name: string; dir: string; manifest: Manifest }[];
    manifestProblems: (m: Manifest, pins?: { files: { path: string }[] }) => string[];
    tarballProblems: (bytes: Uint8Array) => {
      name: string;
      version: string;
      files: number;
      unpacked: number;
      problems: string[];
    };
    packuments: (
      tarballs: { file: string; bytes: Uint8Array }[],
      base: string,
      tag?: string,
    ) => Map<
      string,
      {
        name: string;
        "dist-tags": Record<string, string>;
        versions: Record<
          string,
          { name: string; dist: { tarball: string; integrity: string; shasum: string } }
        >;
      }
    >;
  };

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A tiny npm-style .tgz (package/<name> entries), written here so no tarball is committed. */
function tgz(files: Record<string, string>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const h = Buffer.alloc(512);
    h.write(`package/${name}`, 0, "utf8");
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

// An invented model package, as `pnpm pack` writes it once prepack has filled it.
const WEIGHTS = "invented weights";
const LICENCE = "Invented Licence 2.0";
const modelPins = {
  sources: { w: { url: "https://example.invalid/w", sha256: sha(WEIGHTS) } },
  files: [
    { path: "model.onnx", source: "w", sha256: sha(WEIGHTS) },
    { path: "LICENSE", source: "l", sha256: sha(LICENCE) },
  ],
};
const modelManifest: Manifest = {
  name: "@maycombhq/embed-model",
  version: "9.9.9-beta.1",
  files: ["model.onnx", "LICENSE", "pins.json"],
  scripts: { prepack: "node ../../scripts/model/fetch.mjs . --offline" },
  publishConfig: { access: "public" },
  atticusModel: { name: "invented", sha256: sha(WEIGHTS) },
};
const modelTarball = (o: { manifest?: Partial<Manifest>; drop?: string; weights?: string } = {}) =>
  tgz(
    Object.fromEntries(
      Object.entries({
        "package.json": JSON.stringify({ ...modelManifest, ...o.manifest }),
        "pins.json": JSON.stringify(modelPins),
        "model.onnx": o.weights ?? WEIGHTS,
        LICENSE: LICENCE,
      }).filter(([k]) => k !== o.drop),
    ),
  );

describe("the npm packages Atticus publishes (ADR 0124 addendum D-npm)", () => {
  it("accepts a model package that carries every pinned file and its licence", async () => {
    const { tarballProblems } = await load();
    const r = tarballProblems(modelTarball());
    expect(r).toMatchObject({ name: "@maycombhq/embed-model", version: "9.9.9-beta.1" });
    expect(r.problems).toEqual([]);
    expect(r.files).toBe(4);
    expect(r.unpacked).toBeGreaterThan(WEIGHTS.length);
  });

  it("refuses a package whose pinned file is missing or isn't the pinned bytes", async () => {
    const { tarballProblems } = await load();
    expect(tarballProblems(modelTarball({ drop: "model.onnx" })).problems).toEqual([
      "model.onnx, pinned in pins.json, isn't in the package",
    ]);
    expect(tarballProblems(modelTarball({ weights: "other weights" })).problems).toEqual([
      `model.onnx has sha256 ${sha("other weights")}, not the pinned ${sha(WEIGHTS)}`,
    ]);
  });

  it("refuses a model or runtime package without its pins or its licence text", async () => {
    const { tarballProblems } = await load();
    expect(tarballProblems(modelTarball({ drop: "pins.json" })).problems).toEqual([
      "it carries a third party's files (atticusModel or atticusRepackaged) but not its pins.json",
    ]);
    expect(tarballProblems(modelTarball({ drop: "LICENSE" })).problems).toContain(
      "it carries a third party's files but not their licence text (LICENSE)",
    );
  });

  it("refuses install scripts, a binding.gyp, workspace: versions and a package that isn't public", async () => {
    const { tarballProblems } = await load();
    const own = (manifest: Partial<Manifest>, extra: Record<string, string> = {}) =>
      tarballProblems(
        tgz({
          "package.json": JSON.stringify({
            name: "@maycombhq/invented",
            version: "1.0.0",
            publishConfig: { access: "public" },
            ...manifest,
          }),
          ...extra,
        }),
      ).problems;
    expect(own({})).toEqual([]);
    expect(own({ scripts: { postinstall: "node fetch.js", prepack: "x" } })).toEqual([
      "it has an install script (postinstall): the bank's mirror may run npm with scripts off, and Atticus never downloads at install",
    ]);
    expect(own({}, { "binding.gyp": "{}" })).toEqual([
      "it has a binding.gyp, which makes npm run node-gyp at install",
    ]);
    expect(own({ dependencies: { "@maycombhq/core": "workspace:*" } })).toEqual([
      "@maycombhq/core is still workspace:*: pack it with pnpm, which writes the version",
    ]);
    expect(own({ publishConfig: {} })).toEqual([
      'publishConfig.access isn\'t "public": a scoped package is published private otherwise',
    ]);
  });

  it("refuses a native runtime package that npm would install on every platform", async () => {
    const { tarballProblems } = await load();
    const runtime = (manifest: Partial<Manifest>) =>
      tarballProblems(
        tgz({
          "package.json": JSON.stringify({
            name: "@maycombhq/onnxruntime-linux-x64",
            version: "1.0.0",
            publishConfig: { access: "public" },
            ...manifest,
          }),
        }),
      ).problems;
    expect(runtime({ os: ["linux"], cpu: ["x64"] })).toEqual([]);
    expect(runtime({ os: ["linux"] })).toEqual([
      'os and cpu must be ["linux"] and ["x64"], so npm installs it only there',
    ]);
  });

  // ADR 0124 addendum D-npm2: an invented bundled package, as `pnpm pack` writes
  // @maycombhq/atticus: its files listed with their sha256 in dist/files.json, the third parties
  // inside in dist/third-party.json, their licences in THIRD-PARTY-LICENSES.txt.
  const BIN = '#!/usr/bin/env node\nimport { a } from "./chunk-A.js";\na();\n';
  const CHUNK = 'import { readFileSync } from "node:fs";\nexport const a = () => readFileSync;\n';
  const TXT = "=====\ninvented-lib@1.0.0 (MIT)\n=====\nMIT License\n";
  const bundled = (
    o: {
      manifest?: Partial<Manifest>;
      drop?: string;
      chunk?: string;
      third?: { name: string; version: string; licence: string; font?: boolean }[];
    } = {},
  ) => {
    const files: Record<string, string> = {
      "dist/bin.js": BIN,
      "dist/chunk-A.js": CHUNK,
      "THIRD-PARTY-LICENSES.txt": TXT,
    };
    const listed = Object.entries(files).map(([path, text]) => ({ path, sha256: sha(text) }));
    files["dist/chunk-A.js"] = o.chunk ?? CHUNK;
    files["dist/files.json"] = JSON.stringify({ files: listed });
    files["dist/third-party.json"] = JSON.stringify(
      o.third ?? [{ name: "invented-lib", version: "1.0.0", licence: "MIT", licenceText: true }],
    );
    files["package.json"] = JSON.stringify({
      name: "@maycombhq/atticus",
      version: "9.9.9-beta.2",
      bin: { atticus: "./dist/bin.js" },
      atticusBundled: true,
      publishConfig: { access: "public" },
      optionalDependencies: { "@maycombhq/embed-model": "9.9.9-beta.2" },
      ...o.manifest,
    });
    if (o.drop) delete files[o.drop];
    return tgz(files);
  };

  it("accepts a bundled package that carries every file it lists and every licence", async () => {
    const { tarballProblems } = await load();
    expect(tarballProblems(bundled()).problems).toEqual([]);
  });

  it("refuses a bundled package missing a file it lists, or with other bytes", async () => {
    const { tarballProblems } = await load();
    expect(tarballProblems(bundled({ drop: "dist/chunk-A.js" })).problems).toEqual([
      "dist/chunk-A.js, listed in dist/files.json, isn't in the package",
    ]);
    const other = 'export const a = () => "other";\n';
    expect(tarballProblems(bundled({ chunk: other })).problems).toEqual([
      `dist/chunk-A.js has sha256 ${sha(other)}, not the ${sha(CHUNK)} dist/files.json lists`,
    ]);
    expect(tarballProblems(bundled({ drop: "dist/files.json" })).problems).toEqual([
      "it is bundled (atticusBundled) but has no dist/files.json listing what it carries",
    ]);
  });

  it("refuses a bundled third party under a licence Atticus may not ship, or without its licence", async () => {
    const { tarballProblems } = await load();
    expect(
      tarballProblems(
        bundled({ third: [{ name: "invented-lib", version: "1.0.0", licence: "GPL-3.0" }] }),
      ).problems,
    ).toEqual(["it bundles invented-lib@1.0.0, under GPL-3.0, which isn't on the allowed list"]);
    // A font may be OFL-1.1; code may not.
    expect(
      tarballProblems(
        bundled({
          third: [
            { name: "invented-lib", version: "1.0.0", licence: "MIT" },
            { name: "@fontsource/invented", version: "5.0.0", licence: "OFL-1.1", font: true },
          ],
        }),
      ).problems,
    ).toEqual([
      "it bundles @fontsource/invented@5.0.0 but THIRD-PARTY-LICENSES.txt doesn't hold its licence",
    ]);
    expect(tarballProblems(bundled({ drop: "THIRD-PARTY-LICENSES.txt" })).problems).toContain(
      "it bundles third parties (dist/third-party.json) but has no THIRD-PARTY-LICENSES.txt",
    );
  });

  it("refuses a bundled package that still needs another Atticus package", async () => {
    const { tarballProblems } = await load();
    expect(
      tarballProblems(bundled({ manifest: { dependencies: { "@maycombhq/core": "9.9.9" } } }))
        .problems,
    ).toEqual([
      "it is bundled but depends on @maycombhq/core: only the model and onnxruntime stay packages of their own",
    ]);
    const imports = 'import { parseRecord } from "@maycombhq/core";\nexport const a = 1;\n';
    expect(tarballProblems(bundled({ chunk: imports })).problems).toContain(
      "dist/chunk-A.js imports @maycombhq/core, which a bundled package must carry inside",
    );
  });

  it("deprecates every name beta.1 published that is private now, and only in a run with --yes", async () => {
    const { RETIRED_PACKAGES, DEPRECATION_MESSAGE, deprecateArgs } = (await import(
      pathToFileURL(join(REPO, "scripts/release-npm-deprecate.mjs")).href
    )) as {
      RETIRED_PACKAGES: string[];
      DEPRECATION_MESSAGE: string;
      deprecateArgs: (name: string, registry?: string) => string[];
    };
    const { publishablePackages } = await load();
    const published = publishablePackages(REPO).map((p) => p.name);
    // beta.1's 47: the 39 retired and the 8 still published but the new @maycombhq/atticus.
    expect(RETIRED_PACKAGES).toHaveLength(39);
    expect(new Set([...RETIRED_PACKAGES, ...published]).size).toBe(48);
    expect(RETIRED_PACKAGES).toContain("@maycombhq/cli");
    for (const n of RETIRED_PACKAGES) {
      const m = JSON.parse(
        readFileSync(join(REPO, "packages", n.split("/")[1]!, "package.json"), "utf8"),
      ) as Manifest;
      expect(m.private, n).toBe(true);
    }
    expect(DEPRECATION_MESSAGE).toBe(
      "Atticus is now one package: npm install -g @maycombhq/atticus",
    );
    expect(deprecateArgs("@maycombhq/core")).toEqual([
      "deprecate",
      "@maycombhq/core",
      DEPRECATION_MESSAGE,
    ]);
    // The dry run (the default) prints the commands and runs nothing: no npm on its PATH here.
    const r = spawnSync(process.execPath, [join(REPO, "scripts/release-npm-deprecate.mjs")], {
      encoding: "utf8",
      env: { PATH: "" },
    });
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines.filter((l) => l.startsWith("npm deprecate @maycombhq/"))).toHaveLength(39);
    expect(lines.at(-1)).toMatch(/^Dry run: 39 names would be deprecated; nothing was run\./);
  });

  it("makes the registry documents a mirror serves for the packed tarballs", async () => {
    const { packuments } = await load();
    const bytes = modelTarball();
    const docs = packuments(
      [{ file: "/packs/maycombhq-embed-model-9.9.9-beta.1.tgz", bytes }],
      "http://127.0.0.1:4873",
      "beta",
    );
    const doc = docs.get("@maycombhq/embed-model")!;
    expect(doc["dist-tags"]).toEqual({ latest: "9.9.9-beta.1", beta: "9.9.9-beta.1" });
    const v = doc.versions["9.9.9-beta.1"]!;
    expect(v.name).toBe("@maycombhq/embed-model");
    expect(v.dist.tarball).toBe(
      "http://127.0.0.1:4873/@maycombhq/embed-model/-/embed-model-9.9.9-beta.1.tgz",
    );
    expect(v.dist.integrity).toBe(`sha512-${createHash("sha512").update(bytes).digest("base64")}`);
    expect(v.dist.shasum).toBe(createHash("sha1").update(bytes).digest("hex"));
  });

  it("holds the repo's publishable packages to it: public, no install scripts, os and cpu, pinned files packed offline", async () => {
    const { publishablePackages, manifestProblems } = await load();
    const pkgs = publishablePackages(REPO);
    const names = pkgs.map((p) => p.name);
    // ADR 0124 addendum D-npm2: about nine packages, not 47. Everything else is private.
    expect(names.sort()).toEqual([
      "@maycombhq/atticus",
      "@maycombhq/embed-model",
      "@maycombhq/onnxruntime-darwin-arm64",
      "@maycombhq/onnxruntime-linux-arm64",
      "@maycombhq/onnxruntime-linux-x64",
      "@maycombhq/onnxruntime-wasm",
      "@maycombhq/onnxruntime-win32-arm64",
      "@maycombhq/onnxruntime-win32-x64",
      "@maycombhq/sdk",
    ]);
    const { PUBLIC_PACKAGES } = (await import(
      pathToFileURL(join(REPO, "scripts/bundle/npm-layout.mjs")).href
    )) as { PUBLIC_PACKAGES: string[] };
    expect([...PUBLIC_PACKAGES].sort()).toEqual(names);
    for (const p of pkgs) {
      const pinsFile = join(p.dir, "pins.json");
      let pins: { files: { path: string }[] } | undefined;
      try {
        pins = JSON.parse(readFileSync(pinsFile, "utf8")) as { files: { path: string }[] };
      } catch {
        pins = undefined;
      }
      expect(manifestProblems(p.manifest, pins), p.name).toEqual([]);
    }
    // The one package installs the command line: bin atticus, no dependency but the model and
    // onnxruntime (optional, separate packages), Node 22.13 or later.
    const atticus = pkgs.find((p) => p.name === "@maycombhq/atticus")!.manifest as Manifest & {
      bin?: Record<string, string>;
      engines?: Record<string, string>;
    };
    expect(atticus.bin).toEqual({ atticus: "./dist/bin.js" });
    expect(atticus.dependencies ?? {}).toEqual({});
    expect(Object.keys(atticus.optionalDependencies ?? {}).sort()).toEqual(
      names.filter((n) => /embed-model|onnxruntime-/.test(n)),
    );
    expect(atticus.engines?.node).toBe(">=22.13");
    // Every Atticus package a publishable one depends on is published too.
    for (const p of pkgs)
      for (const d of Object.keys({
        ...p.manifest.dependencies,
        ...p.manifest.optionalDependencies,
      }))
        if (d.startsWith("@maycombhq/")) expect(names, `${p.name} needs ${d}`).toContain(d);
  });
});
