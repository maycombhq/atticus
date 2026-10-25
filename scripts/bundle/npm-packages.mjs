// The npm packages Atticus publishes (ADR 0124 addendum D-npm): which they are, the rules each
// manifest and each packed tarball must meet, how they are packed, and the registry documents
// a throwaway mirror serves for them. Used by `pnpm release:npm` (its pack check) and by
// `pnpm npm:test` (the bank-style install). A package that carries the model or onnxruntime
// (it has a pins.json) is filled by its prepack from the pinned cache, offline, and checked
// here again inside the tarball: every pinned file with its pinned sha256, and its licence.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = fileURLToPath(new URL("../..", import.meta.url));

/** Scripts npm runs when a package is installed: none of Atticus's may have one. */
export const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];

/** The repackaged native runtimes, by name: `@maycombhq/onnxruntime-<os>-<cpu>`. */
const NATIVE = /^@maycombhq\/onnxruntime-(win32|linux|darwin)-(x64|arm64)$/;

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** Every package under packages/ that isn't private: { name, version, dir, manifest }. */
export function publishablePackages(repo = REPO) {
  const out = [];
  for (const d of readdirSync(join(repo, "packages")).sort()) {
    const f = join(repo, "packages", d, "package.json");
    if (!existsSync(f)) continue;
    const manifest = JSON.parse(readFileSync(f, "utf8"));
    if (manifest.private) continue;
    out.push({
      name: manifest.name,
      version: manifest.version,
      dir: join(repo, "packages", d),
      manifest,
    });
  }
  return out;
}

function commonProblems(m) {
  const out = [];
  const scripts = INSTALL_SCRIPTS.filter((s) => m.scripts?.[s] !== undefined);
  if (scripts.length)
    out.push(
      `it has an install script (${scripts.join(", ")}): the bank's mirror may run npm with scripts off, and Atticus never downloads at install`,
    );
  if (m.publishConfig?.access !== "public")
    out.push(
      `publishConfig.access isn't "public": a scoped package is published private otherwise`,
    );
  const native = NATIVE.exec(m.name ?? "");
  if (
    native &&
    (JSON.stringify(m.os) !== JSON.stringify([native[1]]) ||
      JSON.stringify(m.cpu) !== JSON.stringify([native[2]]))
  )
    out.push(
      `os and cpu must be ["${native[1]}"] and ["${native[2]}"], so npm installs it only there`,
    );
  return out;
}

/**
 * A publishable package's manifest in the repo, with its pins.json when it has one: the problems,
 * as sentences. A pinned package lists pins.json and every pinned file in `files`, and its
 * prepack fills them from the cache offline (scripts/model/fetch.mjs . --offline).
 */
export function manifestProblems(m, pins) {
  const out = commonProblems(m);
  if (pins) {
    const files = m.files ?? [];
    const covered = (p) => files.some((f) => p === f || p.startsWith(`${f.replace(/\/$/, "")}/`));
    if (!files.includes("pins.json")) out.push("`files` leaves out pins.json");
    for (const f of pins.files)
      if (!covered(f.path)) out.push(`\`files\` leaves out ${f.path}, which pins.json pins`);
    if (!/scripts\/model\/fetch\.mjs \. --offline/.test(m.scripts?.prepack ?? ""))
      out.push(
        "its prepack doesn't fill the pinned files offline (scripts/model/fetch.mjs . --offline)",
      );
    if (!m.atticusModel && !m.atticusRepackaged)
      out.push(
        "it has a pins.json but says neither atticusModel nor atticusRepackaged (the SBOM reads them)",
      );
  }
  return out;
}

// core's .tgz reader (packages/core must be built), with room for the model's 87 MB.
const core = await import(pathToFileURL(join(REPO, "packages/core/dist/index.js")).href);
const readTarGz = (bytes) =>
  core.readTarGz(bytes, {
    maxEntries: 50_000,
    maxEntryBytes: 512 * 1024 * 1024,
    maxTotalBytes: 2 * 1024 * 1024 * 1024,
  });

/**
 * A packed package (`pnpm pack` output): { name, version, files, unpacked, problems }. Problems:
 * an install script or a binding.gyp, a `workspace:` version left in, not public, a native
 * runtime without its os and cpu, and, for a package that carries a third party's files, any
 * pinned file missing or not its pinned sha256, or no pins.json or licence text.
 */
export function tarballProblems(bytes) {
  const a = readTarGz(bytes);
  const text = a.text("package.json");
  if (!text)
    return {
      name: "?",
      version: "?",
      files: a.names.length,
      unpacked: 0,
      problems: ["it has no package.json"],
    };
  const m = JSON.parse(text);
  const problems = commonProblems(m);
  if (a.has("binding.gyp"))
    problems.push("it has a binding.gyp, which makes npm run node-gyp at install");
  for (const kind of ["dependencies", "optionalDependencies", "peerDependencies"])
    for (const [d, v] of Object.entries(m[kind] ?? {}))
      if (String(v).startsWith("workspace:"))
        problems.push(`${d} is still ${v}: pack it with pnpm, which writes the version`);
  const third = Boolean(m.atticusModel || m.atticusRepackaged);
  const pinsText = a.text("pins.json");
  if (third && !pinsText)
    problems.push(
      "it carries a third party's files (atticusModel or atticusRepackaged) but not its pins.json",
    );
  if (pinsText)
    for (const f of JSON.parse(pinsText).files) {
      const b = a.read(f.path);
      if (!b) problems.push(`${f.path}, pinned in pins.json, isn't in the package`);
      else if (sha256(b) !== f.sha256)
        problems.push(`${f.path} has sha256 ${sha256(b)}, not the pinned ${f.sha256}`);
    }
  if (third && !a.names.some((n) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(n)))
    problems.push("it carries a third party's files but not their licence text (LICENSE)");
  let unpacked = 0;
  for (const n of a.names) unpacked += a.read(n).length;
  return { name: m.name, version: m.version, files: a.names.length, unpacked, problems };
}

