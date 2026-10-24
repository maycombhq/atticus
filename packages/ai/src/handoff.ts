import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  changesDirOf,
  changesRelOf,
  runsDirOf,
  runsRelOf,
  writeFileAtomic,
  type RuntimeKind,
} from "@maycombhq/core";
import {
  checkAllowed,
  makeRunId,
  RuntimeError,
  transition,
  type AiRequest,
  type AiRuntime,
  type Run,
} from "./runtime.js";

export interface HandoffOptions {
  /** The metarepo root; runs go to .runs/<change>/<runId>/ (under .atticus/ when adopted) and output to the change folder. */
  root: string;
  /** Check the produced file (openspec validate on it). Returns problems, empty when fine. */
  validate: (outputFile: string, request: AiRequest) => Promise<string[]>;
  /** How long the output must sit unchanged before the watcher accepts it. Default 30 s. */
  stableMs?: number;
  now?: () => Date;
}

/**
 * Hand-off runtime: Atticus prepares the prompt and context pack, the person's own assistant
 * (Copilot or Claude Code, in VS Code or IntelliJ) writes the artifact, and Atticus checks it.
 *
 * prepared → waiting → produced → validated, or failed with the errors (then Retry).
 * Completion comes from `atticus handoff done <runId>` (the prompt ends by asking the
 * assistant to run it), from the file watcher once the output has been unchanged for
 * `stableMs`, or from the person clicking Mark done. State is kept on disk so it survives a
 * restart.
 */
export class HandoffRuntime implements AiRuntime {
  readonly kind: RuntimeKind = "hand-off";
  private seq = 0;

  constructor(private readonly o: HandoffOptions) {}

  private now = () => this.o.now?.() ?? new Date();
  private runDir = (change: string, runId: string) => join(runsDirOf(this.o.root), change, runId);
  private outputFile = (r: Run) =>
    r.request.outputIn === "run"
      ? join(this.runDir(r.request.change, r.runId), r.request.outputPath)
      : join(changesDirOf(this.o.root), r.request.change, r.request.outputPath);

  // Atomic: a step reading run.json while `handoff done` writes it never sees half a file.
  private async save(run: Run): Promise<Run> {
    const dir = this.runDir(run.request.change, run.runId);
    await writeFileAtomic(join(dir, "run.json"), JSON.stringify(run, null, 2) + "\n");
    return run;
  }

  /** Where a run's prompt is, relative to the root (`atticus <step> --handoff` prints it). */
  static promptRel(run: Pick<Run, "runId" | "request">, runsRel = ".runs"): string {
    return `${runsRel}/${run.request.change}/${run.runId}/prompt.md`;
  }

  /** Where the assistant writes a run's result, relative to the root. */
  static outputRel(
    run: Pick<Run, "runId" | "request">,
    changesRel = "openspec/changes",
    runsRel = ".runs",
  ): string {
    const { outputPath, change } = run.request;
    return run.request.outputIn === "run"
      ? `${runsRel}/${change}/${run.runId}/${outputPath}`
      : `${changesRel}/${change}/${outputPath}`;
  }

  /** The prompt the person's assistant gets. It ends with the completion command. */
  static promptFor(run: Run, changesRel = "openspec/changes", runsRel = ".runs"): string {
    const { agent, pack, outputPath, change } = run.request;
    const where = HandoffRuntime.outputRel(run, changesRel, runsRel);
    return [
      `# ${agent.id}: write ${outputPath} for change ${change}`,
      "",
      agent.description,
      "",
      `Write the result to ${where}. Change no other files.`,
      "",
      pack.prompt.trimEnd(),
      "",
      `When the file is complete, run: atticus handoff done ${run.runId}`,
      "",
    ].join("\n");
  }

