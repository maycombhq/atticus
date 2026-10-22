// Copy the Atticus app's build (packages/ui/dist) into media/app, for the panel to load from the
// extension's own files (ADR 0097), with THIRD-PARTY-LICENSES.txt for the code and fonts inside
// it. Which packages are inside comes from the build's own source maps; the maps themselves stay
// out of the package. A licence the repo doesn't allow fails the copy; a font package may also be
// under a licence allowed for fonts only (the SIL Open Font License).
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FONT_ALLOWED, licenceAllowed } from "../../../scripts/bundle/inventory.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const from = join(repo, "packages", "ui", "dist");
const to = join(here, "..", "media", "app");
if (!existsSync(join(from, "index.html"))) {
  console.error(
    `The app isn't built: ${from} has no index.html. Run pnpm --filter @maycombhq/ui build first.`,
  );
  process.exit(1);
}

/** Every package whose code is in the build, by its folder, from the source maps. */
const packages = new Map();
const assets = join(from, "assets");
for (const f of readdirSync(assets).filter((x) => x.endsWith(".map"))) {
  const map = JSON.parse(readFileSync(join(assets, f), "utf8"));
  for (const s of map.sources ?? []) {
    const abs = resolve(assets, map.sourceRoot ?? "", s)
      .split("\\")
      .join("/");
    const m = /^(.*\/node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(abs);
    if (m && !packages.has(m[2])) packages.set(m[2], m[1]);
  }
}
// The fonts are files, not code: their families are in the asset names.
const store = join(repo, "node_modules", ".pnpm");
const families = new Set(
  readdirSync(assets)
    .map((x) => /^([a-z-]+?)-(?:latin|cyrillic|greek|vietnamese)/.exec(x)?.[1])
    .filter(Boolean),
);
for (const family of families) {
  const dir =
    existsSync(store) && readdirSync(store).find((d) => d.startsWith(`@fontsource+${family}@`));
  if (dir)
    packages.set(`@fontsource/${family}`, join(store, dir, "node_modules", "@fontsource", family));
}

const notices = [];
const refused = [];
for (const [name, dir] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const licence = typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
  const file = readdirSync(dir).find((x) => /^(licen[cs]e|copying|ofl)/i.test(x));
  const text = file
    ? readFileSync(join(dir, file), "utf8")
    : `Licensed under ${licence}; no licence file in the package.`;
  const rule = "=".repeat(72);
  notices.push(`${rule}\n${name}@${pkg.version} (${licence})\n${rule}\n${text.trim()}\n`);
  const font = name.startsWith("@fontsource/") && FONT_ALLOWED.has(licence);
  if (!font && !licenceAllowed(licence))
    refused.push(`${name}@${pkg.version}: ${licence ?? "no licence"}`);
}
if (refused.length) {
  for (const r of refused) console.error(`Not an allowed licence: ${r}`);
  process.exit(1);
}

rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true, filter: (src) => !src.endsWith(".map") });
writeFileSync(join(to, "THIRD-PARTY-LICENSES.txt"), notices.join("\n"));
console.log(`Copied the app into ${to}, with the licences of ${notices.length} packages.`);
