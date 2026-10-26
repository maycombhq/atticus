import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  ApplyInstructions,
  ArchiveResult,
  ArtifactInstructions,
  ChangeDetail,
  ChangeList,
  ChangeStatus,
  ErrorEnvelope,
  NewChangeResult,
  SchemaInfo,
  SpecDetail,
  SpecList,
  ValidationReport,
  type ChangeSummary,
  type SpecSummary,
} from "./results.js";

/**
 * OpenSpec versions this adapter is tested against. The dependency is pinned exactly;
 * a different installed version inside this range is accepted, outside it is refused.
 */
export const OPENSPEC_PINNED = "1.14.0";
export const OPENSPEC_SUPPORTED = { min: "1.13.0", maxExclusive: "2.0.0" } as const;

/**
 * Environment for every OpenSpec run: no telemetry, no update check, no shell-completion
 * or global-config writes, no colour, no prompts. Atticus must never make a network call
 * the user did not ask for.
 */
export function openspecEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    DO_NOT_TRACK: "1",
    OPENSPEC_TELEMETRY: "0",
    OPENSPEC_NO_UPDATE_CHECK: "1",
    OPENSPEC_NO_AUTO_CONFIG: "1",
    OPENSPEC_NO_COMPLETIONS: "1",
    OPENSPEC_NO_ANIMATION: "1",
    OPEN_SPEC_INTERACTIVE: "0",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    CI: "1",
  };
}

/**
 * Path of the bundled OpenSpec CLI script, run with the current Node so it works the same on
 * Windows. ATTICUS_OPENSPEC_BIN names another script instead: the weekly compatibility job runs
 * the adapter's suite against the newest OpenSpec with it (ADR 0006 addendum).
 */
export function bundledOpenSpecBin(): string {
  const other = process.env.ATTICUS_OPENSPEC_BIN?.trim();
  if (other) return other;
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@fission-ai/openspec");
  // entry is <pkg>/dist/index.js
  return join(dirname(dirname(entry)), "bin", "openspec.js");
}

export class OpenSpecError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr = "",
  ) {
    super(message);
    this.name = "OpenSpecError";
  }
}

export interface OpenSpecOptions {
  /** The metarepo root: the folder that holds openspec/. */
  root: string;
  /** OpenSpec CLI script to run with Node. Defaults to the bundled, pinned version. */
  bin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ValidateOptions {
  item?: string;
  type?: "change" | "spec";
  strict?: boolean;
}

export interface ArchiveOptions {
  /** For changes that alter no spec (tooling, docs). */
  skipSpecs?: boolean;
  /**
   * Atticus refuses to archive a change with unticked tasks, which OpenSpec allows with
   * --yes. Default true.
   */
  requireTasksComplete?: boolean;
}

/** The OpenSpec stable core, as Atticus uses it. Every call goes through this interface. */
export interface OpenSpec {
  readonly root: string;
  version(): Promise<string>;
  /** Throws unless the installed version is in OPENSPEC_SUPPORTED. Returns the version. */
  assertSupported(): Promise<string>;
  /** `openspec init` with no assistant files (Atticus generates those itself). */
  init(): Promise<void>;
  newChange(
    id: string,
    opts?: { description?: string; schema?: string },
  ): Promise<{ id: string; path: string; schema: string }>;
  status(change: string): Promise<ChangeStatus>;
  instructions(artifact: string, change: string): Promise<ArtifactInstructions>;
  applyInstructions(change: string): Promise<ApplyInstructions>;
  validate(opts?: ValidateOptions): Promise<ValidationReport>;
  listChanges(): Promise<ChangeSummary[]>;
  listSpecs(): Promise<SpecSummary[]>;
  showChange(id: string): Promise<ChangeDetail>;
  showSpec(id: string): Promise<SpecDetail>;
  archive(id: string, opts?: ArchiveOptions): Promise<ArchiveResult["archive"]>;
  schemas(): Promise<SchemaInfo[]>;
}

/** Compare dotted versions numerically; pre-release tags sort before the release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = "", pre] = v.trim().replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return 0;
}

/** Releases only: pre-releases are never accepted. */
export function isSupportedVersion(v: string): boolean {
  return (
    /^v?\d+\.\d+\.\d+$/.test(v.trim()) &&
    compareVersions(v, OPENSPEC_SUPPORTED.min) >= 0 &&
    compareVersions(v, OPENSPEC_SUPPORTED.maxExclusive) < 0
  );
}

/** OpenSpec sometimes prints a notice line before its JSON; take the JSON. */
export function extractJson(stdout: string): unknown {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => l.startsWith("{") || l.startsWith("["));
    if (start === -1) throw new Error("no JSON in OpenSpec output");
    return JSON.parse(lines.slice(start).join("\n"));
  }
}

