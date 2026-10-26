/* global fetch, Buffer */
// pnpm npm:test [--packs <folder>] [--offline] [--mirror-cache <folder>] [--upstream <url>] [--keep]
//
// Install Atticus the way a bank with an npm mirror would (ADR 0124 addenda D-npm and D-npm2),
// and use it.
// 1. Pack the public packages (the pack check of `pnpm release:npm`: @maycombhq/atticus with every
//    file its dist/files.json lists, the SDK, the model and onnxruntime filled from .cache/pinned,
//    offline), or take the tarballs in --packs.
// 2. Start a throwaway mirror on 127.0.0.1, as Artifactory or Nexus would be: Atticus's packages
//    from those tarballs, every other package from --upstream (default the npm registry) through
//    the mirror, kept in --mirror-cache (default .cache/npm-mirror). --offline: the mirror serves
//    only what it already holds.
// 3. `npm install --global --ignore-scripts @maycombhq/atticus@<version>` into a new prefix, with
//    a new HOME, an empty npm cache and config, and no proxy: npm reaches nothing but the mirror.
// 4. With the network blocked (Linux: a new network namespace through `unshare -rn`; elsewhere,
//    or with ATTICUS_NPM_TEST_PROXY_ONLY=1, a proxy that goes nowhere): atticus --version, a
//    licence check of what npm installed (the bundled third parties too), atticus init and doctor
//    (Embedding model: ready, runtime native), a Forge practice metarepo, a scan, atticus index
//    embed, a search by meaning for a paraphrase, `atticus map <repo> --estimate` on one of its
//    repos, and `atticus ui` started and answering one API call (in the namespace, its own
//    loopback brought up: ip, else Python's ioctl).
// Prints how many packages npm installed, what it downloaded and the size on disk. Needs
// `pnpm build` (and `pnpm model:fetch` unless --packs is given).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rerunWithEnvProxy } from "../model/paths.mjs";
import { inventory, itemAllowed, unlicensedThirdParty } from "./inventory.mjs";
import { packAndCheck, packuments, REPO } from "./npm-packages.mjs";

const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const offline = argv.includes("--offline");
const keep = argv.includes("--keep");
const packsDir = option("--packs");
const upstream = (option("--upstream") ?? "https://registry.npmjs.org").replace(/\/$/, "");
const mirrorCache = option("--mirror-cache") ?? join(REPO, ".cache", "npm-mirror");
// The mirror's own downloads go through the machine's proxy, as the bank's mirror's would.
rerunWithEnvProxy(import.meta.url, argv, !offline);

const MAIN = "@maycombhq/atticus";
const win = process.platform === "win32";
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const work = mkdtempSync(join(tmpdir(), "atticus-npm-test-"));
const fail = (msg) => {
  console.error(`${msg}\n(kept for a look: ${work})`);
  process.exit(1);
};