/**
 * Run pnpm: the pnpm running this script when it was started by `pnpm <script>`, else the one on
 * PATH (pnpm.cmd on Windows, which Node starts only through a shell).
 */
export function pnpm(args, opts = {}) {
  const exec = process.env.npm_execpath;
  if (exec && /\.[cm]?js$/.test(exec) && /pnpm/.test(basename(exec)))
    return execFileSync(process.execPath, [exec, ...args], { encoding: "utf8", ...opts });
  if (process.platform !== "win32")
    return execFileSync("pnpm", args, { encoding: "utf8", ...opts });
  const quoted = args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a));
  return execFileSync("pnpm", quoted, { encoding: "utf8", shell: true, ...opts });
}

/**
 * Pack each package with `pnpm pack` (which writes the workspace versions and runs prepack: the
 * pinned packages fill from the cache, offline, or refuse) into `dest`. Each as { name, file }.
 */
export function packAll(dest, packages = publishablePackages(), log = () => {}) {
  mkdirSync(dest, { recursive: true });
  const out = [];
  for (const p of packages) {
    const before = new Set(readdirSync(dest));
    pnpm(["pack", "--pack-destination", dest], { cwd: p.dir, stdio: ["ignore", "pipe", "pipe"] });
    const made = readdirSync(dest).filter((f) => f.endsWith(".tgz") && !before.has(f));
    const file =
      made.length === 1 ? made[0] : `${p.name.slice(1).replace("/", "-")}-${p.version}.tgz`;
    if (!existsSync(join(dest, file))) throw new Error(`pnpm pack of ${p.name} wrote no tarball`);
    out.push({ name: p.name, file: join(dest, file) });
    log(`${p.name}@${p.version}`);
  }
  return out;
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

/**
 * The pack check `pnpm release:npm` and `pnpm npm:test` run: every publishable manifest meets
 * the rules, every package packs (the pinned ones from the cache, offline), every tarball meets
 * them, and every Atticus package one depends on is packed at the version it names. Throws with
 * every problem; else { tarballs: [{ name, version, file, bytes, unpacked, files }] }.
 */
export function packAndCheck(dest, o = {}) {
  const log = o.log ?? console.log;
  const pkgs = publishablePackages();
  const problems = [];
  for (const p of pkgs) {
    const pinsFile = join(p.dir, "pins.json");
    const pins = existsSync(pinsFile) ? JSON.parse(readFileSync(pinsFile, "utf8")) : undefined;
    for (const x of manifestProblems(p.manifest, pins)) problems.push(`${p.name}: ${x}`);
  }
  if (problems.length) throw new Error(`The manifests aren't ready:\n  ${problems.join("\n  ")}`);
  const packed = o.packs
    ? readdirSync(o.packs)
        .filter((f) => f.endsWith(".tgz"))
        .map((f) => ({ file: join(o.packs, f) }))
    : packAll(dest, pkgs);
  const tarballs = [];
  for (const t of packed) {
    const bytes = readFileSync(t.file);
    const r = tarballProblems(bytes);
    for (const x of r.problems) problems.push(`${basename(t.file)}: ${x}`);
    tarballs.push({ ...r, file: t.file, bytes: bytes.length });
  }
  const versions = new Map(tarballs.map((t) => [t.name, t.version]));
  for (const p of pkgs)
    if (versions.get(p.name) !== p.version) problems.push(`${p.name}@${p.version} wasn't packed`);
  for (const t of tarballs) {
    const m = JSON.parse(readTarGz(readFileSync(t.file)).text("package.json"));
    for (const [d, v] of Object.entries({ ...m.dependencies, ...m.optionalDependencies }))
      if (d.startsWith("@maycombhq/") && versions.get(d) !== v)
        problems.push(
          `${t.name} needs ${d}@${v}, which isn't packed (${versions.get(d) ?? "none"})`,
        );
  }
  if (problems.length) throw new Error(`The pack check failed:\n  ${problems.join("\n  ")}`);
  const big = [...tarballs].sort((a, b) => b.bytes - a.bytes);
  const total = tarballs.reduce((s, t) => s + t.bytes, 0);
  log(
    `Pack check passed: ${tarballs.length} packages, ${mb(total)} packed. The largest: ${big
      .slice(0, 8)
      .map((t) => `${t.name} ${mb(t.bytes)} (${mb(t.unpacked)} unpacked)`)
      .join(", ")}.`,
  );
  return { tarballs };
}

/**
 * The registry documents ("packuments") a mirror serves for packed tarballs, by package name:
 * each version's manifest with its dist (tarball URL under `base`, sha512 integrity, sha1
 * shasum), and dist-tags latest and `tag` at the highest version given last.
 */
export function packuments(tarballs, base, tag) {
  const docs = new Map();
  for (const t of tarballs) {
    const m = JSON.parse(readTarGz(t.bytes).text("package.json"));
    const short = m.name.split("/").pop();
    const doc = docs.get(m.name) ?? { name: m.name, "dist-tags": {}, versions: {} };
    doc.versions[m.version] = {
      ...m,
      dist: {
        tarball: `${base}/${m.name}/-/${short}-${m.version}.tgz`,
        integrity: `sha512-${createHash("sha512").update(t.bytes).digest("base64")}`,
        shasum: createHash("sha1").update(t.bytes).digest("hex"),
      },
    };
    doc["dist-tags"].latest = m.version;
    if (tag) doc["dist-tags"][tag] = m.version;
    docs.set(m.name, doc);
  }
  return docs;
}
