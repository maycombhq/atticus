// pnpm bundle [out-dir] [--with-embeddings | --embeddings-plugin]: the offline install bundle
// (ADR 0052). One zip with everything Atticus needs to install and run with no package
// registry: the built command line
// and app, every production dependency, the Forge practice fixtures, install scripts for Windows,
// macOS and Linux, SHA256SUMS, a CycloneDX SBOM and the third-party licences. Node.js itself is
// not inside: organisations install it through their own software catalogue (22.13 or later).
// Build first: pnpm turbo run build.
//
// ADR 0124 addendum D-bundle: search by meaning is an optional plugin. The default bundle leaves
// out the embedding model and its runtime (@maycombhq/embed, @maycombhq/embed-model, the
// @maycombhq/onnxruntime-* packages and onnxruntime-common): retrieval is words and names (FTS5,
// BM25) and the graph walk, and doctor says so. --with-embeddings (or ATTICUS_BUNDLE_EMBEDDINGS=1)
// puts them in, as before, in a zip named ...-offline-embeddings.zip. --embeddings-plugin (or
// ATTICUS_BUNDLE_EMBEDDINGS_PLUGIN=1) builds instead the small zip that adds them to an installed
// default bundle, ...-embeddings-plugin.zip: the packages and their pins, without the model or
// onnxruntime's files, which its fetch step fills (scripts/bundle/embeddings-plugin.mjs).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { layOutPlugin, pluginName, writeChecksums, writeZip } from "./embeddings-plugin.mjs";
import {
  cyclonedx,
  deploy,
  embeddingPackage,
  forbiddenFiles,
  inventory,
  licenceAllowed,
  removeDeploy,
  removePackages,
  REPO,
} from "./inventory.mjs";

const VERSION = JSON.parse(readFileSync(join(REPO, "packages/cli/package.json"), "utf8")).version;
const NAME = `atticus-${VERSION}`;
const args = process.argv.slice(2);
const withEmbeddings =
  args.includes("--with-embeddings") || process.env.ATTICUS_BUNDLE_EMBEDDINGS === "1";
const plugin =
  args.includes("--embeddings-plugin") || process.env.ATTICUS_BUNDLE_EMBEDDINGS_PLUGIN === "1";
if (plugin && withEmbeddings) {
  console.error("--with-embeddings and --embeddings-plugin build different zips: pick one.");
  process.exit(2);
}
const outDir = args.find((a) => !a.startsWith("--")) ?? join(REPO, "dist");
const now = new Date(
  process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) * 1000 : Date.now(),
);

// The built command line must be this version (a stale build would ship the wrong one).
const built = readFileSync(join(REPO, "packages/cli/dist/version.js"), "utf8");
if (!built.includes(`"${VERSION}"`)) {
  console.error(
    `packages/cli/dist is not built at ${VERSION}: run pnpm turbo run build --force first.`,
  );
  process.exit(1);
}

// ---- the embeddings plugin zip: the deploy's embedding packages only, no model, no runtime.
if (plugin) {
  const deployed = deploy();
  const out = join(outDir, `${pluginName(VERSION)}.zip`);
  const dir = join(dirname(deployed), pluginName(VERSION));
  const r = layOutPlugin(deployed, dir, { version: VERSION, timestamp: now.toISOString() });
  const z = await writeZip({ dir, name: pluginName(VERSION), outFile: out, now });
  removeDeploy(deployed);
  console.log(
    `Wrote ${out} (${(z.bytes / 1024 / 1024).toFixed(2)} MB, ${z.entries} files: ${r.packages.join(", ")}${r.fromRepo.length ? `; from the repo: ${r.fromRepo.join(", ")}` : ""}). Left for its fetch step: ${r.left.length ? `${r.left.length} pinned files` : "every pinned file (the model's and onnxruntime's; none was filled in this checkout)"}.\nsha256 ${z.sha256}`,
  );
  process.exit(0);
}

// ---- the local embedding model (ADR 0116 addendum), only with --with-embeddings: the packages
// npm installs with the CLI, @maycombhq/embed-model and this platform's
// @maycombhq/onnxruntime-<platform> with the WASM fallback, filled with their pinned files first
// (from the cache; the only download is the first fill, at build time). Other platforms' runtime
// packages are left out of this bundle. Without it, every one of them is left out.
if (withEmbeddings)
  execFileSync(process.execPath, [join(REPO, "scripts/model/fetch.mjs"), "--this-platform"], {
    stdio: "inherit",
  });
