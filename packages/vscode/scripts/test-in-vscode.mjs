// The extension's checks inside a real VS Code (ADR 0098): a practice metarepo, a VS Code with its
// own profile and only this extension, and test-vscode/suite.ts run in it, twice: on the metarepo
// and in a window with no folder. With --vsix <file>, the packaged extension is installed and run
// instead of the source folder. Set VSCODE_PATH to the VS Code to use; by default the one
// installed for this user, else VS Code stable downloaded by @vscode/test-electron.
import { execFileSync, spawn } from "node:child_process";
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
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.env.VSCODE_PATH,
  process.env.LOCALAPPDATA &&
    join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"),
  "C:\\Program Files\\Microsoft VS Code\\Code.exe",
  "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
  "/usr/share/code/code",
].filter(Boolean);
// None installed: VS Code's own test download (stable), kept in the repo's .cache/vscode-test,
// which git, ESLint and Prettier leave alone (inside the package, its files broke `pnpm lint`).
let code = candidates.find((c) => existsSync(c));
if (!code) {
  console.log(`No VS Code installed (looked in ${candidates.join(", ")}); downloading stable...`);
  const { downloadAndUnzipVSCode } = await import("@vscode/test-electron");
  code = await downloadAndUnzipVSCode({
    version: process.env.VSCODE_VERSION ?? "stable",
    cachePath: join(here, "..", "..", ".cache", "vscode-test"),
  });
}
// --vsix <file>: install the packaged extension and test that, not the source folder (a file
// missing from the package fails here, not on a person's machine).
// --vsix alone: the newest .vsix `pnpm package` wrote here.
const vsixAt = process.argv.indexOf("--vsix");
const vsix =
  vsixAt < 0
    ? undefined
    : (process.argv[vsixAt + 1] ??
      readdirSync(here)
        .filter((f) => f.endsWith(".vsix"))
        .map((f) => join(here, f))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]);
if (vsixAt >= 0 && !vsix) {
  console.error("No .vsix here: run pnpm --filter atticus package first.");
  process.exit(1);
}
const win = process.platform === "win32";
const atticus = (args, cwd) =>
  execFileSync(win ? "atticus.cmd" : "atticus", args, {
    cwd,
    stdio: "pipe",
    shell: win,
    encoding: "utf8",
  });

const tmp = mkdtempSync(join(tmpdir(), "atticus-vscode-test-"));
const profile = [
  `--user-data-dir=${join(tmp, "user")}`,
  `--extensions-dir=${join(tmp, "extensions")}`,
];
/** A line of Chromium's console that says the policy, or a file not there, stopped a page. */
const PAGE_PROBLEM =
  /Refused to (load|execute|apply|connect|create|frame)|Content.Security.Policy|Failed to load resource|net::ERR_|Uncaught /;

/**
 * One VS Code on `folder` (none: an empty window), the suite in `mode`. Its results, and, where
 * the app opens, a check of what the pages logged (Chromium's console, from --enable-logging).
 */
async function launch(folder, mode, devPath) {
  const out = join(tmp, `results-${mode}.json`);
  console.log(`Starting ${code} (${mode})...`);
  const env = { ...process.env, ATTICUS_VSCODE_TEST_OUT: out, ATTICUS_VSCODE_TEST_MODE: mode };
  delete env.ELECTRON_RUN_AS_NODE;
  const logged = [];
  const exit = await new Promise((done) => {
    const p = spawn(
      code,
      [
        ...(folder ? [folder] : []),
        `--extensionDevelopmentPath=${devPath}`,
        `--extensionTestsPath=${join(here, "dist-test", "test-vscode", "suite.js")}`,
        ...profile,
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-gpu",
        "--new-window",
        "--enable-logging=stderr",
        // Electron refuses to start as root (a container or CI runner) with its sandbox on.
        ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      ],
      { env, stdio: ["ignore", "inherit", "pipe"] },
    );
    let rest = "";
    p.stderr.on("data", (b) => {
      process.stderr.write(b);
      const lines = (rest + b.toString()).split("\n");
      rest = lines.pop() ?? "";
      for (const l of lines)
        if (/CONSOLE|Refused to/.test(l) && /webview|vscode-cdn|vscode-resource/i.test(l))
          if (PAGE_PROBLEM.test(l)) logged.push(l.trim());
    });
    p.on("exit", (c) => done(c ?? 1));
  });
  const results = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : [];
  if (!results.length) results.push({ check: `${mode}: the tests wrote no results`, ok: false });
  // A window that died (the renderer killed, out of memory) ends before its last checks.
  if (exit !== 0 && results.every((r) => r.ok))
    results.push({
      check: `${mode}: VS Code ended with code ${exit} before the checks finished`,
      ok: false,
    });
  if (mode !== "no-folder")
    results.push({
      check: `${mode}: the app's page logged nothing its policy or a missing file stopped`,
      ok: logged.length === 0,
      ...(logged.length ? { detail: logged.slice(0, 8).join("\n  ") } : {}),
    });
  return { exit, results };
}

