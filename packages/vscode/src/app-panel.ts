import { spawn, type ChildProcess } from "node:child_process";
import { commandText, resolveCommand, SHELL_UNSAFE, type CliOptions } from "./cli";
import { WORDS } from "./words";

/**
 * The Atticus app in a VS Code tab (ADR 0091). The extension starts `atticus ui --embed vscode`
 * on a free port, reads its address, and frames the app in a webview panel. The app is the one
 * the browser shows: the same diagrams, screens and commands, one codebase. Nothing here imports
 * `vscode`, so it is tested outside the editor; extension.ts makes the panel.
 */

/** The same slug the estate gives a repo's node (diagrams' hierarchy). */
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 120) || "x";

/**
 * The app link for `@atticus /diagram <repo> [flow]`:
 * - `<repo>` opens the repo on the Architecture canvas (a node id, system:payments, as it is);
 * - `<repo> flows` opens the repo's flows;
 * - `<repo> <flow id>` opens that flow, and `<repo> <words>` the flows that match them;
 * - nothing named opens the estate.
 */
export function diagramHash(target: string): string {
  const [first, ...rest] = target.trim().split(/\s+/).filter(Boolean);
  if (!first) return "#/architecture";
  if (!rest.length) {
    const id = first.includes(":") ? first : `repo:${slug(first)}`;
    return `#/architecture?node=${encodeURIComponent(id)}`;
  }
  const repo = `#/flows?repo=${encodeURIComponent(slug(first))}`;
  const words = rest.join(" ");
  if (words.toLowerCase() === "flows") return repo;
  if (rest.length === 1 && rest[0]!.includes("."))
    return `${repo}&flow=${encodeURIComponent(rest[0]!)}`;
  return `${repo}&q=${encodeURIComponent(words)}`;
}

/** The address `atticus ui` prints when it serves. */
export function appUrlFrom(stdout: string): string | undefined {
  return /Atticus is running at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1];
}

/** The session token `atticus ui` prints, for the sidebar's calls to the API (ADR 0093). */
export function appTokenFrom(stdout: string): string | undefined {
  return /the session token is (\S+)/.exec(stdout)?.[1];
}

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The panel's page: the app in a frame, from 127.0.0.1 only. The page runs no script. */
export function panelHtml(src: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:*; style-src 'unsafe-inline'" />
<style>html, body, iframe { margin: 0; padding: 0; border: 0; width: 100%; height: 100%; overflow: hidden; }</style>
</head>
<body>
<iframe src="${attr(src)}" title="Atticus" allow="clipboard-write"></iframe>
</body>
</html>
`;
}

export interface RunningApp {
  /** http://127.0.0.1:<port>, no trailing slash. */
  url: string;
  /** The session token, for the API. */
  token: string;
  stop(): void;
  onExit(f: (code: number | null) => void): void;
}

/**
 * Stop the app: close its stdin, which `atticus ui --embed vscode` takes as the sign to stop
 * (and which closes by itself when the extension host dies), and kill it, at once by default,
 * since an older atticus doesn't watch stdin and the window may be closing. On Windows it may run
 * under cmd.exe, so the kill takes the process tree: killing the shell alone leaves the server.
 */
export function stopChild(child: ChildProcess, graceMs = 0): void {
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  if (gone()) return;
  child.stdin?.end();
  const kill = () => {
    if (gone()) return;
    if (process.platform === "win32" && child.pid !== undefined) {
      const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      k.on("error", () => child.kill());
    } else child.kill();
  };
  if (graceMs <= 0) return kill();
  const t = setTimeout(kill, graceMs);
  child.once("close", () => clearTimeout(t));
}

/** Start `atticus ui --port 0 --embed vscode`; resolves once it prints its address. */
export function startApp(o: CliOptions): Promise<RunningApp> {
  const log = o.log ?? (() => undefined);
  const args = ["ui", "--port", "0", "--embed", "vscode", "--root", o.cwd];
  const cmd = resolveCommand(o);
  log(`> ${commandText(args)}`);
  if (cmd.shell && args.some((a) => SHELL_UNSAFE.test(a)))
    return Promise.reject(
      new Error(
        `Couldn't run atticus ui through the Windows shell safely: the folder's path has one of " % ^ & | < > !. Set atticus.path to the atticus bin.js.`,
      ),
    );
  const argv = [...cmd.prefix, ...args].map((a) => (cmd.shell ? `"${a}"` : a));
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd.shell ? `"${cmd.file}"` : cmd.file, argv, {
        cwd: o.cwd,
        env: o.env ?? process.env,
        shell: cmd.shell,
        windowsHide: true,
      });
    } catch (e) {
      reject(new Error(`Couldn't start atticus (${cmd.file}): ${(e as Error).message}`));
      return;
    }
    let out = "";
    let err = "";
    let url: string | undefined;
    const exits: ((code: number | null) => void)[] = [];
    child.stdout?.setEncoding("utf8").on("data", (d: string) => {
      for (const l of d.split("\n").filter((x) => x.trim())) log(l.trimEnd());
      if (url) return;
      out += d;
      const at = appUrlFrom(out);
      const token = appTokenFrom(out);
      // Both lines are printed one after the other; wait for the token too.
      if (at && token) {
        url = at;
        resolve({
          url,
          token,
          stop: () => stopChild(child),
          onExit: (f) => exits.push(f),
        });
      }
    });
    child.stderr?.setEncoding("utf8").on("data", (d: string) => {
      err += d;
      for (const l of d.split("\n").filter((x) => x.trim())) log(l.trimEnd());
    });
    child.on("error", (e) => {
      if (!url) reject(new Error(`Couldn't start atticus (${cmd.file}): ${e.message}`));
    });
    child.on("close", (code) => {
      log(`exit ${code ?? "(stopped)"}`);
      if (!url)
        reject(
          new Error(
            err.trim() ||
              out.trim() ||
              `The app stopped before it started. ${WORDS.endedWith(code)}`,
          ),
        );
      for (const f of exits) f(code);
    });
  });
}
