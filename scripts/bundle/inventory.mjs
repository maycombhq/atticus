// What a deployed Atticus contains: every package under node_modules with its version, licence
// and licence text. Used by the licence check, the SBOM and the offline bundle's LICENSES file.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
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

/** Whether an inventory item's licence is allowed: ALLOWED, or OFL-1.1 for a font package. */
export const itemAllowed = (i) =>
  licenceAllowed(i.licence) || (i.font === true && FONT_ALLOWED.has(i.licence));

/**
 * Run pnpm: the pnpm running this script when it was started by `pnpm <script>`, else the one on
 * PATH. On Windows that one is pnpm.cmd, which Node only starts through a shell.
 */
function pnpm(args, opts) {
  try {
    return runPnpm(args, opts);
  } catch (e) {
    // execFileSync's error carries pnpm's output as bytes; say it as text, so a CI log shows why.
    const said = [e.stdout, e.stderr]
      .map((b) => (b ? b.toString() : ""))
      .join("\n")
      .trim();
    if (said) process.stderr.write(`pnpm ${args.join(" ")} failed:\n${said.slice(-6000)}\n`);
    throw e;
  }
}
function runPnpm(args, opts) {
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
  workspaceShaped(dir);
  return dir;
}

/**
 * ADR 0124 addendum D-npm2: a package npm publishes bundled (the SDK: its `files` is the npm/
 * layout, which carries its own copy of the core) is deployed as the workspace builds it: its
 * compiled folder, against the deploy's one @maycombhq/core, so the offline bundle runs one copy
 * of each package (the core keeps per-process state). The folders copied, as package names.
 */
export function workspaceShaped(deployDir, repo = REPO) {
  const done = [];
  for (const d of readdirSync(join(repo, "packages"))) {
    const f = join(repo, "packages", d, "package.json");
    if (!existsSync(f)) continue;
    const m = JSON.parse(readFileSync(f, "utf8"));
    if (!m.atticusBundled || !m.main) continue;
    const target = join(deployDir, "node_modules", ...m.name.split("/"));
    const main = m.main.replace(/^\.\//, "");
    // npm's file list always takes `main` itself, so the rest of its folder is what is missing.
    if (!existsSync(target)) continue;
    const top = main.split("/")[0];
    cpSync(join(repo, "packages", d, top), join(target, top), {
      recursive: true,
      filter: (p) => !p.endsWith(".map"),
    });
    done.push(m.name);
  }
  return done;
}

/** Remove a folder deploy() made (its atticus-deploy-* parent in the temp folder). */
export function removeDeploy(dir) {
  const parent = dirname(dir);
  if (dirname(parent) === tmpdir() && basename(parent).startsWith("atticus-deploy-"))
    rmSync(parent, { recursive: true, force: true, maxRetries: 5 });
}

/**
 * The embedding plugin's packages (ADR 0116; optional since ADR 0124 addendum D-bundle): the
 * runner, the model, onnxruntime's builds and the one third-party package only they use.
 */
export const embeddingPackage = (name) =>
  /^@maycombhq\/(embed|embed-model|onnxruntime-[a-z0-9-]+)$/.test(name) ||
  name === "onnxruntime-common";

/**
 * Remove from a deployed folder every package whose name `drop` keeps (ADR 0124 addendum
 * D-bundle: the embedding plugin), nested copies too. The names removed, sorted, once each.
 */
export function removePackages(deployDir, drop) {
  const gone = new Set();
  const walk = (nm) => {
    if (!existsSync(nm)) return;
    for (const n of readdirSync(nm)) {
      if (n.startsWith(".")) continue;
      const dirs = n.startsWith("@")
        ? readdirSync(join(nm, n)).map((m) => join(nm, n, m))
        : [join(nm, n)];
      for (const d of dirs) {
        const pj = join(d, "package.json");
        const name = existsSync(pj) ? JSON.parse(readFileSync(pj, "utf8")).name : undefined;
        if (name && drop(name)) {
          rmSync(d, { recursive: true, force: true });
          gone.add(name);
        } else walk(join(d, "node_modules"));
      }
    }
  };
  walk(join(deployDir, "node_modules"));
  return [...gone].sort();
}

/** A manifest's licence (SPDX), from `license` or the old `licenses` list. */
export function licenceOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return undefined;
}

/** The text of a package folder's LICENSE (LICENCE, COPYING), if it has one. */
export function licenceText(dir) {
  const f = readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(n));
  return f ? readFileSync(join(dir, f), "utf8") : undefined;
}

/**
 * Files no bundle may carry, whatever package brings them (ADR 0116): DirectML and its shader
 * compiler come with onnxruntime-node under Microsoft's own redistribution terms, which aren't
 * on the allowed list. Each as { file, why }.
 */