const dir = deploy();
const scoped = join(dir, "node_modules", "@maycombhq");
const here = `onnxruntime-${process.platform}-${process.arch}`;
if (withEmbeddings) {
  for (const p of readdirSync(scoped))
    if (/^onnxruntime-(win32|linux|darwin)-/.test(p) && p !== here)
      rmSync(join(scoped, p), { recursive: true, force: true });
  for (const f of [
    "embed-model/model.onnx",
    `${here}/dist/index.js`,
    "onnxruntime-wasm/dist/ort.wasm.min.mjs",
  ])
    if (!existsSync(join(scoped, ...f.split("/")))) {
      console.error(
        `The bundle is missing @maycombhq/${f}: run node scripts/model/fetch.mjs --this-platform.`,
      );
      process.exit(1);
    }
} else {
  const left = removePackages(dir, embeddingPackage);
  if (existsSync(join(scoped, "embed"))) {
    console.error("The default bundle still holds @maycombhq/embed.");
    process.exit(1);
  }
  console.log(`Left out the embedding plugin: ${left.join(", ")}.`);
}
for (const f of ["forge", "forge-change"])
  cpSync(join(REPO, "fixtures", f), join(dir, "fixtures", f), { recursive: true });
cpSync(join(REPO, "LICENSE"), join(dir, "LICENSE"));

// ---- licences and the SBOM
const items = inventory(dir);
const bad = items.filter((i) => !i.own && !licenceAllowed(i.licence));
for (const f of forbiddenFiles(dir)) {
  console.error(`${f.file}: ${f.why}`);
  process.exit(1);
}
if (bad.length) {
  for (const i of bad) console.error(`${i.name}@${i.version}: ${i.licence ?? "no licence"}`);
  process.exit(1);
}
writeFileSync(
  join(dir, "sbom.cdx.json"),
  JSON.stringify(cyclonedx(items, { version: VERSION, timestamp: now.toISOString() }), null, 2),
);
writeFileSync(
  join(dir, "THIRD-PARTY-LICENSES.txt"),
  items
    .filter((i) => !i.own)
    .map(
      (i) =>
        `${"=".repeat(72)}\n${i.name}@${i.version} (${i.licence})\n${"=".repeat(72)}\n${i.text ?? `Licensed under ${i.licence}; no licence file in the package.`}\n`,
    )
    .join("\n"),
);

