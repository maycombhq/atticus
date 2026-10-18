import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeKind } from "@maycombhq/core";
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
  /** The metarepo root; runs go to .runs/<change>/<runId>/ and output to the change folder. */
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
  private runDir = (change: string, runId: string) => join(this.o.root, ".runs", change, runId);
  private outputFile = (r: Run) =>
    join(this.o.root, "openspec", "changes", r.request.change, r.request.outputPath);

  private async save(run: Run): Promise<Run> {
    const dir = this.runDir(run.request.change, run.runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run.json"), JSON.stringify(run, null, 2) + "\n", "utf8");
    return run;
  }

  /** The prompt the person's assistant gets. It ends with the completion command. */
  static promptFor(run: Run): string {
    const { agent, pack, outputPath, change } = run.request;
    return [
      `# ${agent.id}: write ${outputPath} for change ${change}`,
      "",
      agent.description,
      "",
      `Write the result to openspec/changes/${change}/${outputPath}. Change no other files.`,
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
    const run: Run = {
      runId: makeRunId(now, ++this.seq),
      request,
      runtime: this.kind,
      state: "prepared",
      attempt: 1,
      startedAt: now.toISOString(),
      errors: [],
    };
    const dir = this.runDir(request.change, run.runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "prompt.md"), HandoffRuntime.promptFor(run), "utf8");
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
    const run = await this.load(runId);
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
    const runs = join(this.o.root, ".runs");
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
  const runs = join(root, ".runs");
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