  async prepare(request: AiRequest): Promise<Run> {
    checkAllowed(this.kind, request.agent);
    if (request.pack.manifest.totalTokens > request.agent.tokenBudget) {
      throw new RuntimeError(
        `context pack (${request.pack.manifest.totalTokens} tokens) is over agent ${request.agent.id}'s budget of ${request.agent.tokenBudget}`,
      );
    }
    const now = this.now();
    // Each process counts from 1, so a run another process made in the same second may
    // already have this id: skip any id whose run folder is on disk.
    let runId = makeRunId(now, ++this.seq);
    while (await stat(this.runDir(request.change, runId)).catch(() => undefined))
      runId = makeRunId(now, ++this.seq);
    const run: Run = {
      runId,
      request,
      runtime: this.kind,
      state: "prepared",
      attempt: 1,
      startedAt: now.toISOString(),
      errors: [],
    };
    const dir = this.runDir(request.change, run.runId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "prompt.md"),
      HandoffRuntime.promptFor(run, changesRelOf(this.o.root), runsRelOf(this.o.root)),
      "utf8",
    );
    await writeFile(
      join(dir, "context-manifest.json"),
      JSON.stringify(request.pack.manifest, null, 2) + "\n",
      "utf8",
    );
    return this.save(run);
  }

  /** Hand the prompt to the assistant; Atticus now waits. */
  async run(runId: string): Promise<Run> {
    const run = await this.load(runId);
    return this.save(transition(run, "waiting", this.now()));
  }

  async result(runId: string): Promise<Run> {
    return this.load(runId);
  }

  /** `atticus handoff done <runId>` or Mark done: the output is there, check it now. */
  async done(runId: string): Promise<Run> {
    let run = await this.load(runId);
    // A run whose last check failed (the file was missing or didn't validate) is looked at
    // again: the person fixed the file and says done once more ("run it again when it's fixed").
    if (run.state === "failed") {
      run = transition(
        transition(run, "prepared", this.now(), { attempt: run.attempt + 1, errors: [] }),
        "waiting",
        this.now(),
      );
    }
    const file = this.outputFile(run);
    if (!(await stat(file).catch(() => undefined))) {
      return this.save(
        transition(run, "failed", this.now(), {
          errors: [`${run.request.outputPath} was not written`],
        }),
      );
    }
    return this.validate(transition(run, "produced", this.now()));
  }

  /** File-watcher fallback: accept the output once it has been unchanged for stableMs. */
  async poll(runId: string): Promise<Run> {
    const run = await this.load(runId);
    if (run.state !== "waiting") return run;
    const info = await stat(this.outputFile(run)).catch(() => undefined);
    if (!info) return run;
    if (this.now().getTime() - info.mtimeMs < (this.o.stableMs ?? 30_000)) return run;
    return this.validate(transition(run, "produced", this.now()));
  }

  /** Retry after a failure: a fresh attempt with the same request. */
  async retry(runId: string): Promise<Run> {
    const run = await this.load(runId);
    return this.save(
      transition(run, "prepared", this.now(), { attempt: run.attempt + 1, errors: [] }),
    );
  }

  async cancel(runId: string): Promise<Run> {
    return this.save(transition(await this.load(runId), "cancelled", this.now()));
  }

  private async validate(run: Run): Promise<Run> {
    const file = this.outputFile(run);
    const output = await readFile(file, "utf8");
    const problems = await this.o.validate(file, run.request);
    const next =
      problems.length === 0
        ? transition(run, "validated", this.now(), { output })
        : transition(run, "failed", this.now(), { output, errors: problems });
    return this.save(next);
  }

  private async load(runId: string): Promise<Run> {
    if (!/^run-[0-9a-z-]+$/.test(runId)) throw new RuntimeError(`not a run id: ${runId}`);
    const runs = runsDirOf(this.o.root);
    for (const change of await readdir(runs).catch(() => [] as string[])) {
      const f = join(runs, change, runId, "run.json");
      const text = await readFile(f, "utf8").catch(() => undefined);
      if (text) return JSON.parse(text) as Run;
    }
    throw new RuntimeError(`no run ${runId}`);
  }
}

/**
 * Retention: remove run folders older than `days` (runtime.yaml retention.runsDays,
 * default 30). Summaries in review/ are kept; only full packs and transcripts go.
 */
export async function pruneRuns(root: string, days: number, now = new Date()): Promise<string[]> {
  const removed: string[] = [];
  const runs = runsDirOf(root);
  const cutoff = now.getTime() - days * 86_400_000;
  for (const change of await readdir(runs).catch(() => [] as string[])) {
    for (const runId of await readdir(join(runs, change)).catch(() => [] as string[])) {
      const f = join(runs, change, runId, "run.json");
      const text = await readFile(f, "utf8").catch(() => undefined);
      const started = text ? Date.parse((JSON.parse(text) as Run).startedAt) : NaN;
      if (!Number.isNaN(started) && started < cutoff) {
        await rm(join(runs, change, runId), { recursive: true, force: true });
        removed.push(`${change}/${runId}`);
      }
    }
  }
  return removed;
}
