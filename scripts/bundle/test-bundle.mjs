/* global setTimeout, clearTimeout, fetch */
// pnpm bundle:test <zip>: install the offline bundle the way a person would, into a throwaway
// home folder, with no network, and use it: version, a practice sandbox, doctor, a scan, the
// app's health call. On Windows it runs install.ps1, elsewhere install.sh.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const zipFile = process.argv[2];
if (!zipFile || !existsSync(zipFile)) {
  console.error("Usage: node scripts/bundle/test-bundle.mjs <atticus-x.y.z-offline.zip>");
  process.exit(2);
}
const win = process.platform === "win32";
const work = mkdtempSync(join(tmpdir(), "atticus-bundle-test-"));
const home = join(work, "home");
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
const [top] = readdirSync(unpacked);
const dir = join(unpacked, top);
const out = win
  ? run("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(dir, "install.ps1"),
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
const sandbox = join(work, "sandbox");
console.log(atticus("sandbox", "create", sandbox).trim());
const root = join(sandbox, "metarepo");
console.log(atticus("doctor", "--root", root).trim().split("\n").at(-1));
console.log(atticus("scan", "--root", root).trim().split("\n").at(-1));

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
ui.kill();
if (health.status !== 200 || !(await page.text()).includes("atticus-token"))
  throw new Error(`the app didn't answer (health ${health.status})`);
console.log(`The installed app answers at ${url.base}.`);
console.log("Offline bundle test passed.");
