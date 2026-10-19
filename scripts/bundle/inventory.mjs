// What a deployed Atticus contains: every package under node_modules with its version, licence
// and licence text. Used by the licence check, the SBOM and the offline bundle's LICENSES file.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPO = new URL("../..", import.meta.url).pathname;

/** Licences Atticus may ship (SPDX ids); anything else fails the check. */
export const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
  "Python-2.0",
]);

/** An SPDX expression is allowed when one side of every OR, and both sides of every AND, are. */
export function licenceAllowed(expr) {
  if (!expr) return false;
  const e = expr.replace(/[()]/g, " ").trim();
  return e
    .split(/\s+OR\s+/i)
    .some((alt) => alt.split(/\s+AND\s+/i).every((id) => ALLOWED.has(id.trim())));
}

/** `pnpm deploy` of the CLI with production dependencies only, into a new folder. */
export function deploy(dir = join(mkdtempSync(join(tmpdir(), "atticus-deploy-")), "atticus")) {
  // Hoisted: real folders, no symlinks, so the zip (and Windows) see one copy of each package.
  execFileSync(
    "pnpm",
    [
      "--filter",
      "@maycombhq/cli",
      "deploy",
      "--prod",
      "--legacy",
      "--offline",
      "--config.node-linker=hoisted",
      dir,
    ],
    {
      cwd: REPO,
      stdio: "pipe",
    },
  );
  return dir;
}

function licenceOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return undefined;
}

function licenceText(dir) {
  const f = readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(n));
  return f ? readFileSync(join(dir, f), "utf8") : undefined;
}

/** Every package in a deployed folder: { name, version, licence, text, own }. */
export function inventory(deployDir) {
  const out = new Map();
  const add = (dir) => {
    const pj = join(dir, "package.json");
    if (!existsSync(pj)) return;
    const pkg = JSON.parse(readFileSync(pj, "utf8"));
    if (!pkg.name || !pkg.version) return;
    const key = `${pkg.name}@${pkg.version}`;
    if (out.has(key)) return;
    out.set(key, {
      name: pkg.name,
      version: pkg.version,
      licence: licenceOf(pkg),
      text: licenceText(dir),
      own: pkg.name.startsWith("@maycombhq/"),
    });
  };
  // Every node_modules folder, nested ones included (a package that needs another version).
  const walk = (nm) => {
    if (!existsSync(nm)) return;
    for (const n of readdirSync(nm)) {
      if (n.startsWith(".")) continue;
      const dirs = n.startsWith("@")
        ? readdirSync(join(nm, n)).map((m) => join(nm, n, m))
        : [join(nm, n)];
      for (const d of dirs) {
        add(d);
        walk(join(d, "node_modules"));
      }
    }
  };
  walk(join(deployDir, "node_modules"));
  add(deployDir);
  return [...out.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

/** A CycloneDX 1.5 SBOM of the inventory. */
export function cyclonedx(items, o) {
  const purl = (i) =>
    `pkg:npm/${i.name.startsWith("@") ? `%40${i.name.slice(1)}` : i.name}@${i.version}`;
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      timestamp: o.timestamp,
      component: {
        type: "application",
        name: "atticus",
        version: o.version,
        licenses: [{ license: { id: "Apache-2.0" } }],
      },
    },
    components: items
      .filter((i) => i.name !== "@maycombhq/cli")
      .map((i) => ({
        type: "library",
        name: i.name,
        version: i.version,
        purl: purl(i),
        ...(i.licence
          ? {
              licenses: [
                /\s(OR|AND)\s/.test(i.licence)
                  ? { expression: i.licence }
                  : { license: { id: i.licence } },
              ],
            }
          : {}),
      })),
  };
}
