// The embeddings plugin zip (ADR 0124 addendum D-bundle): `pnpm bundle --embeddings-plugin`.
// The default offline bundle leaves search by meaning out; this small zip adds it to an Atticus
// installed from that bundle. It holds only the embedding packages (`embeddingPackage`), taken
// from the same `pnpm deploy` as the bundle, with each package's pins.json and none of its pinned
// third-party files (the model, onnxruntime's builds), so it is the same zip on every platform.
// Its install script copies the packages into the installed Atticus of the same version; the
// person then runs its fetch step (fetch-model.mjs), which fills the pinned files from their
// pinned sources or from a folder their mirror filled, each checked against its sha256.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cyclonedx, embeddingPackage, inventory, licenceAllowed, REPO } from "./inventory.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the plugin's own files go inside an installed Atticus. */
export const PLUGIN_DIR = "embeddings-plugin";

/** The zip's name, and the folder inside it. */
export const pluginName = (version) => `atticus-${version}-embeddings-plugin`;

/** The plugin's files an install copies into `<Atticus>/embeddings-plugin/`. */
const OWN_FILES = [
  "fetch-model.mjs",
  "README.txt",
  "SHA256SUMS",
  "sbom.cdx.json",
  "THIRD-PARTY-LICENSES.txt",
];

/**
 * Every package of a deployed folder whose name `keep` keeps, nested ones too: { name, rel },
 * `rel` its folder under node_modules (with /). A kept package's own node_modules go with it.
 */
export function findPackages(deployDir, keep) {
  const out = [];
  const walk = (nm) => {
    if (!existsSync(nm)) return;
    for (const n of readdirSync(nm).sort()) {
      if (n.startsWith(".")) continue;
      const dirs = n.startsWith("@")
        ? readdirSync(join(nm, n))
            .sort()
            .map((m) => join(nm, n, m))
        : [join(nm, n)];
      for (const d of dirs) {
        const pj = join(d, "package.json");
        const name = existsSync(pj) ? JSON.parse(readFileSync(pj, "utf8")).name : undefined;
        if (name && keep(name))
          out.push({
            name,
            rel: relative(join(deployDir, "node_modules"), d).split(sep).join("/"),
          });
        else walk(join(d, "node_modules"));
      }
    }
  };
  walk(join(deployDir, "node_modules"));
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.rel.localeCompare(b.rel));
}

/**
 * Lay the plugin out in `outDir` from a deployed Atticus: the packages, their pins.json (from the
 * repo: npm's `files` leaves it out of a deploy) without the files it pins, the fetch step, the
 * install scripts, a README, the SBOM, the licences and SHA256SUMS. The package names, the
 * pinned files left out (each `<package>/<path>`) and the packages taken from the repo.
 *
 * `pnpm deploy` installs only this machine's onnxruntime package (its `os` and `cpu`), and can
 * leave out onnxruntime-common, the one package they need: the plugin is the same zip on every
 * platform, so the other platforms' packages (their package.json, README and pins) and
 * onnxruntime-common come from the repo's own folders.
 */
