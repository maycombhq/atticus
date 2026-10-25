import { existsSync } from "node:fs";
import { access, constants, mkdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import {
  ASSISTANT_FORMATS,
  assistantTier,
  generateAssistantFiles,
  readProbes,
  tierLine,
} from "@maycombhq/assistant-files";
import {
  DEFAULT_PORT,
  factsDirOf,
  loadOpenSpecSettings,
  loadOrgPack,
  orgPackDirOf,
  readLock,
  retrievalOf,
} from "@maycombhq/core";
import { parse } from "yaml";
import {
  createOpenSpec,
  isSupportedVersion,
  OPENSPEC_PINNED,
  openspecHasStores,
  readStoreMarker,
  STORE_MARKER,
} from "@maycombhq/openspec-adapter";
import {
  baseClonePath,
  createGit,
  isInPlace,
  loadRepos,
  remoteDefaultBranch,
  type GitRunner,
} from "@maycombhq/workspace";
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
  /** Whether the OpenSpec CLI has stores (beta, ADR 0126). */
  openspecStores?: () => Promise<boolean>;
  /** Whether a TCP port on 127.0.0.1 is free. */
  portFree?: (port: number) => Promise<boolean>;
  /** Free bytes on the metarepo's disk. */
  freeBytes?: (dir: string) => Promise<number | undefined>;
  /** Whether a program is on PATH. */
  onPath?: (program: string) => boolean;
  /** The slash-command files that are missing, out of date or edited by hand (ADR 0119). */
  assistantFiles?: (root: string) => Promise<AssistantFilesState>;
  /** Load the optional embedding plugin (ADR 0124 addendum D-bundle); fails where it isn't installed. */
  embed?: () => Promise<typeof import("@maycombhq/embed")>;
}

export interface AssistantFilesState {
  missing: string[];
  stale: string[];
  edited: string[];
}

/** What `atticus assistant-files --check` would do, as lists; nothing is written. */
async function defaultAssistantFiles(root: string): Promise<AssistantFilesState> {
  const r = await generateAssistantFiles(root, { check: true });
  const of = (a: string) => r.results.filter((x) => x.action === a).map((x) => x.path);
  return { missing: of("created"), stale: of("updated"), edited: of("kept-edited") };
}

