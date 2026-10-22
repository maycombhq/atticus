// The extension's checks inside a real VS Code (ADR 0098): a practice metarepo, a VS Code with its
// own profile and only this extension, and test-vscode/suite.ts run in it. Set VSCODE_PATH to the
// VS Code to use; by default the one installed for this user.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
const code = candidates.find((c) => existsSync(c));
if (!code) {
  console.error(
    `No VS Code found. Install it, or set VSCODE_PATH. Looked in:\n  ${candidates.join("\n  ")}`,
  );
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
try {
  console.log("Making a practice metarepo and scanning it...");
  atticus(["sandbox", "create", join(tmp, "sbx")], tmp);
  const meta = join(tmp, "sbx", "metarepo");
  atticus(["workspace", "sync", "--root", meta], meta);
  atticus(["scan", "--root", meta], meta);
  console.log("Building the tests...");
  const tsc = join(here, "..", "..", "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tsc, "-p", join(here, "tsconfig.test-vscode.json")], {
    stdio: "inherit",
  });
  const out = join(tmp, "results.json");
  console.log(`Starting ${code}...`);
  const env = { ...process.env, ATTICUS_VSCODE_TEST_OUT: out };
  delete env.ELECTRON_RUN_AS_NODE;
  const exit = await new Promise((done) => {
    const p = spawn(
      code,
      [
        meta,
        `--extensionDevelopmentPath=${here}`,
        `--extensionTestsPath=${join(here, "dist-test", "test-vscode", "suite.js")}`,
        `--user-data-dir=${join(tmp, "user")}`,
        `--extensions-dir=${join(tmp, "extensions")}`,
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-gpu",
        "--new-window",
      ],
      { env, stdio: "inherit" },
    );
    p.on("exit", (c) => done(c ?? 1));
  });
  if (existsSync(out))
    for (const r of JSON.parse(readFileSync(out, "utf8")))
      console.log(`${r.ok ? "ok  " : "FAIL"} ${r.check}${r.detail ? `: ${r.detail}` : ""}`);
  else console.log("The tests wrote no results.");
  process.exitCode = exit;
} finally {
  // VS Code may still hold files in its profile for a moment after it exits.
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch {
    console.log(`Couldn't remove ${tmp} yet; it is in the temp folder.`);
  }
}