export function layOutPlugin(deployDir, outDir, o) {
  const { version } = o;
  const found = findPackages(deployDir, embeddingPackage).map((p) => ({
    ...p,
    from: join(deployDir, "node_modules", ...p.rel.split("/")),
  }));
  if (!found.some((p) => p.name === "@maycombhq/embed"))
    throw new Error(`${deployDir} holds no @maycombhq/embed: build the command line first`);
  const fromRepo = [];
  const have = new Set(found.map((p) => p.name));
  const runtimes = readdirSync(join(REPO, "packages"))
    .filter((d) => /^onnxruntime-[a-z0-9-]+$/.test(d))
    .sort();
  for (const d of runtimes)
    if (!have.has(`@maycombhq/${d}`)) {
      found.push({
        name: `@maycombhq/${d}`,
        rel: `@maycombhq/${d}`,
        from: join(REPO, "packages", d),
        only: ["package.json", "README.md"],
      });
      fromRepo.push(`@maycombhq/${d}`);
    }
  if (!have.has("onnxruntime-common")) {
    const common = runtimes
      .map((d) => join(REPO, "packages", d, "node_modules", "onnxruntime-common"))
      .find((d) => existsSync(join(d, "package.json")));
    if (!common) throw new Error("onnxruntime-common isn't installed in the repo: pnpm install");
    found.push({
      name: "onnxruntime-common",
      rel: "onnxruntime-common",
      from: realpathSync(common),
    });
    fromRepo.push("onnxruntime-common");
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const left = [];
  for (const p of found) {
    const to = join(outDir, "node_modules", ...p.rel.split("/"));
    if (p.only) {
      mkdirSync(to, { recursive: true });
      for (const f of p.only) if (existsSync(join(p.from, f))) cpSync(join(p.from, f), join(to, f));
    } else cpSync(p.from, to, { recursive: true, dereference: true });
    if (!p.name.startsWith("@maycombhq/")) continue;
    const pinsFile = join(REPO, "packages", p.name.slice("@maycombhq/".length), "pins.json");
    if (!existsSync(pinsFile)) continue;
    for (const f of JSON.parse(readFileSync(pinsFile, "utf8")).files) {
      const file = join(to, ...f.path.split("/"));
      if (existsSync(file)) {
        rmSync(file, { force: true });
        left.push(`${p.name}/${f.path}`);
      }
    }
    cpSync(pinsFile, join(to, "pins.json"));
  }
  removeEmptyFolders(join(outDir, "node_modules"));
  cpSync(join(HERE, "fetch-model.mjs"), join(outDir, "fetch-model.mjs"));
  writeFileSync(join(outDir, "install.sh"), installSh(version));
  writeFileSync(join(outDir, "install.ps1"), installPs1(version).replace(/\n/g, "\r\n"));
  writeFileSync(join(outDir, "README.txt"), readme(version).join("\r\n"));

  // The licences and the SBOM: the packages the zip carries; the model and onnxruntime by their
  // pinned sources (atticusModel, atticusRepackaged), which the fetch step fills.
  const items = inventory(outDir);
  const bad = items.filter((i) => !i.own && !licenceAllowed(i.licence));
  if (bad.length)
    throw new Error(
      `licences not allowed: ${bad.map((i) => `${i.name}@${i.version} (${i.licence ?? "none"})`).join(", ")}`,
    );
  const sbom = cyclonedx(items, {
    version,
    timestamp: o.timestamp ?? new Date().toISOString(),
  });
  sbom.metadata.component.name = "atticus-embeddings-plugin";
  writeFileSync(join(outDir, "sbom.cdx.json"), JSON.stringify(sbom, null, 2));
  writeFileSync(
    join(outDir, "THIRD-PARTY-LICENSES.txt"),
    items
      .filter((i) => !i.own)
      .map(
        (i) =>
          `${"=".repeat(72)}\n${i.name}@${i.version} (${i.licence})\n${"=".repeat(72)}\n${i.text ?? `Licensed under ${i.licence}; the licence file comes with the pinned files the fetch step adds.`}\n`,
      )
      .join("\n"),
  );
  writeChecksums(outDir);
  return { packages: found.map((p) => p.name), left: left.sort(), fromRepo };
}

function removeEmptyFolders(dir) {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return false;
  let empty = true;
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (lstatSync(f).isDirectory() && removeEmptyFolders(f)) continue;
    empty = false;
  }
  if (empty) rmSync(dir, { recursive: true, force: true });
  return empty;
}

/**
 * Every file of a folder, sorted, with / (node_modules/.bin and links left out: Atticus runs
 * dist/bin.js with node, and pnpm makes those links on Linux but real files on Windows).
 */
