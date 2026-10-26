// node ../../scripts/bundle/npm-sdk.mjs   (the end of packages/sdk's build; needs core built)
// The plugin SDK as npm publishes it (contract C4; ADR 0124 addendum D-npm2): packages/sdk/npm/,
// which publishConfig points `main`, `types` and `exports` at. index.js is the SDK bundled by
// esbuild with what it uses of @maycombhq/core, which isn't published any more; zod and yaml
// stay dependencies (the record types are zod's). The declarations are the SDK's own, with
// core's beside them in npm/core/ and every "@maycombhq/core" pointed there. In the workspace
// the SDK is still its compiled dist/, against the workspace's core.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SDK = join(REPO, "packages/sdk");
const OUT = join(SDK, "npm");
const CORE_DIST = join(REPO, "packages/core/dist");
for (const f of [join(SDK, "dist/index.js"), join(CORE_DIST, "index.d.ts")])
  if (!existsSync(f)) {
    console.error(`${relative(REPO, f)} isn't built: build @maycombhq/core and the SDK first.`);
    process.exit(1);
  }
rmSync(OUT, { recursive: true, force: true });

const manifest = JSON.parse(readFileSync(join(SDK, "package.json"), "utf8"));
await build({
  absWorkingDir: REPO,
  entryPoints: [join(SDK, "dist/index.js")],
  outfile: join(OUT, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // What npm installs with it: its own dependencies (zod, yaml).
  external: Object.keys(manifest.dependencies ?? {}),
  legalComments: "none",
  logLevel: "warning",
});

/** Every .d.ts under `from`, copied to `to` with "@maycombhq/core" pointed at `core(file)`. */
function copyTypes(from, to, core) {
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, e.name);
    const dst = join(to, e.name);
    if (e.isDirectory()) copyTypes(src, dst, core);
    else if (e.name.endsWith(".d.ts")) {
      mkdirSync(dirname(dst), { recursive: true });
      const text = readFileSync(src, "utf8").replace(
        /(["'])@maycombhq\/core\1/g,
        (_m, q) => `${q}${core(dst)}${q}`,
      );
      writeFileSync(dst, text);
    }
  }
}
const coreIndex = (dst) => {
  const rel = relative(dirname(dst), join(OUT, "core/index.js")).split("\\").join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
};
copyTypes(join(SDK, "dist"), OUT, coreIndex);
cpSync(CORE_DIST, join(OUT, "core"), {
  recursive: true,
  filter: (p) => !/\.(js|map)$/.test(p),
});
console.log(`Built packages/sdk/npm: the SDK with @maycombhq/core inside, and its types.`);
