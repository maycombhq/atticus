/* global setTimeout, clearTimeout, fetch */
// pnpm bundle:test <zip>: install the offline bundle the way a person would, into a throwaway
// home folder, with no network, and use it: version, a practice sandbox, doctor, a scan, the
// app's health call. On Windows it runs install.ps1, elsewhere install.sh.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const zipFile = process.argv[2];
if (!zipFile || !existsSync(zipFile)) {
  console.error("Usage: node scripts/bundle/test-bundle.mjs <atticus-x.y.z-offline.zip>");
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

// ADR 0116: a bundle that carries the embedding model searches by meaning, with no network.
if (existsSync(join(dir, "node_modules", "@maycombhq", "embed-model", "atticus-model.yaml"))) {
  const rt = join(root, "org-pack", "runtime.yaml");
  appendFileSync(rt, "\nretrieval:\n  embeddings: { model: bundled }\n");
  console.log(
    atticus("doctor", "--root", root)
      .split("\n")
      .find((l) => /Embedding model/.test(l)),
  );
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
    throw new Error(`the bundled model didn't search by meaning:\n${hits}`);
  console.log("The bundled embedding model searches by meaning offline.");
}

// The app answers.
const ui = spawn(process.execPath, [installed, "ui", "--port", "0", "--root", root], { env });
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
