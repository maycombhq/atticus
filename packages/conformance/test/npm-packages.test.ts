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
    expect(names).toContain("@maycombhq/cli");
    expect(names).toContain("@maycombhq/embed-model");
    expect(names).toContain("@maycombhq/onnxruntime-wasm");
    expect(names).not.toContain("@maycombhq/fixtures"); // private
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
    // `atticus sandbox create` builds the practice metarepo from the Forge fixtures: an npm
    // install has no checkout, so @maycombhq/learn carries them (copied in at pack, removed after).
    const learn = pkgs.find((p) => p.name === "@maycombhq/learn")!.manifest;
    expect(learn.files).toContain("fixtures");
    expect(learn.scripts?.prepack).toMatch(/scripts\/bundle\/learn-fixtures\.mjs/);
    expect(learn.scripts?.postpack).toMatch(/scripts\/bundle\/learn-fixtures\.mjs --remove/);
    // Every Atticus package a publishable one depends on is published too.
    for (const p of pkgs)
      for (const d of Object.keys({
        ...p.manifest.dependencies,
        ...p.manifest.optionalDependencies,
      }))
        if (d.startsWith("@maycombhq/")) expect(names, `${p.name} needs ${d}`).toContain(d);
  });
});
