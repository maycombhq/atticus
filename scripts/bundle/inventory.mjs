// What a deployed Atticus contains: every package under node_modules with its version, licence
// and licence text. Used by the licence check, the SBOM and the offline bundle's LICENSES file.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("../..", import.meta.url));

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
  // ELK.js, the diagram workspace's layout engine (decided by the product owner 2026-10-21;
  // the bank's licence policy is confirmed before the pilot, dagre replaces it if refused).
  "EPL-2.0",
]);

/**
 * Licences allowed for font files only, never for code: the app's fonts (IBM Plex Sans, JetBrains
 * Mono, Rajdhani) are under the SIL Open Font License (decided by the product owner 2026-10-22,
 * decisions-pending item 19).
 */
export const FONT_ALLOWED = new Set(["OFL-1.1"]);

/** An SPDX expression is allowed when one side of every OR, and both sides of every AND, are. */
export function licenceAllowed(expr) {
  if (!expr) return false;
  const e = expr.replace(/[()]/g, " ").trim();
  return e
    .split(/\s+OR\s+/i)
    .some((alt) => alt.split(/\s+AND\s+/i).every((id) => ALLOWED.has(id.trim())));
}

/**
 * Run pnpm: the pnpm running this script when it was started by `pnpm <script>`, else the one on
 * PATH. On Windows that one is pnpm.cmd, which Node only starts through a shell.
 */
function pnpm(args, opts) {
  const exec = process.env.npm_execpath;
  if (exec && /\.[cm]?js$/.test(exec)) return execFileSync(process.execPath, [exec, ...args], opts);
  if (process.platform !== "win32") return execFileSync("pnpm", args, opts);
  const quoted = args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a));
  return execFileSync("pnpm", quoted, { ...opts, shell: true });
}

/** `pnpm deploy` of the CLI with production dependencies only, into a new folder. */
export function deploy(dir = join(mkdtempSync(join(tmpdir(), "atticus-deploy-")), "atticus")) {
  // Hoisted: real folders, no symlinks, so the zip (and Windows) see one copy of each package.
  // --prefer-offline, not --offline: a fresh `pnpm install --frozen-lockfile` fills the store
  // but not pnpm's metadata cache, which --offline needs. The lockfile still fixes every version.
  pnpm(
    [
      "--filter",
      "@maycombhq/cli",
      "deploy",
      "--prod",
      "--legacy",
      "--prefer-offline",
      "--config.node-linker=hoisted",
      dir,
    ],
    { cwd: REPO, stdio: "pipe" },
  );
  return dir;
}

/** Remove a folder deploy() made (its atticus-deploy-* parent in the temp folder). */
export function removeDeploy(dir) {
  const parent = dirname(dir);
  if (dirname(parent) === tmpdir() && basename(parent).startsWith("atticus-deploy-"))
    rmSync(parent, { recursive: true, force: true, maxRetries: 5 });
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
    // Files a package vendors (a prebuilt grammar, ADR 0060), each with its own licence.
    const vendored = join(dir, "grammars", "vendored.json");
    if (existsSync(vendored))
      for (const v of JSON.parse(readFileSync(vendored, "utf8"))) {
        const vkey = `${v.name}@${v.version}`;
        if (out.has(vkey)) continue;
        out.set(vkey, {
          name: v.name,
          version: v.version,
          licence: v.licence,
          text: readFileSync(join(dir, "grammars", v.licenceFile), "utf8"),
          own: false,
          purl: `pkg:generic/${v.name}@${v.version}?vcs_url=${encodeURIComponent(v.source)}`,
          hashes: [{ alg: "SHA-256", content: v.sha256 }],
        });
      }
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
        purl: i.purl ?? purl(i),
        ...(i.hashes ? { hashes: i.hashes } : {}),
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
