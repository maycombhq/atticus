import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  changesDirOf,
  changesRelOf,
  loadOrgPack,
  runsDirOf,
  runsRelOf,
  RuntimeKind,
  stateDirOf,
  type ModelProviderPlugin,
  type OrgPack,
  type Recording,
  orgPackDirOf,
} from "@maycombhq/core";
import { DATA_RULE, estimateTokens } from "./context.js";
import { HandoffRuntime, type HandoffOptions } from "./handoff.js";
import {
  OneShotRuntime,
  RuntimeError,
  type AiRequest,
  type AiRuntime,
  type Run,
} from "./runtime.js";
import {
  MockModelProvider,
  MockRuntime,
  ModelRuntime,
  ReplayRuntime,
  type MockChatScript,
  type ModelProvider,
  type ToolSource,
} from "./runtimes.js";

/**
 * The runtime factory (contract C5, ADR 0014): one place that turns `runtime.yaml` (C6
 * `modes`, `models`, `adapters.model`, `assistants`) into an AI runtime, so every command that
 * runs an AI step gets the same answer to "how does AI run here?".
 *
 * - `hand-off` (the default): the person's own assistant does the step.
 * - `model`: a direct call through a model-provider adapter. Provider adapters are plugins,
 *   passed in or registered with `registerModelProvider`; this package ships none. The CLI
 *   registers the built-in ones from `@maycombhq/model-providers` (anthropic,
 *   openai-compatible, azure-openai, bedrock; ADR 0065). With none for the configured type the
 *   factory says so plainly. `mock` is the test provider.
 * - `headless-claude-code`: `claude -p` in a worktree with a prompt file, behind a runner
 *   interface so tests use a fake and never start the real CLI.
 * - `replay` and `mock`: for tests and CI. They send nothing anywhere, so runtime.yaml doesn't
 *   have to allow them.
 */

export type RuntimeMode = RuntimeKind;
export const RUNTIME_MODES = RuntimeKind.options;
/** The modes runtime.yaml decides; replay and mock never leave the machine. */
const CONFIGURED: readonly RuntimeMode[] = ["hand-off", "model", "headless-claude-code"];

export class RuntimeConfigError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

/** AI is off in this organisation (runtime.yaml ai: off, ADR 0046): no AI step may start. */
export class AiOffError extends RuntimeConfigError {
  constructor() {
    super(
      "AI is off here (org-pack/runtime.yaml ai: off), so Atticus starts no AI step. Write the artifact yourself; the critic's rule checks still review it, and every gate works without AI.",
    );
  }
}

// ------------------------------------------------------------------ headless Claude Code

