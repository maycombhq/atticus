import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  changesDirOf,
  changesRelOf,
  loadOrgPack,
  runsDirOf,
  runsRelOf,
  RuntimeKind,
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
  type ModelProvider,
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
    new Promise((resolve, reject) => {
      const child = spawn(o.command ?? "claude", i.args, {
        cwd: i.cwd,
        env: { ...process.env, ...i.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...(i.signal ? { signal: i.signal } : {}),
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGINT"), i.timeoutMs);
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(
          new RuntimeError(
            (e as NodeJS.ErrnoException).code === "ENOENT"
              ? "Claude Code (claude) is not on PATH; install it or use hand-off mode"
              : e.message,
          ),
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, stdout, stderr });
      });
      child.stdin.end(i.prompt, "utf8");
    });
}

export type PermissionMode = "acceptEdits" | "plan" | "dontAsk";

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
  static args(o: { permissionMode: PermissionMode; model?: string; allowedTools?: string[] }) {
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
    ];
  }

  protected async produce(run: Run, signal?: AbortSignal) {
    const { request } = run;
    const inv = this.h.invocation?.(request) ?? { cwd: this.h.root };
    const dir = join(runsDirOf(this.h.root), request.change, run.runId);
    await mkdir(dir, { recursive: true });
    const promptFile = join(dir, "prompt.md");
    const prompt = HandoffRuntime.promptFor(
      run,
      changesRelOf(this.h.root),
      runsRelOf(this.h.root),
    ).replace(/\nWhen the file is complete.*\n$/s, "\n");
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
    const outputFile =
      request.outputIn === "run"
        ? join(dir, request.outputPath)
        : join(changesDirOf(this.h.root), request.change, request.outputPath);
    const before = (await stat(outputFile).catch(() => undefined))?.mtimeMs;
    const res = await this.runner({
      cwd: inv.cwd,
      prompt,
      promptFile,
      args: HeadlessClaudeCodeRuntime.args({
        permissionMode: inv.permissionMode ?? "acceptEdits",
        ...(this.h.model ? { model: this.h.model } : {}),
        ...(inv.allowedTools ? { allowedTools: inv.allowedTools } : {}),
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

/** The registered model-provider types (for messages and checks). */
export function registeredModelProviders(): string[] {
  return [...registered.keys()].sort();
}

/** Forget every registered provider (tests). */
export function clearModelProviders(): void {
  registered.clear();
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
  orgPack: Pick<OrgPack, "runtime">,
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
        registered.get(cfg.type) ??
        (cfg.type === "mock"
          ? (s: Settings) =>
              new MockModelProvider(
                typeof s.model === "string" ? s.model : "mock-model",
                o.modelAnswer ?? (() => ""),
              )
          : undefined);
      if (!make)
        throw new RuntimeConfigError(
          `No ${cfg.type} model provider is installed. Add its plugin, or use hand-off mode.`,
        );
      return new ModelRuntime(make(cfg.settings as Settings), {
        ...one,
        allowedModels: rt.models.allowed,
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
