// pnpm bundle [out-dir]: the offline install bundle (ADR 0052). One zip with everything Atticus
// needs to install and run with no package registry: the built command line and app, every
// production dependency, the Forge practice fixtures, install scripts for Windows, macOS and
// Linux, SHA256SUMS, a CycloneDX SBOM and the third-party licences. Node.js itself is not
// inside: organisations install it through their own software catalogue (22.13 or later).
// Build first: pnpm turbo run build.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { cyclonedx, deploy, inventory, licenceAllowed, REPO } from "./inventory.mjs";

const { zip } = await import(join(REPO, "packages/core/dist/index.js"));
const VERSION = JSON.parse(readFileSync(join(REPO, "packages/cli/package.json"), "utf8")).version;
const NAME = `atticus-${VERSION}`;
const outDir = process.argv[2] ?? join(REPO, "dist");
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
const dir = deploy();
for (const f of ["forge", "forge-change"])
  cpSync(join(REPO, "fixtures", f), join(dir, "fixtures", f), { recursive: true });
cpSync(join(REPO, "LICENSE"), join(dir, "LICENSE"));

// ---- licences and the SBOM
const items = inventory(dir);
const bad = items.filter((i) => !i.own && !licenceAllowed(i.licence));
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
Set-Content -Encoding ASCII -Path (Join-Path $bin "atticus.cmd") -Value "@node \`"$target\\dist\\bin.js\`" %*"
$path = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not ($path -split ";" | Where-Object { $_ -eq $bin })) {
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
  ].join("\r\n"),
);

// ---- checksums and the zip
const files = [];
const walk = (d) => {
  for (const e of readdirSync(d).sort()) {
    const f = join(d, e);
    const st = lstatSync(f);
    // node_modules/.bin links aren't needed: Atticus runs dist/bin.js with node.
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(f);
    else files.push(f);
  }
};
walk(dir);
const rel = (f) => relative(dir, f).split(sep).join("/");
const sums = files
  .filter((f) => rel(f) !== "SHA256SUMS")
  .map((f) => `${createHash("sha256").update(readFileSync(f)).digest("hex")}  ${rel(f)}`)
  .join("\n");
writeFileSync(join(dir, "SHA256SUMS"), `${sums}\n`);
if (!files.some((f) => rel(f) === "SHA256SUMS")) files.push(join(dir, "SHA256SUMS"));
const entries = files.map((f) => ({
  name: `${NAME}/${rel(f)}`,
  data: readFileSync(f),
  mode: rel(f) === "install.sh" || rel(f).endsWith("/bin.js") ? 0o755 : 0o644,
}));
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${NAME}-offline.zip`);
const buf = zip(entries, now);
writeFileSync(out, buf);
const sha = createHash("sha256").update(buf).digest("hex");
writeFileSync(`${out}.sha256`, `${sha}  ${NAME}-offline.zip\n`);
console.log(
  `Wrote ${out} (${(buf.length / 1024 / 1024).toFixed(1)} MB, ${entries.length} files, ${items.filter((i) => !i.own).length} third-party packages).\nsha256 ${sha}`,
);
if (!existsSync(out)) process.exit(1);