export function forbiddenFiles(deployDir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/^(DirectML|dxcompiler|dxil)\.dll$/i.test(e.name))
        out.push({
          file: f,
          why: "DirectML's licence isn't on the allowed list (ADR 0052, 0116); ship the CPU build only",
        });
    }
  };
  if (existsSync(join(deployDir, "node_modules"))) walk(join(deployDir, "node_modules"));
  return out;
}

/** Every package in a deployed folder: { name, version, licence, text, own }. */
export function inventory(deployDir, o = {}) {
  const out = new Map();
  const add = (dir) => {
    const pj = join(dir, "package.json");
    if (!existsSync(pj)) return;
    const pkg = JSON.parse(readFileSync(pj, "utf8"));
    if (!pkg.name || !pkg.version) return;
    const key = `${pkg.name}@${pkg.version}`;
    if (out.has(key)) return;
    // ADR 0116: the bundled embedding model is a third party's weights, not Atticus's own code.
    const m = pkg.atticusModel;
    // A third party's files Atticus repackages (onnxruntime's CPU and WASM builds, ADR 0116).
    const rp = pkg.atticusRepackaged;
    // Whether it holds any of the third party's files its pins.json names (other than the
    // licence): an npm install or a --with-embeddings bundle does; the plugin zip doesn't yet.
    const pinsFile = join(dir, "pins.json");
    const carriesPinned =
      (m || rp) && existsSync(pinsFile)
        ? JSON.parse(readFileSync(pinsFile, "utf8")).files.some(
            (f) =>
              !/^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f.path) &&
              existsSync(join(dir, ...f.path.split("/"))),
          )
        : Boolean(m || rp);
    out.set(key, {
      name: pkg.name,
      version: pkg.version,
      licence: licenceOf(pkg),
      text: licenceText(dir),
      own: pkg.name.startsWith("@maycombhq/") && !m && !rp,
      ...(m || rp ? { carriesPinned } : {}),
      ...(rp ? { purl: `pkg:npm/${rp.from}`, repackagedFrom: rp.from } : {}),
      ...(m
        ? {
            model: m.name,
            purl: `pkg:generic/${m.name}@${m.sha256.slice(0, 12)}${m.source ? `?download_url=${encodeURIComponent(m.source)}` : ""}`,
            hashes: [{ alg: "SHA-256", content: m.sha256 }],
          }
        : {}),
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
  // modules: false reads a built package alone (packages/atticus: its node_modules are the
  // workspace's links, not what npm installs).
  if (o.modules !== false) walk(join(deployDir, "node_modules"));
  add(deployDir);
  // ADR 0124 addendum D-npm2: the third parties a bundled package (@maycombhq/atticus) carries
  // inside, as its build listed them, each with its section of THIRD-PARTY-LICENSES.txt.
  const listed = join(deployDir, "dist", "third-party.json");
  const txtFile = join(deployDir, "THIRD-PARTY-LICENSES.txt");
  if (existsSync(listed)) {
    const txt = existsSync(txtFile) ? readFileSync(txtFile, "utf8") : "";
    for (const t of JSON.parse(readFileSync(listed, "utf8"))) {
      const key = `${t.name}@${t.version}`;
      if (out.has(key)) continue;
      // Each section: a rule, `name@version (licence)`, a rule, the text.
      const rule = `${"=".repeat(72)}\n`;
      const head = `${key} (${t.licence})\n${rule}`;
      const at = txt.indexOf(head);
      const start = at + head.length;
      const end = txt.indexOf(`\n${rule}`, start);
      out.set(key, {
        name: t.name,
        version: t.version,
        licence: t.licence,
        text: at < 0 ? undefined : txt.slice(start, end < 0 ? undefined : end).trim() || undefined,
        own: false,
        bundled: true,
        ...(t.font ? { font: true } : {}),
      });
    }
  }
  return [...out.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

/**
 * ADR 0124 addendum D-npm: a package that carries a third party's files (the model, onnxruntime's
 * builds) ships their licence text with them. Each one that doesn't, as a sentence.
 */
export function unlicensedThirdParty(items) {
  return [
    ...items
      .filter((i) => i.carriesPinned && !i.text)
      .map(
        (i) =>
          `${i.name}@${i.version} ships ${i.repackagedFrom ?? i.model ?? "a third party"}'s files without their licence text`,
      ),
    // ADR 0124 addendum D-npm2: a third party bundled inside @maycombhq/atticus.
    ...items
      .filter((i) => i.bundled && !i.text)
      .map(
        (i) =>
          `${i.name}@${i.version} is bundled but THIRD-PARTY-LICENSES.txt doesn't hold its licence`,
      ),
  ];
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
        type: i.model ? "machine-learning-model" : "library",
        name: i.model ?? i.name,
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
