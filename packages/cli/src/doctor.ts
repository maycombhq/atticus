import { existsSync } from "node:fs";
import { access, constants, mkdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import { DEFAULT_PORT, loadOrgPack, orgPackDirOf, readLock } from "@maycombhq/core";
import { createOpenSpec, isSupportedVersion, OPENSPEC_PINNED } from "@maycombhq/openspec-adapter";
import { createGit, type GitRunner } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import { upgradeCheck } from "./upgrade.js";
import { versionAtLeast } from "./version.js";
export { versionAtLeast };

/**
 * `atticus doctor` (ADR 0049): what this machine needs for Atticus to work, each check with a
 * plain fix. It reads the machine and the metarepo only: no network call, no AI, and it never
 * prints a secret (it says whether a variable is set, never its value).
 */

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  /** What to do when the check isn't ok, in words a person can follow. */
  fix?: string;
}

export interface DoctorDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  git?: GitRunner;
  /** The OpenSpec CLI's version, or undefined when it can't run. */
  openspecVersion?: () => Promise<string | undefined>;
  /** Whether a TCP port on 127.0.0.1 is free. */
  portFree?: (port: number) => Promise<boolean>;
  /** Free bytes on the metarepo's disk. */
  freeBytes?: (dir: string) => Promise<number | undefined>;
  /** Whether a program is on PATH. */
  onPath?: (program: string) => boolean;
}

export const MIN_NODE = "22.13.0";
export const MIN_GIT = "2.30.0";
const GB = 1024 ** 3;

function defaultPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

async function defaultFreeBytes(dir: string): Promise<number | undefined> {
  try {
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return undefined;
  }
}

function defaultOnPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter);
  return (program: string) =>
    dirs.some(
      (d) =>
        d &&
        exts.some(
          (e) => existsSync(join(d, program + e.toLowerCase())) || existsSync(join(d, program + e)),
        ),
    );
}

/** A variable's name, whether set, never its value. */
const envName = (env: NodeJS.ProcessEnv, ...names: string[]) =>
  names.find((n) => env[n] !== undefined && env[n] !== "");

const PROGRAMS: Record<string, { programs: string[]; name: string }> = {
  copilot: {
    programs: ["code", "idea", "idea64"],
    name: "VS Code or IntelliJ (Copilot runs in them)",
  },
  "claude-code": { programs: ["claude"], name: "Claude Code (claude)" },
};
const EDITORS: Record<string, string[]> = {
  vscode: ["code"],
  intellij: ["idea", "idea64"],
};

