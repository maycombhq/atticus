import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The build cache's stamp of the code in the npm package (ADR 0195 point 9, the review's B1):
 * bundled, `import.meta.url` is a module's place in dist/ and no workspace package resolves, so
 * the stamp is the build id scripts/bundle/npm-atticus.mjs writes into the bundle. The scanner's
 * build-cache.ts bundled as that script bundles it (npm-layout.mjs's places, banner and build
 * id), and run: with the id written, the stamp is the id's; with the placeholder left, or no id
 * defined at all, there is none, and the cache is off.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../..");
const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

interface Layout {
  placeOf: (file: string, repo: string) => string | undefined;
  injectPlace: (text: string, place: string) => string;
  banner: (root: string) => string;
  buildIdDefine: () => Record<string, string>;
  buildIdOf: (version: string, files: { path: string; bytes: Buffer }[]) => string;
  stampBuildId: (text: string, id: string) => string;
  BUILD_ID_PLACEHOLDER: string;
}
const layout = async () =>
  (await import(pathToFileURL(join(REPO, "scripts/bundle/npm-layout.mjs")).href)) as Layout;

/** build-cache.ts bundled as npm-atticus.mjs bundles the command line; the output's path. */
async function bundled(withId: boolean): Promise<{ out: string; text: string }> {
  const L = await layout();
  const dir = await mkdtemp(join(tmpdir(), "atticus-stamp-bundle-"));
  made.push(dir);
  const keepPlaces: Plugin = {
    name: "atticus-places",
    setup(b) {
      b.onLoad({ filter: /\.[cm]?[jt]s$/ }, (args) => {
        const loader = args.path.endsWith(".ts") ? "ts" : "js";
        const text = readFileSync(args.path, "utf8");
        const place = L.placeOf(args.path, REPO);
        if (!place) return { contents: text, loader };
        return { contents: L.injectPlace(text, place), loader, resolveDir: dirname(args.path) };
      });
    },
  };
  const r = await build({
    absWorkingDir: REPO,
    stdin: {
      contents:
        'import { codeStampInfo } from "../src/build-cache.ts";\nconsole.log(JSON.stringify(codeStampInfo()));\n',
      resolveDir: HERE,
      sourcefile: "entry.mjs",
      loader: "js",
    },
    outfile: join(dir, "dist", "bin.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    define: {
      "import.meta.url": "__atticus_import_meta_url",
      ...(withId ? L.buildIdDefine() : {}),
    },
    plugins: [keepPlaces],
    banner: { js: L.banner("./") },
    logLevel: "silent",
    logOverride: { "empty-import-meta": "silent" },
  });
  expect(r.errors).toEqual([]);
  const out = join(dir, "dist", "bin.js");
  return { out, text: readFileSync(out, "utf8") };
}

const run = (file: string) =>
  JSON.parse(execFileSync(process.execPath, [file], { encoding: "utf8" })) as {
    stamp?: string;
    from?: string;
    why?: string;
  };

describe("the build cache's stamp, bundled (ADR 0195 point 9)", () => {
  it("is the build id written into the bundle, and changes with it", async () => {
    const L = await layout();
    const { out, text } = await bundled(true);
    expect(text).toContain(L.BUILD_ID_PLACEHOLDER);
    const idOf = (v: string) => L.buildIdOf(v, [{ path: "dist/bin.js", bytes: Buffer.from(text) }]);
    writeFileSync(out, L.stampBuildId(text, idOf("2.0.0")));
    const a = run(out);
    expect(a).toMatchObject({ from: "bundle", stamp: expect.stringMatching(/^[0-9a-f]{64}$/) });
    writeFileSync(out, L.stampBuildId(text, idOf("2.0.1")));
    const b = run(out);
    expect(b.from).toBe("bundle");
    expect(b.stamp).not.toBe(a.stamp);
  }, 120_000);

  it("is none (the cache off) with the placeholder left in, or with no build id at all", async () => {
    const left = await bundled(true);
    expect(run(left.out)).toMatchObject({ why: expect.stringMatching(/wasn't written/) });
    const none = await bundled(false);
    const r = run(none.out);
    expect(r.stamp).toBeUndefined();
    expect(r.why).toMatch(/@maycombhq\/scanner/);
  }, 120_000);

  it("the build id is of the version and every file, in path order", async () => {
    const L = await layout();
    const f = (path: string, t: string) => ({ path, bytes: Buffer.from(t) });
    const a = L.buildIdOf("1.0.0", [f("dist/a.js", "a"), f("dist/b.js", "b")]);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(L.buildIdOf("1.0.0", [f("dist/b.js", "b"), f("dist/a.js", "a")])).toBe(a);
    expect(L.buildIdOf("1.0.1", [f("dist/a.js", "a"), f("dist/b.js", "b")])).not.toBe(a);
    expect(L.buildIdOf("1.0.0", [f("dist/a.js", "a"), f("dist/b.js", "c")])).not.toBe(a);
    expect(L.BUILD_ID_PLACEHOLDER).toHaveLength(64);
    expect(L.BUILD_ID_PLACEHOLDER).not.toMatch(/^[0-9a-f]{64}$/);
    expect(L.stampBuildId(`x${L.BUILD_ID_PLACEHOLDER}y`, a)).toBe(`x${a}y`);
    expect(() => L.stampBuildId("x", "not an id")).toThrow();
  });
});