const ID = /^[a-z0-9][a-z0-9._-]*$/;

function checkId(what: string, id: string): string {
  if (!ID.test(id) || id.length > 120) {
    throw new OpenSpecError(`${what} "${id}" must be a lowercase slug`, "bad_id", [], null);
  }
  return id;
}

function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync.native(p);
    } catch {
      return resolve(p);
    }
  };
  const x = real(a);
  const y = real(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export function createOpenSpec(options: OpenSpecOptions): OpenSpec {
  const root = resolve(options.root);
  const bin = options.bin ?? bundledOpenSpecBin();
  const timeout = options.timeoutMs ?? 60_000;
  const env = openspecEnv(options.env);

  const run = (args: string[]): Promise<RunResult> =>
    new Promise((resolvePromise, reject) => {
      execFile(
        process.execPath,
        [bin, ...args],
        {
          cwd: root,
          env,
          timeout,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          encoding: "utf8",
        },
        (err, stdout, stderr) => {
          if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(
              new OpenSpecError(
                `OpenSpec could not be started: ${err.message}`,
                "not_installed",
                args,
                null,
                stderr,
              ),
            );
            return;
          }
          if (err && err.killed) {
            reject(
              new OpenSpecError(
                `OpenSpec timed out after ${timeout} ms`,
                "timeout",
                args,
                null,
                stderr,
              ),
            );
            return;
          }
          const exitCode = err ? (typeof err.code === "number" ? err.code : 1) : 0;
          resolvePromise({ stdout, stderr, exitCode });
        },
      );
    });

  /** Run with --json and parse; non-zero exits become OpenSpecError unless `allowFailure` returns a result. */
  async function json<T>(args: string[], schema: z.ZodType<T>, allowFailure = false): Promise<T> {
    const full = [...args, "--json"];
    const r = await run(full);
    let data: unknown;
    try {
      data = extractJson(r.stdout);
    } catch {
      throw new OpenSpecError(
        `OpenSpec printed no JSON (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`,
        "bad_output",
        full,
        r.exitCode,
        r.stderr,
      );
    }
    const parsed = schema.safeParse(data);
    if (r.exitCode === 0 || (allowFailure && parsed.success)) {
      if (!parsed.success) {
        throw new OpenSpecError(
          `OpenSpec output did not match the adapter contract: ${parsed.error.message}`,
          "contract_mismatch",
          full,
          r.exitCode,
          r.stderr,
        );
      }
      checkRoot(data, full);
      return parsed.data;
    }
    const envelope = ErrorEnvelope.safeParse(data);
    if (envelope.success) {
      const first = envelope.data.status[0]!;
      throw new OpenSpecError(first.message, first.code, full, r.exitCode, r.stderr);
    }
    throw new OpenSpecError(
      `OpenSpec failed (exit ${r.exitCode})`,
      "failed",
      full,
      r.exitCode,
      r.stderr,
    );
  }

  /** OpenSpec finds the nearest root upward; make sure it used ours and not a parent folder's. */
  function checkRoot(data: unknown, args: string[]) {
    const reported = (data as { root?: { path?: unknown } } | null)?.root?.path;
    if (typeof reported === "string" && !samePath(reported, root)) {
      throw new OpenSpecError(
        `OpenSpec used ${reported} instead of ${root}; run init in the metarepo first`,
        "root_mismatch",
        args,
        0,
      );
    }
  }

  const api: OpenSpec = {
    root,

    async version() {
      const r = await run(["--version"]);
      if (r.exitCode !== 0)
        throw new OpenSpecError(
          "could not read OpenSpec version",
          "failed",
          ["--version"],
          r.exitCode,
          r.stderr,
        );
      return r.stdout.trim();
    },

    async assertSupported() {
      const v = await api.version();
      if (!isSupportedVersion(v)) {
        throw new OpenSpecError(
          `OpenSpec ${v} is not supported; Atticus needs >=${OPENSPEC_SUPPORTED.min} <${OPENSPEC_SUPPORTED.maxExclusive} (tested with ${OPENSPEC_PINNED})`,
          "unsupported_version",
          ["--version"],
          0,
        );
      }
      return v;
    },

    async init() {
      const args = ["init", "--tools", "none", "--no-animation", "--no-copilot-cloud", "."];
      const r = await run(args);
      if (r.exitCode !== 0) {
        throw new OpenSpecError(
          `openspec init failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`,
          "failed",
          args,
          r.exitCode,
          r.stderr,
        );
      }
    },

    async newChange(id, opts = {}) {
      const args = ["new", "change", checkId("change id", id)];
      if (opts.description) args.push("--description", opts.description);
      if (opts.schema) args.push("--schema", checkId("schema", opts.schema));
      const r = await json(args, NewChangeResult);
      return { id: r.change.id, path: r.change.path, schema: r.change.schema };
    },

    status: async (change) =>
      json(["status", "--change", checkId("change id", change)], ChangeStatus),

    instructions: async (artifact, change) =>
      json(
        ["instructions", checkId("artifact", artifact), "--change", checkId("change id", change)],
        ArtifactInstructions,
      ),

    applyInstructions: async (change) =>
      json(["instructions", "apply", "--change", checkId("change id", change)], ApplyInstructions),

    async validate(opts = {}) {
      const args = ["validate"];
      if (opts.item) args.push(checkId("item", opts.item));
      else args.push("--all");
      if (opts.type) args.push("--type", opts.type);
      if (opts.strict) args.push("--strict");
      args.push("--no-interactive");
      // Exit 1 with a report means "invalid", which is a result, not an error.
      return json(args, ValidationReport, true);
    },

    async listChanges() {
      return (await json(["list"], ChangeList)).changes;
    },

    async listSpecs() {
      return (await json(["list", "--specs"], SpecList)).specs;
    },

    showChange: async (id) =>
      json(["show", checkId("change id", id), "--type", "change"], ChangeDetail),

    showSpec: async (id) => json(["show", checkId("spec id", id), "--type", "spec"], SpecDetail),

    async archive(id, opts = {}) {
      checkId("change id", id);
      if (opts.requireTasksComplete !== false) {
        const change = (await api.listChanges()).find((c) => c.name === id);
        if (!change)
          throw new OpenSpecError(`Change '${id}' not found`, "change_error", ["list"], 1);
        if (change.completedTasks < change.totalTasks) {
          throw new OpenSpecError(
            `Change '${id}' has ${change.totalTasks - change.completedTasks} unfinished task(s); finish or remove them before archiving`,
            "tasks_incomplete",
            ["archive", id],
            null,
          );
        }
      }
      const args = ["archive", id, "--yes"];
      if (opts.skipSpecs) args.push("--skip-specs");
      return (await json(args, ArchiveResult)).archive;
    },

    async schemas() {
      return json(["schemas"], z.array(SchemaInfo));
    },
  };
  return api;
}