try {
  console.log("Making a practice metarepo and scanning it...");
  atticus(["sandbox", "create", join(tmp, "sbx")], tmp);
  const meta = join(tmp, "sbx", "metarepo");
  atticus(["workspace", "sync", "--root", meta], meta);
  atticus(["scan", "--root", meta], meta);
  // Facts an assistant would write for forge-ledger (test-vscode/fixtures), read at the clone's
  // commit (the sandbox makes a new one each time) and put in the catalog: the lines they cite
  // get CodeLenses, and Verify a repo's facts has something to check.
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: join(meta, "workspace", "forge-ledger"),
    encoding: "utf8",
  }).trim();
  mkdirSync(join(meta, "facts"), { recursive: true });
  writeFileSync(
    join(meta, "facts", "forge-ledger.jsonl"),
    readFileSync(join(here, "test-vscode", "fixtures", "forge-ledger.jsonl"), "utf8").replaceAll(
      '"commit":"HEAD"',
      `"commit":"${head}"`,
    ),
  );
  atticus(["verify", "forge-ledger", "--write", "--root", meta], meta);
  console.log("Building the tests...");
  const tsc = join(here, "..", "..", "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tsc, "-p", join(here, "tsconfig.test-vscode.json")], {
    stdio: "inherit",
  });
  const runs = [];
  if (vsix) {
    const { resolveCliArgsFromVSCodeExecutablePath } = await import("@vscode/test-electron");
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(code);
    console.log(`Installing ${vsix}...`);
    execFileSync(cli, [...cliArgs, ...profile, "--install-extension", resolve(vsix), "--force"], {
      stdio: "inherit",
    });
    // The test host needs an extension development path: an empty one, so the extension that
    // runs is the one installed from the package.
    const none = join(tmp, "no-extension");
    mkdirSync(none);
    writeFileSync(
      join(none, "package.json"),
      JSON.stringify({
        name: "none",
        publisher: "none",
        version: "0.0.0",
        engines: { vscode: "*" },
      }),
    );
    runs.push(await launch(meta, "packaged", none));
  } else {
    // ATTICUS_VSCODE_TEST_ONLY=metarepo (or no-folder) runs that one alone.
    const only = process.env.ATTICUS_VSCODE_TEST_ONLY;
    if (!only || only === "metarepo") runs.push(await launch(meta, "metarepo", here));
    if (!only || only === "no-folder") runs.push(await launch(undefined, "no-folder", here));
  }
  const all = runs.flatMap((x) => x.results);
  for (const r of all)
    console.log(`${r.ok ? "ok  " : "FAIL"} ${r.check}${r.detail ? `: ${r.detail}` : ""}`);
  const failed = all.filter((r) => !r.ok).length;
  console.log(
    failed ? `${failed} of ${all.length} checks failed.` : `All ${all.length} checks passed.`,
  );
  process.exitCode = failed || runs.some((x) => x.exit) ? 1 : 0;
} finally {
  // VS Code may still hold files in its profile for a moment after it exits.
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch {
    console.log(`Couldn't remove ${tmp} yet; it is in the temp folder.`);
  }
}
