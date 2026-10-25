/* global setTimeout, clearTimeout, fetch */
// pnpm bundle:test <zip>: install the offline bundle the way a person would, into a throwaway
// home folder, with no network, and use it: version, a practice sandbox, doctor, a scan, the
// app's health call. On Windows it runs install.ps1, elsewhere install.sh.
// --plugin <atticus-x.y.z-embeddings-plugin.zip> (with the default bundle): then installs the
// embeddings plugin next to it and checks its fetch step finds the model missing; with
// --plugin-from <folder> (the pinned files, any names, such as .cache/pinned) the step fills them
// offline and the install searches by meaning.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv.splice(i, 2)[1] : undefined;
};
const pluginZip = option("--plugin");
const pluginFrom = option("--plugin-from");
const zipFile = argv[0];
if (
  !zipFile ||
  !existsSync(zipFile) ||
  (pluginZip !== undefined && !existsSync(pluginZip)) ||
  (pluginFrom !== undefined && !pluginZip)
) {
  console.error(
    "Usage: node scripts/bundle/test-bundle.mjs <atticus-x.y.z-offline.zip> [--plugin <atticus-x.y.z-embeddings-plugin.zip> [--plugin-from <folder>]]",
  );
  process.exit(2);
}
const win = process.platform === "win32";
const work = mkdtempSync(join(tmpdir(), "atticus-bundle-test-"));
// A space and a letter outside ASCII, as in many real profile folders.
const home = join(work, "home Mü");
const unpacked = join(work, "unpacked");
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  // No registry, no proxy: an install must not need the network.
  npm_config_offline: "true",
  HTTPS_PROXY: "http://127.0.0.1:9",
  HTTP_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "localhost,127.0.0.1",
};
const run = (cmd, args, o = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], ...o });

if (win)
  run("powershell", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${unpacked}'`,
  ]);
else run("unzip", ["-q", zipFile, "-d", unpacked]);
// Expand-Archive can leave nothing behind and still exit 0 (a full disk, for one).
const [top] = existsSync(unpacked) ? readdirSync(unpacked) : [];
if (!top) throw new Error(`unpacking ${zipFile} left ${unpacked} empty`);
const dir = join(unpacked, top);
// -NoPath: a test install must not leave its throwaway bin folder on the user's PATH.
const out = win
  ? run("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(dir, "install.ps1"),
      "-NoPath",
    ])
  : run("sh", [join(dir, "install.sh")]);
console.log(out.trim());
const version = top.replace(/^atticus-/, "");
const installed = win
  ? join(env.LOCALAPPDATA, "Programs", "Atticus", version, "dist", "bin.js")
  : join(env.XDG_DATA_HOME, "atticus", version, "dist", "bin.js");
const atticus = (...args) => run(process.execPath, [installed, ...args]);
if (atticus("--version").trim() !== version)
  throw new Error("the installed atticus reports another version");
// The command people type: the shim the install script wrote.
const shim = win
  ? run("cmd.exe", [
      "/d",
      "/c",
      join(env.LOCALAPPDATA, "Programs", "Atticus", "bin", "atticus.cmd"),
      "--version",
    ])
  : run("sh", [join(home, ".local", "bin", "atticus"), "--version"]);
if (shim.trim() !== version) throw new Error(`the atticus shim printed ${JSON.stringify(shim)}`);
const sandbox = join(work, "sandbox");
console.log(atticus("sandbox", "create", sandbox).trim());
const root = join(sandbox, "metarepo");
console.log(atticus("doctor", "--root", root).trim().split("\n").at(-1));
console.log(atticus("scan", "--root", root).trim().split("\n").at(-1));

// ADR 0124 addendum D-bundle: the default bundle leaves the embedding plugin out and searches by
// words and names; a bundle built with --with-embeddings carries the model (ADR 0116 addendum)
// and searches by meaning with no network and nothing else to install.
const embeddings = /-offline-embeddings\.zip$/.test(zipFile);
const carries = existsSync(join(dir, "node_modules", "@maycombhq", "embed-model", "model.onnx"));
if (embeddings !== carries)
  throw new Error(
    embeddings
      ? "the bundle doesn't carry the embedding model (@maycombhq/embed-model)"
      : "the default bundle carries the embedding model; it should leave the plugin out",
  );
const embeddingLine = () =>
  atticus("doctor", "--root", root)
    .split("\n")
    .find((l) => /Embedding model/.test(l));