export interface HeadlessInvocation {
  /** The worktree Claude Code runs in. */
  cwd: string;
  /** The prompt, also written to `promptFile` for the audit trail; the runner sends it on stdin. */
  prompt: string;
  promptFile: string;
  /** Arguments after the command, e.g. ["-p", "--output-format", "json", ...]. */
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface HeadlessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Runs Claude Code. Injectable: tests pass a fake, so the real CLI never runs in CI. */
export type HeadlessRunner = (i: HeadlessInvocation) => Promise<HeadlessResult>;

/**
 * The real runner: `claude` on PATH, no shell, the prompt on stdin. Never used in tests.
 * It inherits the person's environment for the CLI's own credentials; Atticus adds only the
 * variables the invocation names.
 */
export function claudeCodeCliRunner(o: { command?: string } = {}): HeadlessRunner {
  return (i) =>
    collectChild(
      () =>
        spawn(o.command ?? "claude", i.args, {
          cwd: i.cwd,
          env: { ...process.env, ...i.env },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          ...(i.signal ? { signal: i.signal } : {}),
        }),
      i.prompt,
      i.timeoutMs,
      i.cwd,
    );
}

/** What collectChild needs of a child process: its three streams, kill, and its events. */
export interface ChildLike {
  stdin: NodeJS.EventEmitter & { end(text: string, encoding: BufferEncoding): unknown };
  stdout: NodeJS.EventEmitter & { setEncoding(e: BufferEncoding): NodeJS.EventEmitter };
  stderr: NodeJS.EventEmitter & { setEncoding(e: BufferEncoding): NodeJS.EventEmitter };
  kill(signal?: NodeJS.Signals): unknown;
  on(event: string, fn: (...a: never[]) => void): unknown;
}

/**
 * Run a child to its end: the prompt on stdin, what it prints collected, settled once. An error
 * on the process or on any of its streams (a pipe Windows closes, ENOTCONN) fails the run with
 * the reason, instead of an unhandled error that stops the command line.
 */
export function collectChild(
  start: () => ChildLike,
  prompt: string,
  timeoutMs: number,
  cwd?: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let done = false;
    // Set once the child runs; a failure before that has no timer to clear.
    const timer: { id?: ReturnType<typeof setTimeout> } = {};
    const fail = (e: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer.id);
      const code = (e as NodeJS.ErrnoException).code;
      // Windows says ENOENT too when the folder to start in has a path over 260 characters.
      const tooLong = platform === "win32" && cwd !== undefined && cwd.length >= 248;
      reject(
        new RuntimeError(
          code === "ENOENT" && tooLong
            ? `Claude Code couldn't start in ${cwd}: its path is ${cwd.length} characters, more than Windows lets a program start in. Move the metarepo to a shorter path, or turn on long paths.`
            : code === "ENOENT"
              ? "Claude Code (claude) is not on PATH; install it or use hand-off mode"
              : `Claude Code couldn't be run: ${(e as Error).message}`,
        ),
      );
    };
    let child: ChildLike;
    try {
      child = start();
    } catch (e) {
      fail(e);
      return;
    }
    let stdout = "";
    let stderr = "";
    timer.id = setTimeout(() => child.kill("SIGINT"), timeoutMs);
    for (const s of [child.stdin, child.stdout, child.stderr]) s.on("error", fail);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", fail);
    child.on("close", (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer.id);
      resolve({ exitCode: code, stdout, stderr });
    });
    child.stdin.end(prompt, "utf8");
  });
}

export type PermissionMode = "acceptEdits" | "plan" | "dontAsk";

/** Where the repos' clones may be: workspace/ in the metarepo, or in its state folder. */
const cloneDirs = (root: string) => [join(root, "workspace"), join(stateDirOf(root), "workspace")];

async function existingDirs(dirs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const d of [...new Set(dirs)])
    if ((await stat(d).catch(() => undefined))?.isDirectory()) out.push(d);
  return out;
}

/**
 * A path as Claude Code's permission rules match it: forward slashes, and a Windows drive as
 * /c/... (a rule writes an absolute path with a leading //).
 */
export const posixPath = (p: string) =>
  p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);

export interface HeadlessOptions {
  /** The metarepo root; prompt files go to .runs/<change>/<runId>/prompt.md. */
  root: string;
  runner?: HeadlessRunner;
  /** Where and how each request runs: the task's worktree and what Claude Code may do there. */
  invocation?: (request: AiRequest) => {
    cwd: string;
    permissionMode?: PermissionMode;
    env?: Record<string, string>;
    allowedTools?: string[];
  };
  model?: string;
  timeoutMs?: number;
  now?: () => Date;
  validate?: (output: string, request: AiRequest) => Promise<string[]>;
}

/**
 * Headless Claude Code (C5): writes the prompt file, runs `claude -p` in the worktree with
 * JSON output and no permission prompts, and reads the result. The data rule is appended to
 * the system prompt. Edits happen in the worktree; the output is Claude Code's final answer.
 */
export class HeadlessClaudeCodeRuntime extends OneShotRuntime {
  readonly kind: RuntimeKind = "headless-claude-code";
  private readonly runner: HeadlessRunner;

  constructor(private readonly h: HeadlessOptions) {
    super({ ...(h.now ? { now: h.now } : {}), ...(h.validate ? { validate: h.validate } : {}) });
    this.runner = h.runner ?? claudeCodeCliRunner();
  }

  /** The command-line arguments for one request (exported for the audit trail and tests). */
  static args(o: {
    permissionMode: PermissionMode;
    model?: string;
    allowedTools?: string[];
    /** Folders it may read beyond its own (a reviewer: the repos' clones). */
    addDirs?: string[];
    /** Permission rules it is refused (a reviewer: any edit under those folders). */
    disallowedTools?: string[];
  }) {
    return [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      o.permissionMode,
      "--permission-prompts",
      "none",
      "--append-system-prompt",
      DATA_RULE,
      ...(o.model ? ["--model", o.model] : []),
      ...(o.allowedTools?.length ? ["--allowedTools", o.allowedTools.join(",")] : []),
      ...(o.addDirs ?? []).flatMap((d) => ["--add-dir", d]),
      ...(o.disallowedTools?.length ? ["--disallowedTools", o.disallowedTools.join(",")] : []),
    ];
  }