export async function doctorChecks(root: string, deps: DoctorDeps = {}): Promise<DoctorCheck[]> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const git = deps.git ?? createGit({ timeoutMs: 15_000 });
  const onPath = deps.onPath ?? defaultOnPath(env, platform);
  const out: DoctorCheck[] = [];

  // ---- Node
  const node = deps.nodeVersion ?? process.versions.node;
  out.push({
    id: "node",
    label: "Node.js",
    status: versionAtLeast(node, MIN_NODE) ? "ok" : "fail",
    detail: `Node ${node} (needs ${MIN_NODE} or later)`,
    fix: `Install Node ${MIN_NODE} or later (the LTS 22 line), or use the offline bundle, which carries its own.`,
  });

  // ---- Git
  const gitConfig = async (key: string) => {
    try {
      return (await git(["config", "--get", key], root)).stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  };
  let gitVersion: string | undefined;
  try {
    gitVersion = /(\d+\.\d+(?:\.\d+)?)/.exec((await git(["--version"], root)).stdout)?.[1];
  } catch {
    gitVersion = undefined;
  }
  out.push({
    id: "git",
    label: "Git",
    status: gitVersion && versionAtLeast(gitVersion, MIN_GIT) ? "ok" : "fail",
    detail: gitVersion ? `git ${gitVersion} (needs ${MIN_GIT} or later)` : "git isn't on PATH",
    fix: `Install Git ${MIN_GIT} or later and make sure \`git\` runs from a terminal.`,
  });
  if (gitVersion) {
    const name = await gitConfig("user.name");
    const email = await gitConfig("user.email");
    out.push({
      id: "git-identity",
      label: "Git identity",
      status: name && email ? "ok" : "warn",
      detail:
        name && email ? "user.name and user.email are set" : "user.name or user.email isn't set",
      fix: 'Set them once: git config --global user.name "Your Name" and git config --global user.email you@example.com. Hand-offs and task runs commit as you.',
    });
    if (platform === "win32") {
      const long = await gitConfig("core.longpaths");
      out.push({
        id: "git-longpaths",
        label: "Long paths (Windows)",
        status: long === "true" ? "ok" : "warn",
        detail: long === "true" ? "core.longpaths is on" : "core.longpaths is off",
        fix: "Worktrees nest deep: run git config --global core.longpaths true.",
      });
    }
    const crlf = await gitConfig("core.autocrlf");
    out.push({
      id: "line-endings",
      label: "Line endings",
      status: "ok",
      detail: crlf
        ? `core.autocrlf is ${crlf}; Atticus reads files with LF line endings either way`
        : "core.autocrlf isn't set",
    });
  }

  // ---- OpenSpec
  const openspecVersion =
    deps.openspecVersion ??
    (async () => {
      try {
        return await createOpenSpec({ root }).version();
      } catch {
        return undefined;
      }
    });
  const osv = await openspecVersion();
  out.push({
    id: "openspec",
    label: "OpenSpec CLI",
    status: osv && isSupportedVersion(osv) ? "ok" : "fail",
    detail: osv
      ? `OpenSpec ${osv} (tested with ${OPENSPEC_PINNED})`
      : "the bundled OpenSpec CLI didn't run",
    fix: "Reinstall Atticus (it carries a pinned OpenSpec); with the offline bundle, run its install script again.",
  });

  // ---- Network: proxy and TLS, read from the environment only
  const proxy = envName(env, "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy");
  const noProxyName = envName(env, "NO_PROXY", "no_proxy");
  const noProxy = noProxyName ? env[noProxyName]! : "";
  const localBypassed = /(^|,)\s*(localhost|127\.0\.0\.1|\*)\s*(,|$)/.test(noProxy);
  out.push({
    id: "proxy",
    label: "Proxy",
    status: !proxy || localBypassed ? "ok" : "warn",
    detail: proxy
      ? `${proxy} is set${noProxyName ? `; ${noProxyName} ${localBypassed ? "includes" : "doesn't include"} localhost` : "; NO_PROXY isn't set"}`
      : "no proxy variable is set (direct connections)",
    fix: "Add localhost and 127.0.0.1 to NO_PROXY so tools that honour the proxy (git, npm, assistants) don't send the app's local calls through it.",
  });
  const caName = envName(env, "NODE_EXTRA_CA_CERTS");
  let ca: DoctorCheck;
  if (caName) {
    const file = env[caName]!;
    const text = await readFile(file, "utf8").catch(() => undefined);
    ca = {
      id: "tls",
      label: "TLS certificates",
      status: text && /-----BEGIN CERTIFICATE-----/.test(text) ? "ok" : "fail",
      detail: text
        ? /-----BEGIN CERTIFICATE-----/.test(text)
          ? "NODE_EXTRA_CA_CERTS points at a PEM file"
          : "NODE_EXTRA_CA_CERTS points at a file with no PEM certificate in it"
        : "NODE_EXTRA_CA_CERTS points at a file that can't be read",
      fix: "Point NODE_EXTRA_CA_CERTS at your organisation's root certificate in PEM form (ask the desktop or network team for it).",
    };
  } else
    ca = {
      id: "tls",
      label: "TLS certificates",
      status: proxy ? "warn" : "ok",
      detail: proxy
        ? "a proxy is set but NODE_EXTRA_CA_CERTS isn't"
        : "the system's certificates (no extra CA set)",
      fix: "If your proxy inspects TLS, set NODE_EXTRA_CA_CERTS to your organisation's root certificate (PEM), or Atticus's adapters and plugins can't reach your systems.",
    };
  out.push(ca);

  // ---- The metarepo and this machine
  let writable = true;
  try {
    const dir = join(root, ".atticus");
    await mkdir(dir, { recursive: true });
    const probe = join(dir, `.doctor-${process.pid}`);
    await writeFile(probe, "ok");
    await rm(probe);
    await access(root, constants.W_OK);
  } catch {
    writable = false;
  }
  out.push({
    id: "writable",
    label: "Metarepo is writable",
    status: writable ? "ok" : "fail",
    detail: writable ? root : `can't write in ${root}`,
    fix: "Clone the metarepo to a folder you own (not a synced or read-only share).",
  });
  const free = await (deps.freeBytes ?? defaultFreeBytes)(root);
  out.push({
    id: "disk",
    label: "Disk space",
    status:
      free === undefined ? "warn" : free >= 2 * GB ? "ok" : free >= 0.5 * GB ? "warn" : "fail",
    detail: free === undefined ? "couldn't read free space" : `${(free / GB).toFixed(1)} GB free`,
    fix: "Base clones and change worktrees need room: free at least 2 GB (about 50 MB per repo, more per worktree).",
  });
  const port = await (deps.portFree ?? defaultPortFree)(DEFAULT_PORT);
  out.push({
    id: "port",
    label: `Port ${DEFAULT_PORT}`,
    status: port ? "ok" : "warn",
    detail: port ? "free for atticus ui" : "in use (another atticus ui, or another program)",
    fix: `Stop the other program, or start the app on another port: atticus ui --port 4322.`,
  });

  const scan = await readLock(root, "scan");
  out.push({
    id: "last-scan",
    label: "Last scan",
    status: scan?.stale ? "warn" : "ok",
    detail: scan
      ? scan.stale
        ? `the scan started ${scan.startedAt} stopped before it finished`
        : `a scan is running (since ${scan.startedAt})`
      : "finished",
    fix: "Run atticus scan again: it brings the catalog up to date (every file it writes is whole).",
  });

  const up = await upgradeCheck(root);
  out.push({
    id: "upgrade",
    label: "Metarepo version",
    status: up.newer ? "fail" : up.pending.length ? "warn" : "ok",
    detail: up.newer
      ? `upgraded by Atticus ${up.stamp!.atticus}; this is ${up.atticus}`
      : up.pending.length
        ? `${up.pending.length} upgrade step${up.pending.length === 1 ? "" : "s"} to run`
        : up.stamp
          ? `up to date (last upgraded by Atticus ${up.stamp.atticus})`
          : "up to date",
    fix: up.newer
      ? `Install Atticus ${up.stamp!.atticus} or later before working in this metarepo.`
      : "Run atticus upgrade, then commit what it changed in a pull request.",
  });

  // ---- The org pack's choices, checked against this machine
  const op = await loadOrgPack(orgPackDirOf(root));
  out.push({
    id: "org-pack",
    label: "Org pack",
    status: op.problems.length ? "fail" : "ok",
    detail: op.problems.length
      ? `${op.problems.length} problem${op.problems.length === 1 ? "" : "s"}`
      : "valid",
    fix: "Run atticus orgpack validate and fix each problem it names.",
  });
  const rt = op.runtime;
  const assistants = rt.assistants.allowed.filter((a) => PROGRAMS[a]);
  const found = assistants.filter((a) => PROGRAMS[a]!.programs.some(onPath));
  out.push({
    id: "assistant",
    label: "AI assistant",
    status: rt.ai === "off" || !assistants.length || found.length ? "ok" : "warn",
    detail:
      rt.ai === "off"
        ? "AI is off here (runtime.yaml); no assistant needed"
        : assistants.length
          ? found.length
            ? `found: ${found.map((a) => PROGRAMS[a]!.name).join(", ")}`
            : `none of ${assistants.map((a) => PROGRAMS[a]!.name).join(", ")} is on PATH`
          : "runtime.yaml allows no assistant this check knows",
    fix: "Hand-off mode runs in your own assistant: install the one runtime.yaml allows, or ask your desktop team. Atticus works without one; AI steps wait for you.",
  });
  const editors = rt.editors.filter((e) => EDITORS[e]);
  const editorFound = editors.filter((e) => EDITORS[e]!.some(onPath));
  out.push({
    id: "editor",
    label: "Editor",
    status: !editors.length || editorFound.length ? "ok" : "warn",
    detail: editorFound.length
      ? `found: ${editorFound.join(", ")}`
      : editors.length
        ? `none of ${editors.join(", ")} is on PATH`
        : "no editor listed in runtime.yaml",
    fix: "Change worktrees open as VS Code or IntelliJ workspaces: install one, or add its command to PATH.",
  });
  // ADR 0116: the local embedding model for "similar in meaning", when runtime.yaml turns it on.
  {
    const { embeddingState, runtimeAvailable } = await import("@maycombhq/embed");
    const e = await embeddingState(root);
    const ort = e.setting === "off" ? undefined : await runtimeAvailable(root);
    out.push({
      id: "embeddings",
      label: "Embedding model",
      status: e.setting === "off" ? "ok" : e.problem || !ort ? "warn" : "ok",
      detail:
        e.setting === "off"
          ? "off (runtime.yaml retrieval.embeddings); the context engine searches by words and names"
          : e.problem
            ? e.problem
            : `${e.id} (${((e.bytes ?? 0) / 1024 / 1024).toFixed(0)} MB, ${e.licence}) in ${e.dir}; runtime: ${ort ?? "none found"}`,
      fix: "Install the offline bundle that carries the model, or point retrieval.embeddings.model at a model folder, then run atticus index embed. Until then the context engine searches by words and names only.",
    });
  }
  const live = Object.entries(rt.adapters).filter(
    ([, a]) => a && a.type !== "mock" && a.type !== "manual",
  );
  out.push({
    id: "adapters",
    label: "Outside systems",
    status: "ok",
    detail: live.length
      ? `${live.map(([k, a]) => `${k}: ${a!.type}`).join(", ")}; each falls back to steps a person does when it can't be reached`
      : "every outside system is manual or a mock: Atticus writes steps for a person",
  });
  return out;
}

/** atticus doctor [--json]: exit 0 when nothing fails (warnings allowed), else 1. */
export async function doctorCommand(
  root: string,
  o: { json?: boolean },
  io: Output,
  deps: DoctorDeps = {},
): Promise<number> {
  const checks = await doctorChecks(root, deps);
  const failed = checks.filter((c) => c.status === "fail");
  const warned = checks.filter((c) => c.status === "warn");
  if (o.json) io.out(JSON.stringify({ checks, ok: failed.length === 0 }, null, 2));
  else {
    const mark = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]" } as const;
    for (const c of checks) {
      io.out(`${mark[c.status]} ${c.label}: ${c.detail}`);
      if (c.status !== "ok" && c.fix) io.out(`       ${c.fix}`);
    }
    io.out(
      failed.length
        ? `${failed.length} to fix before Atticus can work here${warned.length ? `, ${warned.length} to look at` : ""}.`
        : warned.length
          ? `Ready, with ${warned.length} thing${warned.length === 1 ? "" : "s"} to look at.`
          : "Ready: this machine has what Atticus needs.",
    );
  }
  return failed.length ? 1 : 0;
}