const searchesByMeaning = (what) => {
  const doctor = embeddingLine();
  console.log(doctor);
  if (!/\[ok\].*all-minilm-l6-v2.*runtime: (native|wasm)/.test(doctor ?? ""))
    throw new Error(`doctor didn't find ${what} and its runtime: ${doctor}`);
  console.log(atticus("index", "embed", "--root", root).trim().split("\n").at(-1));
  const hits = atticus(
    "query",
    "how much money is left",
    "--search",
    "--by",
    "meaning",
    "--root",
    root,
  );
  if (!/similar in meaning, cos/.test(hits))
    throw new Error(`${what} didn't search by meaning:\n${hits}`);
  console.log(`${what} searches by meaning offline.`);
};
if (!embeddings) {
  if (existsSync(join(dir, "node_modules", "@maycombhq", "embed")))
    throw new Error("the default bundle carries @maycombhq/embed");
  const doctor = embeddingLine();
  console.log(doctor);
  if (!/\[ok\].*not installed.*words and names/.test(doctor ?? ""))
    throw new Error(`doctor didn't say the embedding plugin is left out: ${doctor}`);
  const hits = atticus("query", "ledger", "--search", "--root", root);
  if (!hits.trim()) throw new Error("the default bundle didn't search by words");
  console.log("The default bundle searches by words and names, without the embedding plugin.");
} else searchesByMeaning("The bundled embedding model");

// ADR 0124 addendum D-bundle: the embeddings plugin zip, installed next to the default bundle.
// It carries the packages and their pins, not the model's or onnxruntime's bytes: its fetch step
// fills them, from --plugin-from here (offline), or says what is missing.
if (pluginZip) {
  if (embeddings) throw new Error("--plugin goes with the default bundle, not --with-embeddings");
  const pluginUnpacked = join(work, "plugin");
  if (win)
    run("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${pluginZip}' -DestinationPath '${pluginUnpacked}'`,
    ]);
  else run("unzip", ["-q", pluginZip, "-d", pluginUnpacked]);
  const [ptop] = existsSync(pluginUnpacked) ? readdirSync(pluginUnpacked) : [];
  if (ptop !== `atticus-${version}-embeddings-plugin`)
    throw new Error(`the plugin zip holds ${ptop}, not atticus-${version}-embeddings-plugin`);
  const pdir = join(pluginUnpacked, ptop);
  if (existsSync(join(pdir, "node_modules", "@maycombhq", "embed-model", "model.onnx")))
    throw new Error("the plugin zip carries the model; its fetch step should add it");
  const added = win
    ? run("powershell", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(pdir, "install.ps1"),
      ])
    : run("sh", [join(pdir, "install.sh")]);
  console.log(added.trim().split("\n")[0]);
  if (!/Added the embedding plugin/.test(added))
    throw new Error(`the plugin's install didn't say it added the plugin:\n${added}`);
  const step = join(dirname(dirname(installed)), "embeddings-plugin", "fetch-model.mjs");
  const fetchModel = (...args) =>
    spawnSync(process.execPath, [step, ...args], { encoding: "utf8", env });
  const check = fetchModel("--check");
  if (check.status !== 1 || !/model\.onnx/.test(check.stdout))
    throw new Error(
      `the fetch step didn't say the model is missing:\n${check.stdout}${check.stderr}`,
    );
  const doctor = embeddingLine();
  console.log(doctor);
  if (!/\[ok\].*model\.onnx isn't there.*words and names/.test(doctor ?? ""))
    throw new Error(`doctor didn't say the plugin's model isn't fetched yet: ${doctor}`);
  if (!atticus("query", "ledger", "--search", "--root", root).trim())
    throw new Error("with the plugin and no model, the install didn't search by words");
  if (pluginFrom) {
    const filled = fetchModel("--from", pluginFrom, "--offline");
    console.log(filled.stdout.trim());
    if (filled.status !== 0) throw new Error(`the fetch step failed:\n${filled.stderr}`);
    searchesByMeaning("The embeddings plugin");
  } else {
    const offline = fetchModel("--offline");
    if (offline.status !== 1 || !/--list names every file it needs/.test(offline.stderr))
      throw new Error(`the fetch step didn't fail offline as it should:\n${offline.stderr}`);
    console.log(
      "The embeddings plugin installs next to the default bundle; its fetch step finds the model missing and, offline, says how to bring it.",
    );
  }
}

// --show-token: since ADR 0119 the token is printed only when asked for (or for an editor).
// The app answers.
const ui = spawn(
  process.execPath,
  [installed, "ui", "--port", "0", "--show-token", "--root", root],
  { env },
);
const url = await new Promise((resolve, reject) => {
  let text = "";
  const t = setTimeout(() => reject(new Error(`atticus ui didn't start: ${text}`)), 30000);
  ui.stdout.on("data", (b) => {
    text += b;
    const m = /running at (http:\/\/127\.0\.0\.1:\d+)/.exec(text);
    const k = /session token is (\S+)/.exec(text);
    if (m && k) {
      clearTimeout(t);
      resolve({ base: m[1], token: k[1] });
    }
  });
});
const health = await fetch(`${url.base}/api/health`, { headers: { "X-Atticus-Token": url.token } });
const page = await fetch(`${url.base}/`);
const exited = new Promise((resolve) => ui.once("exit", resolve));
ui.kill();
await exited;
if (health.status !== 200 || !(await page.text()).includes("atticus-token"))
  throw new Error(`the app didn't answer (health ${health.status})`);
console.log(`The installed app answers at ${url.base}.`);
console.log("Offline bundle test passed.");
// Kept when something fails (to look at); removed when it all passed.
rmSync(work, { recursive: true, force: true, maxRetries: 5 });