/** The commit a repo's facts were verified at (facts/<repo>.verify.yaml), if they were. */
async function factsCommit(root: string, repo: string): Promise<string | undefined> {
  const text = await readFile(join(factsDirOf(root), `${repo}.verify.yaml`), "utf8").catch(
    () => undefined,
  );
  if (!text) return undefined;
  try {
    const commit = (parse(text) as { commit?: unknown } | null)?.commit;
    return typeof commit === "string" && commit ? commit : undefined;
  } catch {
    return undefined;
  }
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

/** Each assistant's program on PATH, from the registry (ADR 0121); Copilot runs in an editor. */
const PROGRAMS: Record<string, { programs: string[]; name: string }> = Object.fromEntries(
  Object.entries(ASSISTANT_FORMATS).map(([id, f]) => [
    id,
    {
      programs: f.programs,
      name:
        id === "copilot"
          ? "VS Code or IntelliJ (Copilot runs in them)"
          : `${f.name} (${f.programs.join(" or ")})`,
    },
  ]),
);
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
  // The slow checks (a program to start, every migration's dry run) start now and are read in
  // their place below: the report's order stays the same, the waits overlap.
  const openspecVersion =
    deps.openspecVersion ??
    (async () => {
      try {
        return await createOpenSpec({ root }).version();
      } catch {
        return undefined;
      }
    });
  const openspecSoon = openspecVersion();
  const storesSoon = (deps.openspecStores ?? (() => openspecHasStores()))().catch(() => false);
  const upgradeSoon = upgradeCheck(root);
  // Read below; marked handled here so a check that throws first leaves no stray rejection.
  upgradeSoon.catch(() => undefined);

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
  const osv = await openspecSoon;
  out.push({
    id: "openspec",
    label: "OpenSpec CLI",
    status: osv && isSupportedVersion(osv) ? "ok" : "fail",
    detail: osv
      ? `OpenSpec ${osv} (tested with ${OPENSPEC_PINNED})`
      : "the bundled OpenSpec CLI didn't run",
    fix: "Reinstall Atticus (it carries a pinned OpenSpec); with the offline bundle, run its install script again.",
  });

  // ADR 0126: OpenSpec's stores are beta and optional. Atticus reads the stores the org pack
  // names itself; plain OpenSpec needs them to register this metarepo or use it as a reference.
  const hasStores = await storesSoon;
  const marker = await readStoreMarker(root);
  const { settings: osSettings, problem: osProblem } = await loadOpenSpecSettings(
    orgPackDirOf(root),
  );
  const uses = [
    marker.marker
      ? `this metarepo is the store ${marker.marker.id}`
      : !marker.missing
        ? `this metarepo has a ${STORE_MARKER} that can't be read`
        : "",
    osSettings.stores.length
      ? `org-pack/openspec.yaml names ${osSettings.stores.length} store${osSettings.stores.length === 1 ? "" : "s"} to read`
      : "",
    osSettings.referenceInRepos ? "hand-down adds it to code repos' references" : "",
  ].filter(Boolean);
  out.push({
    id: "openspec-stores",
    label: "OpenSpec stores (beta)",
    status: osProblem || (!hasStores && uses.length) ? "warn" : "ok",
    detail: osProblem
      ? `org-pack/${osProblem}`
      : hasStores
        ? `${osv ? `OpenSpec ${osv}` : "OpenSpec"} has stores; ${uses.length ? uses.join("; ") : "this metarepo isn't one (optional: atticus upgrade --openspec-store)"}`
        : uses.length
          ? `the installed OpenSpec has no stores, but ${uses.join("; ")}`
          : "the installed OpenSpec has no stores; nothing here uses them",
    fix: osProblem
      ? "Fix org-pack/openspec.yaml (ADR 0126); until then Atticus reads no store and hand-down adds no reference."
      : "Plain OpenSpec can't register this metarepo or read it as a reference until it has stores; Atticus still reads the stores org-pack/openspec.yaml names. Install an Atticus whose pinned OpenSpec has stores (1.14.0 does).",
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

  // ADR 0124: Atticus 2 reads a repo with the assistant (/atticus-map) and writes its facts into
  // the catalog with atticus verify --write (under the scan's lock), so this says what is read.
  const manifest = await loadRepos(root).catch(() => []);
  const lock = await readLock(root, "scan");
  const read: string[] = [];
  const unverified: string[] = [];
  const unread: string[] = [];
  for (const r of manifest.filter((x) => !x.archived).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const commit = await factsCommit(root, r.id);
    if (commit) read.push(`${r.id} at ${commit.slice(0, 12)}`);
    else if (existsSync(join(factsDirOf(root), `${r.id}.jsonl`)))
      unverified.push(`${r.id} read, not verified yet`);
    else unread.push(r.id);
  }
  const facts = [
    ...read,
    ...unverified,
    ...(unread.length ? [`not read yet: ${unread.join(", ")}`] : []),
  ];
  out.push({
    id: "facts-read",
    label: "Facts read",
    status: lock?.stale ? "warn" : "ok",
    detail: [
      lock
        ? lock.stale
          ? `the write started ${lock.startedAt} stopped before it finished`
          : `a write is running (since ${lock.startedAt})`
        : "",
      facts.length ? facts.join("; ") : "no repo is listed yet",
    ]
      .filter(Boolean)
      .join("; "),
    fix: lock?.stale
      ? "Run atticus verify <repo> --write again: every file it writes is whole."
      : "Read a repo with /atticus-map <repo> in your assistant (or atticus map <repo>), then atticus verify <repo> --write.",
  });

  // ADR 0123: the branch each repo is read from, against the one its remote calls its default
  // (as the base clone last heard it at a sync: no network here).
  const differ: string[] = [];
  for (const r of manifest.filter((x) => !x.archived && !isInPlace(x.url))) {
    const remote = await remoteDefaultBranch(baseClonePath(root, r.id), git);
    if (remote && remote !== r.defaultBranch)
      differ.push(`${r.id} (manifest ${r.defaultBranch}, remote ${remote})`);
  }
  if (manifest.length)
    out.push({
      id: "default-branches",
      label: "Default branches",
      status: differ.length ? "warn" : "ok",
      detail: differ.length
        ? `read from another branch than the remote's default: ${differ.join(", ")}`
        : "each repo is read from the branch its manifest names",
      fix: "If the remote's default is the one to read, set defaultBranch in the manifest (or on Set up › Repos), then run atticus workspace sync.",
    });

  const up = await upgradeSoon;
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
  // ---- The tier the assistant reads a repo at (ADR 0124 §4): measured by atticus probe on this
  // machine (addendum A-probe), else from runtime.yaml and the registry.
  const probes = await readProbes(root);
  const tier = assistantTier(rt, { probes: probes.results });
  const stale = tier.measured?.stale === true;
  out.push({
    id: "tier",
    label: "First read of a repo",
    status: stale || probes.problems.length ? "warn" : "ok",
    detail: [tierLine(tier), ...probes.problems.map((p) => `${p}; left out.`)].join(" "),
    fix: "Run atticus probe and follow what it prints in your assistant: it measures the tier again.",
  });
  // ---- How AI steps run here, and whether model mode can (ADR 0119). Names only, no call:
  // doctor makes no network call, so a provider is checked for being named and keyed, not reached.
  const model = rt.adapters.model;
  const keyEnv =
    model && typeof model.settings.keyEnv === "string" ? model.settings.keyEnv : undefined;
  const modelMode = rt.modes.allowed.includes("model");
  const named = !!model && model.type !== "mock";
  out.push({
    id: "model",
    label: "How AI steps run",
    status:
      rt.ai === "off" || !modelMode || (named && (!keyEnv || envName(env, keyEnv))) ? "ok" : "warn",
    detail:
      rt.ai === "off"
        ? "AI is off here (runtime.yaml)"
        : !modelMode
          ? rt.modes.allowed.includes("headless-claude-code")
            ? "AI steps hand off to your assistant, or run in headless Claude Code (--mode headless-claude-code); runtime.yaml doesn't allow Atticus to call a model's API itself"
            : "AI steps hand off to your assistant; runtime.yaml doesn't allow Atticus to call a model itself"
          : !named
            ? "model mode is allowed, but runtime.yaml names no model provider"
            : keyEnv && !envName(env, keyEnv)
              ? `model mode with ${model.type}, but ${keyEnv} isn't set on this machine`
              : `model mode with ${model.type}${typeof model.settings.model === "string" ? ` (${model.settings.model})` : ""}${keyEnv ? `; ${keyEnv} is set` : ""}. Not called here: doctor makes no network call`,
    fix: !named
      ? "Name the provider under adapters.model in runtime.yaml (docs/guide/admin.md, Calling a model directly), or leave model mode out of modes.allowed."
      : `Set the environment variable ${keyEnv ?? "the provider's key variable"} to the key on this machine (never in runtime.yaml), then open a new terminal.`,
  });

  // ---- The slash commands the assistant runs: there and current (ADR 0119)
  if (rt.ai !== "off") {
    let files: AssistantFilesState | undefined;
    let problem: string | undefined;
    try {
      files = await (deps.assistantFiles ?? defaultAssistantFiles)(root);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
    const parts = files
      ? [
          files.missing.length ? `${files.missing.length} missing` : "",
          files.stale.length ? `${files.stale.length} out of date` : "",
          files.edited.length ? `${files.edited.length} edited by hand (kept)` : "",
        ].filter(Boolean)
      : [];
    out.push({
      id: "assistant-files",
      label: "Slash commands",
      status: problem || files!.missing.length || files!.stale.length ? "warn" : "ok",
      detail: problem
        ? `couldn't check them: ${problem}`
        : parts.length
          ? `${parts.join(", ")}: the /atticus-* commands your assistant runs`
          : "the /atticus-* commands your assistant runs are there and current",
      fix: "Run atticus assistant-files, then commit what it wrote in a pull request; a file edited by hand is kept unless you add --force.",
    });
  }

  // ADR 0116 and its addendum: the local embedding model for "similar in meaning", the one installed
  // with Atticus by default. Where it or onnxruntime isn't installed, the context engine searches by
  // words and names, never fails a step and downloads nothing; this says so. A default that
  // isn't installed is a note; a model runtime.yaml names that can't be used is a warning.
  // ADR 0124 addendum D-bundle: the model and its runtime are an optional plugin the offline
  // bundle leaves out, so @maycombhq/embed itself may be missing; that is a note, not a failure.
  const lexical = "the context engine searches by words and names only";
  const embed = await (deps.embed ?? (() => import("@maycombhq/embed")))().catch((e: Error) => e);
  if (embed instanceof Error) {
    const model = retrievalOf(rt).embeddings.model;
    const off = process.env.ATTICUS_EMBEDDINGS === "off" || model === "off";
    // Not installed, or installed and broken (said with its message, as a warning).
    const missing = (embed as { code?: string }).code === "ERR_MODULE_NOT_FOUND";
    out.push({
      id: "embeddings",
      label: "Embedding model",
      status: off || (missing && model === "bundled") ? "ok" : "warn",
      detail: off
        ? `off (${process.env.ATTICUS_EMBEDDINGS === "off" ? "ATTICUS_EMBEDDINGS is off for this process" : "retrieval.embeddings.model is off"}); ${lexical}`
        : !missing
          ? `@maycombhq/embed couldn't be loaded (${embed.message.split("\n")[0]}), so ${lexical}`
          : model === "bundled"
            ? `not installed (@maycombhq/embed, an optional plugin), so ${lexical} (BM25 and the graph walk)`
            : `runtime.yaml names the model ${model}, but @maycombhq/embed, the optional plugin that runs it, isn't installed, so ${lexical}`,
      fix: "Search by meaning is an optional plugin. Add it to this install with the plugin zip (atticus-<version>-embeddings-plugin.zip, built with pnpm bundle --embeddings-plugin): run its install script, then node embeddings-plugin/fetch-model.mjs for the model. Or install Atticus from the bundle built with pnpm bundle --with-embeddings, or from your npm mirror without --omit=optional (it brings @maycombhq/embed, @maycombhq/embed-model and onnxruntime as optional dependencies). Set retrieval.embeddings.model to off to say the organisation doesn't use one. Atticus itself never downloads anything.",
    });
  } else {
    const { embeddingState, runtimeAvailable } = embed;
    const e = await embeddingState(root);
    const ort = e.setting === "off" ? undefined : await runtimeAvailable(root);
    out.push({
      id: "embeddings",
      label: "Embedding model",
      status:
        e.setting === "off"
          ? "ok"
          : e.problem
            ? e.configured
              ? "warn"
              : "ok"
            : ort
              ? "ok"
              : "warn",
      detail:
        e.setting === "off"
          ? `off (${e.problem ?? "runtime.yaml retrieval.embeddings"}); ${lexical}`
          : e.problem
            ? `${e.problem}, so ${lexical}`
            : `${e.id} (${((e.bytes ?? 0) / 1024 / 1024).toFixed(0)} MB, ${e.licence}) in ${e.dir}; runtime: ${ort ?? `none found, so ${lexical}`}`,
      fix: "The model is an optional plugin (@maycombhq/embed-model and its onnxruntime packages, optional dependencies of @maycombhq/cli on npm). Where the plugin zip added them, run node embeddings-plugin/fetch-model.mjs in the Atticus folder (--list names the files, --from <folder> takes them from your mirror). Otherwise reinstall Atticus from your npm mirror or from the offline bundle built with pnpm bundle --with-embeddings; in a checkout of Atticus run pnpm model:fetch; or point retrieval.embeddings.model at a model folder. Set it to off to say the organisation doesn't use one. Atticus itself never downloads anything.",
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