  protected async produce(run: Run, signal?: AbortSignal) {
    const { request } = run;
    const dir = join(runsDirOf(this.h.root), request.change, run.runId);
    // A reviewer (its output is findings, kept in its run) reads the draft and writes only its
    // findings: it runs in an empty folder of its own, so an edit anywhere else needs a
    // permission that `--permission-prompts none` never gives. Whatever the step's own
    // invocation says. The folder is under the system's temp folder: outside the metarepo, and
    // a short path, since Windows can't start a program in one over 260 characters and a run
    // folder under a deep metarepo can pass that (found on a real run). Its findings are kept
    // in the run folder; the folder goes.
    const reviewer = request.agent.outputArtifact === "findings" && request.outputIn === "run";
    const work = reviewer ? await mkdtemp(join(tmpdir(), "atticus-review-")) : undefined;
    // It reads the repos' clones before it says something is missing (W1): they are added to
    // what it may read, and every edit under them is refused, so they stay read-only.
    const clones = work ? await existingDirs(cloneDirs(this.h.root)) : [];
    const base = work
      ? {
          cwd: work,
          permissionMode: "acceptEdits" as const,
          ...(clones.length
            ? { addDirs: clones, disallowedTools: clones.map((d) => `Edit(/${posixPath(d)}/**)`) }
            : {}),
        }
      : (this.h.invocation?.(request) ?? { cwd: this.h.root });
    // W3a: a stage's drafter may run the stage's own check, and nothing else besides.
    const inv =
      !work && request.selfCheck
        ? {
            ...base,
            allowedTools: [
              ...((base as { allowedTools?: string[] }).allowedTools ?? []),
              `Bash(${request.selfCheck.command}:*)`,
            ],
          }
        : base;
    await mkdir(dir, { recursive: true });
    const promptFile = join(dir, "prompt.md");
    const self = reviewer ? undefined : request.selfCheck;
    const handoff =
      HandoffRuntime.promptFor(run, changesRelOf(this.h.root), runsRelOf(this.h.root)).replace(
        /\nWhen the file is complete.*\n$/s,
        "\n",
      ) +
      // W3a: the drafter checks its own file with the stage's checks before it finishes.
      (self
        ? `\nBefore you finish, check the file: run ${self.command} ${HandoffRuntime.outputRel(run, changesRelOf(this.h.root), runsRelOf(this.h.root))}. Fix each problem it lists and run it again, until it says the file is clean (at most ${self.limit} times).\n`
        : "");
    const prompt = reviewer
      ? handoff.replace(
          `Write the result to ${HandoffRuntime.outputRel(run, changesRelOf(this.h.root), runsRelOf(this.h.root))}.`,
          `Write the result to ${request.outputPath}.${clones.length ? ` The metarepo is at ${this.h.root}: a folder named relative to the metarepo (the repos' clones under workspace/) is there, to read, never to edit.` : ""}`,
        )
      : handoff;
    await writeFile(promptFile, prompt, "utf8");
    await writeFile(
      join(dir, "context-manifest.json"),
      JSON.stringify(request.pack.manifest, null, 2) + "\n",
      "utf8",
    );
    if (!(await stat(inv.cwd).catch(() => undefined)))
      throw new RuntimeError(`the worktree ${inv.cwd} doesn't exist`);
    // The prompt asks for the result in a file; Claude Code writes it there and answers with a
    // summary. The file is the output when this run wrote it (created or changed it).
    const outputFile = work
      ? join(work, request.outputPath)
      : request.outputIn === "run"
        ? join(dir, request.outputPath)
        : join(changesDirOf(this.h.root), request.change, request.outputPath);
    try {
      return await this.runIn(run, dir, inv, prompt, promptFile, outputFile, signal);
    } finally {
      if (work) {
        const kept = await readFile(outputFile, "utf8").catch(() => undefined);
        if (kept !== undefined) {
          await mkdir(dirname(join(dir, request.outputPath)), { recursive: true });
          await writeFile(join(dir, request.outputPath), kept, "utf8");
        }
        await rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
      }
    }
  }

  private async runIn(
    run: Run,
    dir: string,
    inv: {
      cwd: string;
      permissionMode?: PermissionMode;
      env?: Record<string, string>;
      allowedTools?: string[];
      addDirs?: string[];
      disallowedTools?: string[];
    },
    prompt: string,
    promptFile: string,
    outputFile: string,
    signal?: AbortSignal,
  ) {
    const { request } = run;
    const before = (await stat(outputFile).catch(() => undefined))?.mtimeMs;
    const res = await this.runner({
      cwd: inv.cwd,
      prompt,
      promptFile,
      args: HeadlessClaudeCodeRuntime.args({
        permissionMode: inv.permissionMode ?? "acceptEdits",
        ...(this.h.model ? { model: this.h.model } : {}),
        ...(inv.allowedTools ? { allowedTools: inv.allowedTools } : {}),
        ...(inv.addDirs ? { addDirs: inv.addDirs } : {}),
        ...(inv.disallowedTools ? { disallowedTools: inv.disallowedTools } : {}),
      }),
      env: inv.env ?? {},
      timeoutMs: this.h.timeoutMs ?? 30 * 60_000,
      ...(signal ? { signal } : {}),
    });
    await writeFile(join(dir, "claude-output.json"), res.stdout, "utf8");
    let parsed: {
      result?: unknown;
      is_error?: unknown;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    try {
      parsed = JSON.parse(res.stdout) as typeof parsed;
    } catch {
      throw new RuntimeError(
        `Claude Code exited ${res.exitCode ?? "without a code"} without JSON output: ${(res.stderr || res.stdout).trim().split("\n").slice(-2).join(" ")}`,
      );
    }
    const text = typeof parsed.result === "string" ? parsed.result : "";
    if (res.exitCode !== 0 || parsed.is_error === true)
      throw new RuntimeError(`Claude Code reported a failure: ${text || res.stderr.trim()}`);
    const after = (await stat(outputFile).catch(() => undefined))?.mtimeMs;
    const written =
      after !== undefined && after !== before ? await readFile(outputFile, "utf8") : undefined;
    return {
      output: written ?? text,
      usage: {
        inputTokens: parsed.usage?.input_tokens ?? request.pack.manifest.totalTokens,
        outputTokens: parsed.usage?.output_tokens ?? estimateTokens(text),
      },
    };
  }
}

// ------------------------------------------------------------------ factory

type Settings = Record<string, string | number | boolean | string[]>;

/** Builds a model provider from runtime.yaml `adapters.model.settings` (ADR 0065). */
export type ModelProviderFactory = (settings: Settings) => ModelProvider;

const registered = new Map<string, ModelProviderFactory>();

/**
 * Register a model-provider plugin under a runtime.yaml `adapters.model.type` (ADR 0065).
 * The CLI registers the built-in ones from `@maycombhq/model-providers` when it starts; an
 * organisation's own provider registers the same way. Providers passed to `createRuntime`
 * directly win over registered ones. `mock` is reserved for tests.
 */
export function registerModelProvider(type: string, factory: ModelProviderFactory): void {
  if (type === "mock")
    throw new RuntimeConfigError("mock is the test provider; it can't be replaced");
  registered.set(type, factory);
}

/** An org pack's model-provider plugin (ADR 0121 item 4), as orgpack-load reads it. */
export interface ModelProviderPluginRef {
  manifest: ModelProviderPlugin;
  dir: string;
}

/**
 * Turns an org pack's model-provider plugin into a factory: reads its pinned entry file and runs
 * it in the plugin sandbox. The command line registers it (it has the sandbox); without one, a
 * plugin can't be loaded and model mode says so.
 */
export type ModelProviderPluginLoader = (
  p: ModelProviderPluginRef,
) => Promise<ModelProviderFactory>;

let pluginLoader: ModelProviderPluginLoader | undefined;

export function registerModelProviderPluginLoader(l: ModelProviderPluginLoader | undefined): void {
  pluginLoader = l;
}

/**
 * The factory for runtime.yaml's adapters.model.type: a registered provider, else the org pack's
 * plugin of that id (plugins/model-providers/<id>/); undefined when there is neither.
 */
export async function providerFactoryFor(
  op: { modelProviders?: readonly ModelProviderPluginRef[] },
  type: string,
): Promise<ModelProviderFactory | undefined> {
  const made = registered.get(type);
  if (made) return made;
  const p = op.modelProviders?.find((x) => x.manifest.id === type);
  if (!p) return undefined;
  if (!pluginLoader)
    throw new RuntimeConfigError(
      `The org pack has a ${type} model-provider plugin, but this program can't load plugins: run the step with the atticus command line.`,
    );
  return pluginLoader(p);
}

/** A registered provider, built from runtime.yaml's settings; undefined for a type none registered. */
export function makeModelProvider(type: string, settings: Settings): ModelProvider | undefined {
  const make = registered.get(type);
  return make ? make(settings) : undefined;
}

/** The registered model-provider types (for messages and checks). */
export function registeredModelProviders(): string[] {
  return [...registered.keys()].sort();
}

/** Forget every registered provider (tests). */
export function clearModelProviders(): void {
  registered.clear();
}

let toolSource: ((root: string) => ToolSource | undefined) | undefined;

/**
 * Register where a metarepo's read-only tools come from (ADR 0107 addendum): the CLI registers
 * the context tools (packages/index) when it starts. The model runtime offers them to a
 * provider that can call tools. Undefined forgets it (tests).
 */
export function registerToolSource(source: ((root: string) => ToolSource | undefined) | undefined) {
  toolSource = source;
}

export interface CreateRuntimeOptions {
  /** The metarepo root (hand-off runs and headless prompt files go under .runs/). */
  root: string;
  /** Override runtime.yaml's default mode; it must still be allowed there (replay and mock always are). */
  mode?: RuntimeMode;
  now?: () => Date;
  /** Checks a one-shot runtime's output; problems make the run fail. */
  validate?: (output: string, request: AiRequest) => Promise<string[]>;
  /** Checks a hand-off output file. Default: the file must not be empty. */
  handoffValidate?: HandoffOptions["validate"];
  /** Model-provider adapters by runtime.yaml `adapters.model.type`; plugins register here. */
  providers?: Record<string, ModelProviderFactory>;
  /** Answers for mock mode. */
  respond?: (request: AiRequest) => string;
  /** Answers of the mock model provider (runtime.yaml `adapters.model.type: mock`), from the prompt. */
  modelAnswer?: (prompt: string) => string;
  /** The mock model provider's tool calls, round by round. */
  modelScript?: MockChatScript;
  /** The read-only tools the model runtime offers. Default: the registered tool source's. */
  tools?: ToolSource;
  /** Recordings for replay mode: a folder (`<agent>/<promptSha256>.json`) or a list. */
  replayDir?: string;
  recordings?: Recording[];
  headless?: Omit<HeadlessOptions, "root" | "now" | "validate">;
}

const nonEmpty: HandoffOptions["validate"] = async (file, request) => {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.trim() ? [] : [`${request.outputPath} is empty`];
};

/**
 * Build the runtime runtime.yaml asks for (or the mode named), refusing what it doesn't
 * allow, with a message that says what to change.
 */
export async function createRuntime(
  orgPack: Pick<OrgPack, "runtime"> & { modelProviders?: readonly ModelProviderPluginRef[] },
  o: CreateRuntimeOptions,
): Promise<AiRuntime> {
  const rt = orgPack.runtime;
  const mode = o.mode ?? rt.modes.default;
  if (!(RUNTIME_MODES as readonly string[]).includes(mode))
    throw new RuntimeConfigError(
      `There is no AI mode called ${String(mode)}. Use one of: ${RUNTIME_MODES.join(", ")}.`,
    );
  if (rt.ai === "off" && CONFIGURED.includes(mode)) throw new AiOffError();
  if (CONFIGURED.includes(mode) && !rt.modes.allowed.includes(mode as never))
    throw new RuntimeConfigError(
      `runtime.yaml doesn't allow ${mode} mode (allowed: ${rt.modes.allowed.join(", ")}). Change modes.allowed in a pull request, or pick an allowed mode.`,
    );
  const one = { ...(o.now ? { now: o.now } : {}), ...(o.validate ? { validate: o.validate } : {}) };
  switch (mode) {
    case "hand-off":
      return new HandoffRuntime({
        root: o.root,
        validate: o.handoffValidate ?? nonEmpty,
        ...(o.now ? { now: o.now } : {}),
      });
    case "model": {
      const cfg = rt.adapters.model;
      if (!cfg)
        throw new RuntimeConfigError(
          "Model mode needs a model adapter in runtime.yaml (adapters.model with its type and settings). Until one is configured, use hand-off mode.",
        );
      const make =
        o.providers?.[cfg.type] ??
        (await providerFactoryFor(orgPack, cfg.type)) ??
        (cfg.type === "mock"
          ? (s: Settings) =>
              new MockModelProvider(
                typeof s.model === "string" ? s.model : "mock-model",
                o.modelAnswer ?? (() => ""),
                o.modelScript,
              )
          : undefined);
      if (!make)
        throw new RuntimeConfigError(
          `No ${cfg.type} model provider is installed. Add its plugin, or use hand-off mode.`,
        );
      const tools = o.tools ?? toolSource?.(o.root);
      return new ModelRuntime(make(cfg.settings as Settings), {
        ...one,
        allowedModels: rt.models.allowed,
        root: o.root,
        ...(tools ? { tools } : {}),
      });
    }
    case "headless-claude-code":
      if (!rt.assistants.allowed.includes("claude-code"))
        throw new RuntimeConfigError(
          "Headless Claude Code runs Claude Code, which runtime.yaml doesn't list under assistants.allowed.",
        );
      return new HeadlessClaudeCodeRuntime({
        root: o.root,
        ...o.headless,
        ...(o.now ? { now: o.now } : {}),
        ...(o.validate ? { validate: o.validate } : {}),
      });
    case "replay":
      if (o.recordings) return new ReplayRuntime(o.recordings, one);
      if (!o.replayDir)
        throw new RuntimeConfigError(
          "Replay mode needs a folder of recordings (ATTICUS_REPLAY_DIR).",
        );
      return ReplayRuntime.fromDir(o.replayDir, one);
    case "mock":
      if (!o.respond)
        throw new RuntimeConfigError("Mock mode is for tests: it needs a function that answers.");
      return new MockRuntime(o.respond, one);
  }
}

export interface CliRuntime {
  runtime: AiRuntime;
  mode: RuntimeMode;
  /** One plain sentence for the CLI to print: how AI runs for this command. */
  describe: string;
}

/**
 * The runtime for a CLI command, from the metarepo's org pack: mode from `--mode`, else
 * `ATTICUS_RUNTIME`, else runtime.yaml's default. Replay reads `ATTICUS_REPLAY_DIR`. Mock mode
 * is refused here (it is for tests). A broken runtime.yaml is an error, never a silent default.
 */
export async function runtimeForCli(
  root: string,
  o: {
    mode?: string;
    env?: Record<string, string | undefined>;
    providers?: CreateRuntimeOptions["providers"];
    headless?: CreateRuntimeOptions["headless"];
    handoffValidate?: CreateRuntimeOptions["handoffValidate"];
  } = {},
): Promise<CliRuntime> {
  const env = o.env ?? process.env;
  const op = await loadOrgPack(join(orgPackDirOf(root)));
  const bad = op.problems.filter((p) => p.file === "runtime.yaml");
  if (bad.length)
    throw new RuntimeConfigError(
      `org-pack/runtime.yaml has problems: ${bad.map((p) => `${p.path ? `${p.path}: ` : ""}${p.message}`).join("; ")}`,
    );
  const asked = o.mode ?? env.ATTICUS_RUNTIME ?? op.runtime.modes.default;
  if (asked === "mock")
    throw new RuntimeConfigError(
      "Mock mode is for tests; use hand-off, model, headless-claude-code or replay.",
    );
  const mode = asked as RuntimeMode;
  const runtime = await createRuntime(op, {
    root,
    mode,
    ...(env.ATTICUS_REPLAY_DIR ? { replayDir: env.ATTICUS_REPLAY_DIR } : {}),
    ...(o.providers ? { providers: o.providers } : {}),
    ...(o.headless ? { headless: o.headless } : {}),
    ...(o.handoffValidate ? { handoffValidate: o.handoffValidate } : {}),
  });
  const describe =
    mode === "hand-off"
      ? "AI steps are handed to your assistant: Atticus writes the prompt and waits for atticus handoff done."
      : mode === "model"
        ? `AI steps call the ${op.runtime.adapters.model?.type ?? "configured"} model directly.`
        : mode === "headless-claude-code"
          ? "AI steps run in headless Claude Code."
          : "AI steps replay recorded answers.";
  return { runtime, mode, describe };
}