// ---- install scripts
const ps1 = `# Install Atticus ${VERSION} for this user, from this folder (no network).
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   -NoPath: leave your PATH as it is (run atticus by its full path, or add the bin folder yourself)
param([switch]$NoPath)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$version = "${VERSION}"

# Node.js 22.13 or later, from your organisation's software catalogue.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error "Node.js isn't installed. Install Node.js 22.13 or later (LTS 22) from your software catalogue, then run this again."; exit 1 }
$v = (& node -p "process.versions.node").Trim().Split(".")
if ([int]$v[0] -lt 22 -or ([int]$v[0] -eq 22 -and [int]$v[1] -lt 13)) { Write-Error "Atticus needs Node.js 22.13 or later; this machine has $($v -join '.')."; exit 1 }

# Every file as it was built.
Write-Host "Checking the files..."
$bad = @()
Get-Content (Join-Path $here "SHA256SUMS") | ForEach-Object {
  $hash, $file = $_ -split "  ", 2
  $path = Join-Path $here ($file -replace "/", "\\")
  if (-not (Test-Path -LiteralPath $path) -or (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLower() -ne $hash) { $bad += $file }
}
if ($bad.Count -gt 0) { Write-Error "These files don't match SHA256SUMS: $($bad[0..4] -join ', '). Copy the bundle again."; exit 1 }

$base = Join-Path $env:LOCALAPPDATA "Programs\\Atticus"
$target = Join-Path $base $version
$bin = Join-Path $base "bin"
New-Item -ItemType Directory -Force -Path $target, $bin | Out-Null
Write-Host "Copying to $target..."
Copy-Item -Recurse -Force -Path (Join-Path $here "*") -Destination $target
# The shim finds this version beside itself (%~dp0 is its own folder), so no path is written
# into it and a profile folder with letters outside ASCII (an accented name) can't be mangled.
Set-Content -Encoding ASCII -Path (Join-Path $bin "atticus.cmd") -Value "@node \`"%~dp0..\\$version\\dist\\bin.js\`" %*"
$path = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $NoPath -and -not ($path -split ";" | Where-Object { $_ -eq $bin })) {
  [Environment]::SetEnvironmentVariable("Path", (($path, $bin) -join ";").Trim(";"), "User")
  Write-Host "Added $bin to your PATH (open a new terminal to use it)."
}
& node (Join-Path $target "dist\\bin.js") --version
Write-Host "Installed Atticus $version. Next: git config --global core.longpaths true, then in your metarepo run: atticus doctor"
`;
const sh = `#!/bin/sh
# Install Atticus ${VERSION} for this user, from this folder (no network): sh install.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
version="${VERSION}"
command -v node >/dev/null 2>&1 || { echo "Node.js isn't installed. Install Node.js 22.13 or later (LTS 22), then run this again." >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' || { echo "Atticus needs Node.js 22.13 or later; this machine has $(node -v)." >&2; exit 1; }
echo "Checking the files..."
cd "$here"
if command -v sha256sum >/dev/null 2>&1; then sha256sum -c --quiet SHA256SUMS; else shasum -a 256 -c --quiet SHA256SUMS; fi
target="\${XDG_DATA_HOME:-$HOME/.local/share}/atticus/$version"
bin="$HOME/.local/bin"
mkdir -p "$target" "$bin"
echo "Copying to $target..."
cp -R "$here"/. "$target"/
printf '#!/bin/sh\\nexec node "%s/dist/bin.js" "$@"\\n' "$target" > "$bin/atticus"
chmod 755 "$bin/atticus"
case ":$PATH:" in *":$bin:"*) ;; *) echo "Add $bin to your PATH (for example in ~/.profile)." ;; esac
node "$target/dist/bin.js" --version
echo "Installed Atticus $version. Next, in your metarepo: atticus doctor"
`;
writeFileSync(join(dir, "install.ps1"), ps1.replace(/\n/g, "\r\n"));
writeFileSync(join(dir, "install.sh"), sh);
writeFileSync(
  join(dir, "README.txt"),
  [
    `Atticus ${VERSION}, offline install bundle`,
    "",
    "Needs Node.js 22.13 or later and Git 2.30 or later. Nothing here reaches the network.",
    "",
    "Windows:  right-click install.ps1 > Run with PowerShell",
    "          (or: powershell -ExecutionPolicy Bypass -File install.ps1)",
    "macOS, Linux:  sh install.sh",
    "",
    "Both check every file against SHA256SUMS, install for this user only (no administrator",
    "rights), put `atticus` on your PATH and print the version. Then, in your metarepo:",
    "  atticus doctor     what this machine still needs",
    "  atticus upgrade    when this replaces an older Atticus",
    "",
    "sbom.cdx.json lists every package inside (CycloneDX 1.5); THIRD-PARTY-LICENSES.txt holds",
    "their licences. Atticus itself is Apache-2.0 (LICENSE).",
    "",
    ...(withEmbeddings
      ? [
          "This bundle carries the local embedding model and its runtime: search by meaning works",
          "offline, with nothing more to install.",
        ]
      : [
          "Search by meaning is an optional plugin this bundle leaves out: Atticus searches by words",
          "and names, and atticus doctor says so. atticus-<version>-embeddings-plugin.zip adds it",
          "to this install (its README says how); a bundle built with --with-embeddings carries it.",
        ]),
    "",
  ].join("\r\n"),
);

// ---- checksums and the zip
writeChecksums(dir);
const out = join(outDir, `${NAME}-offline${withEmbeddings ? "-embeddings" : ""}.zip`);
const z = await writeZip({ dir, name: NAME, outFile: out, now });
removeDeploy(dir);
console.log(
  `Wrote ${out} (${(z.bytes / 1024 / 1024).toFixed(1)} MB, ${z.entries} files, ${items.filter((i) => !i.own).length} third-party packages).\nsha256 ${z.sha256}`,
);
if (!existsSync(out)) process.exit(1);