export function filesOf(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d).sort()) {
      const f = join(d, e);
      const st = lstatSync(f);
      if (st.isSymbolicLink() || (e === ".bin" && st.isDirectory())) continue;
      if (st.isDirectory()) walk(f);
      else files.push(relative(dir, f).split(sep).join("/"));
    }
  };
  walk(dir);
  return files;
}

/** SHA256SUMS of every other file of the folder, as `sha256sum -c` reads it. */
export function writeChecksums(dir) {
  const sums = filesOf(dir)
    .filter((f) => f !== "SHA256SUMS")
    .map(
      (f) =>
        `${createHash("sha256")
          .update(readFileSync(join(dir, f)))
          .digest("hex")}  ${f}`,
    )
    .join("\n");
  writeFileSync(join(dir, "SHA256SUMS"), `${sums}\n`);
}

/**
 * Zip a folder as `<name>/<file>` (install.sh and bin.js executable), with `<zip>.sha256` beside
 * it. SHA256SUMS must already be written.
 */
export async function writeZip(o) {
  const { zip } = await import(pathToFileURL(join(REPO, "packages/core/dist/index.js")).href);
  const now = o.now ?? new Date();
  const entries = filesOf(o.dir).map((f) => ({
    name: `${o.name}/${f}`,
    data: readFileSync(join(o.dir, f)),
    mode: f === "install.sh" || f.endsWith("/bin.js") ? 0o755 : 0o644,
  }));
  mkdirSync(dirname(o.outFile), { recursive: true });
  const buf = zip(entries, now);
  writeFileSync(o.outFile, buf);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  writeFileSync(`${o.outFile}.sha256`, `${sha256}  ${basename(o.outFile)}\n`);
  return { file: o.outFile, bytes: buf.length, entries: entries.length, sha256 };
}

const installSh = (version) => `#!/bin/sh
# Add search by meaning to Atticus ${version}, installed for this user from its offline bundle.
# From this folder, no network:  sh install.sh [the Atticus folder, if it isn't the default one]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
version="${version}"
target="\${1:-\${XDG_DATA_HOME:-$HOME/.local/share}/atticus/$version}"
command -v node >/dev/null 2>&1 || { echo "Node.js isn't installed. Install Node.js 22.13 or later (LTS 22), then run this again." >&2; exit 1; }
if [ ! -f "$target/dist/bin.js" ]; then
  echo "Atticus $version isn't installed in $target. Install its offline bundle first (sh install.sh in atticus-$version-offline), or name the folder it is in." >&2
  exit 1
fi
installed=$(node "$target/dist/bin.js" --version)
[ "$installed" = "$version" ] || { echo "$target holds Atticus $installed; this plugin is for $version." >&2; exit 1; }
echo "Checking the files..."
cd "$here"
if command -v sha256sum >/dev/null 2>&1; then sha256sum -c --quiet SHA256SUMS; else shasum -a 256 -c --quiet SHA256SUMS; fi
echo "Copying the plugin into $target..."
cp -R "$here/node_modules/." "$target/node_modules/"
mkdir -p "$target/${PLUGIN_DIR}"
for f in ${OWN_FILES.join(" ")}; do cp "$here/$f" "$target/${PLUGIN_DIR}/$f"; done
echo "Added the embedding plugin to Atticus $version. One step is left: fetch the model and this"
echo "machine's onnxruntime, each checked against its pinned sha256:"
echo "  node \\"$target/${PLUGIN_DIR}/fetch-model.mjs\\""
echo "Where this machine can't reach them, --list names the files: fetch them through your mirror,"
echo "then add --from <folder> (and --offline). Then, in your metarepo: atticus doctor"
`;