// ---- 1. The tarballs
console.log(
  packsDir ? `Checking the tarballs in ${packsDir}...` : "Packing the public packages...",
);
let tarballs;
try {
  ({ tarballs } = packAndCheck(join(work, "packs"), packsDir ? { packs: packsDir } : {}));
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
const main = tarballs.find((t) => t.name === MAIN);
if (!main) fail(`${MAIN} wasn't packed`);

// ---- 2. The mirror
const served = []; // { name, bytes, ours }
const localTar = new Map();
let docs;
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const local = localTar.get(path);
    if (local) {
      const b = readFileSync(local.file);
      served.push({ name: local.name, bytes: b.length, ours: true });
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": b.length,
      });
      return res.end(b);
    }
    const name = path.slice(1);
    if (docs.has(name)) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(docs.get(name)));
    }
    // The scope comes only from the tarballs: never from upstream.
    if (name.startsWith("@maycombhq/")) {
      res.writeHead(404);
      return res.end();
    }
    const tarball = /\/-\/[^/]+\.tgz$/.test(path);
    const key = createHash("sha256")
      .update(`${tarball ? "" : req.headers.accept}\n${path}`)
      .digest("hex");
    const kept = join(mirrorCache, key);
    let body;
    if (existsSync(kept)) body = readFileSync(kept);
    else if (offline) {
      console.error(`  the mirror doesn't hold ${path} (--offline)`);
      res.writeHead(404);
      return res.end();
    } else {
      const r = await fetch(`${upstream}${path}`, {
        headers: tarball ? {} : { accept: req.headers.accept ?? "application/json" },
      });
      if (!r.ok) {
        res.writeHead(r.status);
        return res.end();
      }
      body = Buffer.from(await r.arrayBuffer());
      mkdirSync(mirrorCache, { recursive: true });
      writeFileSync(kept, body);
    }
    // A document's tarball links point at the mirror, as a mirror's do (kept as upstream wrote
    // it: the mirror's port changes each run).
    if (!tarball) body = Buffer.from(body.toString("utf8").split(`${upstream}/`).join(`${base}/`));
    if (tarball)
      served.push({ name: path.split("/-/")[0].slice(1), bytes: body.length, ours: false });
    res.writeHead(200, {
      "content-type": tarball ? "application/octet-stream" : "application/json",
      "content-length": body.length,
    });
    res.end(body);
  } catch (e) {
    console.error(`  the mirror failed on ${req.url}: ${e instanceof Error ? e.message : e}`);
    res.writeHead(502);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const tag = /-([a-z]+)/i.exec(main.version)?.[1];
docs = packuments(
  tarballs.map((t) => ({ file: t.file, bytes: readFileSync(t.file) })),
  base,
  tag,
);
for (const d of docs.values())
  for (const v of Object.values(d.versions))
    localTar.set(new URL(v.dist.tarball).pathname, {
      name: d.name,
      file: tarballs.find((t) => t.name === d.name && t.version === v.version).file,
    });
console.log(
  `The mirror: ${base} (${docs.size} Atticus packages; the rest from ${offline ? "its cache only" : upstream})`,
);

// ---- 3. npm install, the way the bank would
const home = join(work, "home Mü"); // a space and a letter outside ASCII, as in real profiles
const prefix = join(work, "prefix");
mkdirSync(home, { recursive: true });
mkdirSync(prefix, { recursive: true });
writeFileSync(join(home, ".npmrc"), "");
writeFileSync(
  join(home, ".gitconfig"),
  "[user]\n\tname = Bank Tester\n\temail = tester@example.invalid\n[init]\n\tdefaultBranch = main\n",
);
const clean = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !/proxy|^npm_|^NODE_OPTIONS$|^ATTICUS_|^GIT_/i.test(k),
  ),
);
const env = {
  ...clean,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, ".config"),
  npm_config_userconfig: join(home, ".npmrc"),
  npm_config_cache: join(home, ".npm"),
};
const install = [
  "install",
  "--global",
  "--prefix",
  prefix,
  "--ignore-scripts",
  "--registry",
  base,
  "--no-audit",
  "--no-fund",
  "--update-notifier=false",
  "--loglevel",
  "warn",
  `${MAIN}@${main.version}`,
];
console.log(`npm ${install.join(" ")}`);
const t0 = Date.now();
const npm = await new Promise((resolve) => {
  const p = spawn("npm", install, {
    env,
    cwd: work,
    shell: win,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  p.stdout.on("data", (b) => (out += b));
  p.stderr.on("data", (b) => (out += b));
  p.on("close", (status) => resolve({ status, out }));
});
server.close();
console.log(npm.out.trim().split("\n").slice(-3).join("\n"));
if (npm.status !== 0) fail(`npm install failed (exit ${npm.status})`);
console.log(`Installed in ${((Date.now() - t0) / 1000).toFixed(0)} s.`);
// The tarballs and npm's cache aren't needed any more: room on a small runner's disk.
if (!packsDir) rmSync(join(work, "packs"), { recursive: true, force: true, maxRetries: 5 });
rmSync(join(home, ".npm"), { recursive: true, force: true, maxRetries: 5 });

// ---- What was installed and downloaded
const ours = served.filter((s) => s.ours);
const theirs = served.filter((s) => !s.ours);
const sum = (xs) => xs.reduce((s, x) => s + x.bytes, 0);
const pkgDir = win
  ? join(prefix, "node_modules", "@maycombhq", "atticus")
  : join(prefix, "lib", "node_modules", "@maycombhq", "atticus");
const installed = [];
const walkModules = (nm) => {
  if (!existsSync(nm)) return;
  for (const n of readdirSync(nm).filter((n) => !n.startsWith("."))) {
    const dirs = n.startsWith("@")
      ? readdirSync(join(nm, n)).map((m) => join(nm, n, m))
      : [join(nm, n)];
    for (const d of dirs) {
      if (!existsSync(join(d, "package.json"))) continue;
      installed.push(JSON.parse(readFileSync(join(d, "package.json"), "utf8")).name);
      walkModules(join(d, "node_modules"));
    }
  }
};
walkModules(join(pkgDir, "..", ".."));
const du = (d) =>
  readdirSync(d, { withFileTypes: true }).reduce(
    (s, e) =>
      s + (e.isDirectory() ? du(join(d, e.name)) : e.isFile() ? statSync(join(d, e.name)).size : 0),
    0,
  );
const sizeOf = (name) => mb(sum(ours.filter((s) => s.name === name)));
console.log(
  `npm installed ${installed.length} packages (${installed.join(", ")}) and downloaded ${served.length} tarballs, ${mb(sum(served))}: ${MAIN} ${sizeOf(MAIN)}, the model ${sizeOf("@maycombhq/embed-model")}, ${ours
    .filter((s) => /^@maycombhq\/onnxruntime-/.test(s.name))
    .map((r) => `${r.name.slice("@maycombhq/".length)} ${mb(r.bytes)}`)
    .join(
      ", ",
    )}${theirs.length ? `, and ${theirs.length} third-party (${theirs.map((t) => t.name).join(", ")}, ${mb(sum(theirs))})` : ""}. On disk: ${mb(du(prefix))}.`,
);

// ---- 4. The install, used with the network blocked
const nm = join(pkgDir, "node_modules", "@maycombhq");
const here = `onnxruntime-${process.platform}-${process.arch}`;
const others = existsSync(nm)
  ? readdirSync(nm).filter((n) => /^onnxruntime-(?!wasm$)/.test(n) && n !== here)
  : [];
if (others.length) fail(`npm installed other platforms' runtimes: ${others.join(", ")}`);
if (!existsSync(join(nm, "embed-model", "model.onnx")))
  fail("the installed @maycombhq/embed-model has no model.onnx");
const native = existsSync(join(nm, here, "dist", "index.js"));

// Every package npm installed, and every third party bundled inside @maycombhq/atticus: under a
// licence Atticus may ship, with its licence text where it carries a third party's files.
const items = inventory(pkgDir);
const third = items.filter((i) => !i.own);
const badLicence = third
  .filter((i) => !itemAllowed(i))
  .map((i) => `${i.name}@${i.version}: ${i.licence}`);
const unlicensed = unlicensedThirdParty(items);
if (badLicence.length || unlicensed.length)
  fail(
    `The licence check of the install failed:\n  ${[...badLicence, ...unlicensed].join("\n  ")}`,
  );
console.log(
  `Licence check of the install passed: ${third.filter((i) => i.bundled).length} third parties bundled in ${MAIN}, each in THIRD-PARTY-LICENSES.txt; installed beside it ${third
    .filter((i) => !i.bundled)
    .map((i) => `${i.name} (${i.licence})${i.carriesPinned ? " with its licence text" : ""}`)
    .join(", ")}.`,
);

// ATTICUS_NPM_TEST_PROXY_ONLY=1 takes the GitHub-runner path (the proxy pointing nowhere) here too.
const blocked =
  !win &&
  !process.env.ATTICUS_NPM_TEST_PROXY_ONLY &&
  spawnSync("unshare", ["-rn", "true"]).status === 0;
const netEnv = blocked
  ? env
  : {
      ...env,
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      NODE_USE_ENV_PROXY: "1",
    };
console.log(
  blocked
    ? "The network is blocked for every atticus command (a new network namespace: unshare -rn)."
    : "Every atticus command runs with its proxy pointing nowhere (no network namespace here).",
);
const bin = win ? join(prefix, "atticus.cmd") : join(prefix, "bin", "atticus");
const atticus = (...args) => {
  const [cmd, a] = blocked ? ["unshare", ["-rn", bin, ...args]] : [bin, args];
  const r = spawnSync(cmd, a, { encoding: "utf8", env: netEnv, cwd: work, shell: win && !blocked });
  return { status: r.status, stdout: r.stdout ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const show = (label, r) => console.log(`$ atticus ${label}\n${r.out.trim()}`);

const v = atticus("--version");
show("--version", v);
// stdout alone: with the proxy pointing nowhere, Node warns on stderr that NODE_USE_ENV_PROXY's
// agent is experimental (a GitHub runner has no network namespace to block the network instead).
if (v.stdout.trim() !== main.version)
  fail(`atticus --version printed ${v.stdout.trim()}, not ${main.version}`);

const meta = join(work, "bank-meta");
const init = atticus("init", meta, "--platform", "forge", "--owner", "tester");
if (init.status !== 0) fail(`atticus init failed:\n${init.out}`);
console.log(
  `$ atticus init bank-meta --platform forge --owner tester\n${init.out.trim().split("\n").slice(0, 2).join("\n")}`,
);
const doctor = atticus("doctor", "--root", meta);
const doctorLines = doctor.out.split("\n");
const embedLine = doctorLines.find((l) => /Embedding model/.test(l)) ?? "";
const openspecLine = doctorLines.find((l) => /OpenSpec CLI/.test(l)) ?? "";
console.log(`$ atticus doctor\n${openspecLine}\n${embedLine}`);
const want = native ? "native" : "wasm";
if (
  !new RegExp(
    `\\[ok\\]\\s+Embedding model: ready: all-minilm-l6-v2@.*installed with Atticus.*runtime: ${want}`,
  ).test(embedLine)
)
  fail(
    `doctor didn't say the model installed with Atticus is ready with the ${want} runtime:\n${doctor.out}`,
  );
if (!/\[ok\]\s+OpenSpec CLI: OpenSpec \d/.test(openspecLine))
  fail(`doctor didn't run the OpenSpec CLI bundled in ${MAIN}:\n${doctor.out}`);

const practice = join(work, "practice");
const sandbox = atticus("sandbox", "create", practice);
if (sandbox.status !== 0) fail(`atticus sandbox create failed:\n${sandbox.out}`);
const root = join(practice, "metarepo");
console.log(`$ atticus sandbox create practice\n${sandbox.out.trim().split("\n")[0]}`);
const scan = atticus("scan", "--root", root);
if (scan.status !== 0) fail(`atticus scan failed:\n${scan.out}`);
console.log(`$ atticus scan\n${scan.stdout.trim().split("\n").at(-1)}`);
const embed = atticus("index", "embed", "--root", root);
show("index embed", embed);
if (embed.status !== 0) fail("atticus index embed failed");
// A paraphrase: none of its words is the ledger's.
const question = "how much money is left";
const query = atticus("query", question, "--search", "--by", "meaning", "--root", root);
console.log(
  `$ atticus query "${question}" --search --by meaning\n${query.out.trim().split("\n").slice(0, 2).join("\n")}`,
);
if (query.status !== 0 || !/similar in meaning, cos/.test(query.out))
  fail("the search by meaning found nothing");

const map = atticus("map", "forge-ledger", "--estimate", "--root", root);
console.log(
  `$ atticus map forge-ledger --estimate\n${map.out.trim().split("\n").slice(0, 3).join("\n")}`,
);
if (map.status !== 0 || !/source files/.test(map.out)) fail("atticus map --estimate failed");

// The app: started, and one call to its local API answered. In the network namespace its own
// loopback is down until brought up; nothing outside the machine is reachable either way.
const uiCheck = join(work, "ui-check.mjs");
writeFileSync(
  uiCheck,
  `import { spawn } from "node:child_process";
import { request } from "node:http";
const [bin, root] = process.argv.slice(2);
const { NO_PROXY: _n, no_proxy: _m, ...env } = process.env;
const ui = spawn(bin, ["ui", "--port", "0", "--show-token", "--root", root], { env, shell: ${win} });
let text = "";
const t = setTimeout(() => { console.log("atticus ui didn't start: " + text); ui.kill(); process.exit(1); }, 60000);
ui.stdout.on("data", (b) => {
  text += b;
  const m = /running at (http:\\/\\/127\\.0\\.0\\.1:(\\d+))/.exec(text);
  const k = /session token is (\\S+)/.exec(text);
  if (!m || !k) return;
  clearTimeout(t);
  const req = request({ host: "127.0.0.1", port: Number(m[2]), path: "/api/health", headers: { "X-Atticus-Token": k[1] } }, (res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => {
      console.log(m[1] + "; GET /api/health: " + res.statusCode + " " + body.slice(0, 120));
      ui.kill();
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
  });
  req.on("error", (e) => { console.log("the app didn't answer: " + e.message); ui.kill(); process.exit(1); });
  req.end();
});
`,
);
const loUp = [
  "ip link set lo up 2>/dev/null || python3 -c 'import socket,fcntl,struct",
  "s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)",
  'f=struct.unpack("16sH14s",fcntl.ioctl(s,0x8913,struct.pack("16sH14s",b"lo",0,b"")))[1]',
  'fcntl.ioctl(s,0x8914,struct.pack("16sH14s",b"lo",f|1,b""))\' 2>/dev/null || true',
  'exec "$@"',
].join("\n");
const uiRun = blocked
  ? spawnSync("unshare", ["-rn", "sh", "-c", loUp, "sh", process.execPath, uiCheck, bin, root], {
      encoding: "utf8",
      env: netEnv,
      cwd: work,
    })
  : spawnSync(process.execPath, [uiCheck, bin, root], {
      encoding: "utf8",
      env: { ...netEnv, NO_PROXY: "127.0.0.1,localhost" },
      cwd: work,
    });
console.log(`$ atticus ui --port 0 --show-token\n${(uiRun.stdout ?? "").trim()}`);
if (uiRun.status !== 0) fail(`atticus ui didn't answer:\n${uiRun.stdout}${uiRun.stderr}`);

console.log(
  `npm install test passed: npm install -g ${MAIN} on ${process.platform}-${process.arch}, scripts off, ${installed.length} packages installed, nothing downloaded after install, searches by meaning (${want}).`,
);
if (!keep) rmSync(work, { recursive: true, force: true, maxRetries: 5 });
else console.log(`Kept: ${work}`);