const installPs1 = (
  version,
) => `# Add search by meaning to Atticus ${version}, installed for this user from its offline bundle.
# From this folder, no network:
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Atticus <the Atticus folder>]
param([string]$Atticus)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$version = "${version}"
if (-not $Atticus) { $Atticus = Join-Path $env:LOCALAPPDATA "Programs\\Atticus\\$version" }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error "Node.js isn't installed. Install Node.js 22.13 or later (LTS 22) from your software catalogue, then run this again."; exit 1 }
$bin = Join-Path $Atticus "dist\\bin.js"
if (-not (Test-Path -LiteralPath $bin)) { Write-Error "Atticus $version isn't installed in $Atticus. Install its offline bundle first (install.ps1 in atticus-$version-offline), or name the folder with -Atticus."; exit 1 }
$installed = (& node $bin --version).Trim()
if ($installed -ne $version) { Write-Error "$Atticus holds Atticus $installed; this plugin is for $version."; exit 1 }

Write-Host "Checking the files..."
$bad = @()
Get-Content (Join-Path $here "SHA256SUMS") | ForEach-Object {
  $hash, $file = $_ -split "  ", 2
  $path = Join-Path $here ($file -replace "/", "\\\\")
  if (-not (Test-Path -LiteralPath $path) -or (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLower() -ne $hash) { $bad += $file }
}
if ($bad.Count -gt 0) { Write-Error "These files don't match SHA256SUMS: $($bad[0..4] -join ', '). Copy the plugin zip again."; exit 1 }

Write-Host "Copying the plugin into $Atticus..."
Copy-Item -Recurse -Force -Path (Join-Path $here "node_modules\\*") -Destination (Join-Path $Atticus "node_modules")
$plugin = Join-Path $Atticus "${PLUGIN_DIR}"
New-Item -ItemType Directory -Force -Path $plugin | Out-Null
foreach ($f in @(${OWN_FILES.map((f) => `"${f}"`).join(", ")})) { Copy-Item -Force -LiteralPath (Join-Path $here $f) -Destination $plugin }
Write-Host "Added the embedding plugin to Atticus $version. One step is left: fetch the model and this machine's onnxruntime, each checked against its pinned sha256:"
Write-Host "  node \`"$plugin\\fetch-model.mjs\`""
Write-Host "Where this machine can't reach them, --list names the files: fetch them through your mirror, then add --from <folder> (and --offline). Then, in your metarepo: atticus doctor"
`;

const readme = (version) => [
  `Atticus ${version}, the embedding plugin (search by meaning)`,
  "",
  `Adds search by meaning to an Atticus ${version} installed from its offline bundle`,
  `(atticus-${version}-offline.zip), which leaves it out. Needs Node.js 22.13 or later.`,
  "",
  "1. Install it next to Atticus (no network; every file is checked against SHA256SUMS):",
  "     Windows:      powershell -ExecutionPolicy Bypass -File install.ps1",
  "     macOS, Linux: sh install.sh",
  "   Each takes the Atticus folder as an argument when it isn't the default one",
  "   (-Atticus <folder> on Windows).",
  "",
  "2. Fetch the model and this machine's onnxruntime. The plugin carries their pins, not",
  "   their bytes: the step fetches each from its pinned source and checks its sha256.",
  `     node <Atticus folder>/${PLUGIN_DIR}/fetch-model.mjs`,
  "   On a machine that can't reach them:",
  "     --list            prints each file it needs (sha256 and where it comes from);",
  "                       fetch them through your mirror or on another machine;",
  "     --from <folder>   takes them from that folder (any names; matched by sha256);",
  "     --offline         never downloads;",
  "     --check           says which files are missing.",
  "",
  "3. In your metarepo: atticus doctor (Embedding model: the model and its runtime), then",
  "   atticus index embed.",
  "",
  "The model is all-MiniLM-L6-v2 (Apache-2.0), onnxruntime is MIT: sbom.cdx.json lists",
  "them by their pinned sources, THIRD-PARTY-LICENSES.txt holds the licences. Atticus itself",
  "never downloads anything; only this step does, when you run it. An upgrade of Atticus",
  "needs the plugin zip of the new version.",
  "",
];
