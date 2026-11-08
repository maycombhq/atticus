import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  changesDirOf,
  changesRelOf,
  runsDirOf,
  runsRelOf,
  writeFileAtomic,
  type AgentDefinition,
  type ContextPackManifest,
  type RunPart,
  type RuntimeKind,
  type StepClass,
} from "@maycombhq/core";
import { sha256 } from "./context.js";
import {
  checkAllowed,
  makeRunId,
  RuntimeError,
  transition,
  type AiRequest,
  type AiRuntime,
  type Run,
} from "./runtime.js";
import { stepClassOf } from "./step-class.js";

export interface HandoffOptions {
  /** The metarepo root; runs go to .runs/<change>/<runId>/ (under .atticus/ when adopted) and output to the change folder. */
  root: string;
  /** Check the produced file (openspec validate on it). Returns problems, empty when fine. */
  validate: (outputFile: string, request: AiRequest) => Promise<string[]>;
  /** How long the output must sit unchanged before the watcher accepts it. Default 30 s. */
  stableMs?: number;
  now?: () => Date;
  /**
   * ADR 0185: a step's several hand-offs that wait together (a stage's critic lenses) may be asked
   * in one prompt, `prepareBatch`. Off unless asked for; the CLI and the app ask for it.
   */
  batch?: boolean;
  /** The most tokens one batched prompt may hold, its parts' together. Default 60 000. */
  batchMaxTokens?: number;
}

/** Where a batched hand-off's answer goes, in its run's own folder (ADR 0185). */
export const BATCH_OUTPUT = "answers.md";
/** The most tokens a batched prompt holds unless the runtime is told otherwise (ADR 0185). */
export const DEFAULT_BATCH_MAX_TOKENS = 60_000;

/** The line that starts a part's section in a batched answer: `=== <part>`. */
// Round 45: a section starts only at the start of a line. An indented `=== <lens>` (quoted in an
// answer, say inside a YAML block) is the answer's text, never a new section.
const SECTION = /^===[ \t]*([a-z][a-z0-9-]*)[ \t]*$/;

/**
 * A batched answer's sections, by part name: the lines under each `=== <part>` line, up to the
 * next. Text before the first section is not an answer and is left out; a name given twice is
 * kept as `twice`, never one of the two picked.
 */
export function batchSections(text: string): Map<string, { text: string; twice?: true }> {
  const out = new Map<string, { text: string; twice?: true }>();
  let name: string | undefined;
  let lines: string[] = [];
  const end = () => {
    if (name === undefined) return;
    while (lines.length && !lines[0]!.trim()) lines.shift();
    while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    const body = lines.length ? `${lines.join("\n")}\n` : "";
    out.set(name, out.has(name) ? { text: body, twice: true } : { text: body });
  };
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const m = SECTION.exec(line);
    if (m) {
      end();
      name = m[1]!;
      lines = [];
    } else lines.push(line);
  }
  end();
  return out;
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

  /**
   * A batched hand-off's prompt (ADR 0185): one section to write per part, then each part's own
   * prompt, whole and in order, under its name. It ends with the completion command.
   */
  static promptForBatch(
    run: Run,
    parts: { name: string; prompt: string }[],
    changesRel = "openspec/changes",
    runsRel = ".runs",
  ): string {
    const { agent, change } = run.request;
    const where = HandoffRuntime.outputRel(run, changesRel, runsRel);
    const n = parts.length;
    return [
      `# ${agent.id}: ${n} parts for change ${change}, in one answer`,
      "",
      agent.description,
      "",
      `Write the result to ${where}. Change no other files.`,
      "",
      `The file holds one section per part below. Start each section with a line that holds only "=== " and the part's name, then write that part's answer exactly as the part asks for it, and nothing else. Answer each part from its own instructions and its own data only: the parts are separate. Leave no part out. Atticus checks each section on its own, as if that part were answered alone: a section that is missing or fails its check is asked for again, and the others are kept.`,
      "",
      ...parts.flatMap((p) => [`=== ${p.name}`, `<the ${p.name} part's answer>`]),
      "",
      ...parts.flatMap((p, i) => [
        "---",
        "",
        `Part ${i + 1} of ${n}: ${p.name}. Its answer is the section "=== ${p.name}".`,
        "",
        p.prompt.trimEnd(),
        "",
      ]),
      "---",
      "",
      `When the file is complete, run: atticus handoff done ${run.runId}`,
      "",
    ].join("\n");
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
      run.request.selfCheck
        ? `When the file is complete, run: atticus handoff done ${run.runId}. It checks the file as the stage does: fix each problem it lists in the file and run it again, until it says the file is clean. After ${run.request.selfCheck.limit} checks the file is handed in as it is.`
        : `When the file is complete, run: atticus handoff done ${run.runId}`,
      "",
    ].join("\n");
  }

  /** A run id no run folder of the change has yet. */
  private async freshId(change: string, now: Date): Promise<string> {
    // Each process counts from 1, so a run another process made in the same second may
    // already have this id: skip any id whose run folder is on disk.
    let runId = makeRunId(now, ++this.seq);
    while (await stat(this.runDir(change, runId)).catch(() => undefined))
      runId = makeRunId(now, ++this.seq);
    return runId;
  }

  /**
   * Whether `parts` runs that wait together, `tokens` in all, are asked in one prompt (ADR 0185):
   * only when this runtime batches, for two parts or more, within the size a batch may hold.
   */
  canBatch(parts: number, tokens: number): boolean {
    return (
      !!this.o.batch && parts >= 2 && tokens <= (this.o.batchMaxTokens ?? DEFAULT_BATCH_MAX_TOKENS)
    );
  }

  /**
   * Ask several waiting runs of one change in one prompt (ADR 0185). Each part keeps its own run,
   * prompt, pack and answer file, and can still be answered alone; the batch links them, and each
   * part names the batch. The batch's pack is its parts' packs together: their sources, each id
   * under its part's name, and their sizes added up. Run it (`run`) to hand it over.
   */
  async prepareBatch(o: {
    change: string;
    agent: AgentDefinition;
    parts: RunPart[];
    stepClass?: StepClass;
  }): Promise<Run> {
    checkAllowed(this.kind, o.agent);
    if (o.parts.length < 2) throw new RuntimeError("a batched hand-off needs two parts or more");
    const twice = o.parts.find((p, i) => o.parts.findIndex((x) => x.name === p.name) !== i);
    if (twice)
      throw new RuntimeError(`a batched hand-off can't have two parts named ${twice.name}`);
    const parts: { name: string; run: Run }[] = [];
    for (const p of o.parts) {
      const run = await this.load(p.runId);
      if (run.request.change !== o.change)
        throw new RuntimeError(`run ${p.runId} isn't a run of ${o.change}`);
      if (run.state !== "waiting" && run.state !== "prepared")
        throw new RuntimeError(
          `run ${p.runId} is ${run.state}: only a run still waiting for its answer can be batched`,
        );
      if (run.batch) throw new RuntimeError(`run ${p.runId} is already asked in ${run.batch}`);
      parts.push({ name: p.name, run });
    }
    const now = this.now();
    const runId = await this.freshId(o.change, now);
    const manifests = parts.map((p) => ({ name: p.name, m: p.run.request.pack.manifest }));
    const totalTokens = manifests.reduce((n, x) => n + x.m.totalTokens, 0);
    const agent = { ...o.agent, tokenBudget: Math.max(o.agent.tokenBudget, totalTokens) };
    const run: Run = {
      runId,
      request: {
        change: o.change,
        agent,
        pack: { prompt: "", manifest: manifests[0]!.m },
        outputPath: BATCH_OUTPUT,
        outputIn: "run",
        ...(o.stepClass ? { stepClass: o.stepClass } : {}),
      },
      runtime: this.kind,
      state: "prepared",
      attempt: 1,
      startedAt: now.toISOString(),
      errors: [],
      stepClass: o.stepClass ?? stepClassOf({ agent }),
      parts: parts.map((p) => ({ name: p.name, runId: p.run.runId })),
    };
    const prompt = HandoffRuntime.promptForBatch(
      run,
      parts.map((p) => ({ name: p.name, prompt: p.run.request.pack.prompt })),
      changesRelOf(this.o.root),
      runsRelOf(this.o.root),
    );
    const manifest: ContextPackManifest = {
      schemaVersion: 1,
      change: o.change,
      agent: o.agent.id,
      createdAt: now.toISOString(),
      budget: manifests.reduce((n, x) => n + x.m.budget, 0),
      totalTokens,
      sources: manifests.flatMap((x) =>
        x.m.sources.map((s) => ({ ...s, id: `${x.name}/${s.id}` })),
      ),
      dropped: manifests.flatMap((x) =>
        x.m.dropped.map((d) => ({ ...d, id: `${x.name}/${d.id}` })),
      ),
      promptSha256: sha256(prompt),
    };
    run.request.pack = { prompt, manifest };
    const dir = this.runDir(o.change, runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "prompt.md"), prompt, "utf8");
    await writeFile(
      join(dir, "context-manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8",
    );
    await this.save(run);
    for (const p of parts) await this.save({ ...p.run, batch: runId });
    return run;
  }

  async prepare(request: AiRequest): Promise<Run> {
    checkAllowed(this.kind, request.agent);
    if (request.pack.manifest.totalTokens > request.agent.tokenBudget) {
      throw new RuntimeError(
        `context pack (${request.pack.manifest.totalTokens} tokens) is over agent ${request.agent.id}'s budget of ${request.agent.tokenBudget}`,
      );
    }
    const now = this.now();
    const runId = await this.freshId(request.change, now);
    const run: Run = {
      runId,
      request,
      runtime: this.kind,
      state: "prepared",
      attempt: 1,
      startedAt: now.toISOString(),
      errors: [],
      // ADR 0121 addendum: the kind of step, so the editor answering it picks its model.
      stepClass: stepClassOf(request),
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

  /**
   * `atticus handoff done <runId>` or Mark done: the output is there, check it now. `model` is
   * the model that wrote it, when the one answering says (`--model`, ADR 0121 addendum): kept in
   * the run record for Model runs.
   */
  async done(runId: string, o: { model?: string } = {}): Promise<Run> {
    let run = await this.load(runId);
    const model = o.model?.trim();
    if (run.parts?.length) return this.doneBatch(run, model);
    if (model) run = { ...run, model };
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
    if (run.parts?.length) return this.doneBatch(run);
    return this.validate(transition(run, "produced", this.now()));
  }

  /**
   * A batched hand-off's Done (ADR 0185): its answer is split into its parts' sections, each
   * written to its part's own answer file and checked there as that part's Done would check it.
   * A part that passes is in; a missing, doubled or failing section fails only its part, which can
   * be fixed in the batch (Done again checks only the parts still out) or answered alone. The
   * batch passes once every part is in; until then it fails, naming each part that is out and why.
   */
  private async doneBatch(start: Run, model?: string): Promise<Run> {
    let run = start;
    if (run.state === "validated" || run.state === "cancelled") return run;
    if (run.state === "failed")
      run = transition(
        transition(run, "prepared", this.now(), { attempt: run.attempt + 1, errors: [] }),
        "waiting",
        this.now(),
      );
    if (model) run = { ...run, model };
    const output = await readFile(this.outputFile(run), "utf8").catch(() => undefined);
    if (output === undefined)
      return this.save(
        transition(run, "failed", this.now(), {
          errors: [`${run.request.outputPath} was not written`],
        }),
      );
    const names = run.parts!.map((p) => p.name);
    const sections = batchSections(output);
    if (!names.some((n) => sections.has(n)))
      return this.save(
        transition(run, "failed", this.now(), {
          output,
          errors: [
            `${run.request.outputPath} has no section of any part. Start each part's answer with its own line "=== <part>": ${names.map((n) => `=== ${n}`).join(", ")}.`,
          ],
        }),
      );
    run = transition(run, "produced", this.now(), { output });
    const errors: string[] = [];
    const runsRel = runsRelOf(this.o.root);
    for (const p of run.parts!) {
      const part = await this.load(p.runId);
      if (part.state === "validated" || part.state === "cancelled") continue;
      const s = sections.get(p.name);
      const alone = `answer that part alone: its prompt is ${HandoffRuntime.promptRel(part, runsRel)}.`;
      if (!s || s.twice) {
        errors.push(
          s
            ? `${p.name}: the answer has two "=== ${p.name}" sections. Keep one, or ${alone}`
            : `${p.name}: the answer has no "=== ${p.name}" section. Add it, or ${alone}`,
        );
        const why = `The batched answer (run ${run.runId}) has ${s ? 'two "=== ' + p.name + '" sections' : 'no "=== ' + p.name + '" section'}. Answer this part here.`;
        await this.save(
          part.state === "failed"
            ? { ...part, errors: [why] }
            : transition(part, "failed", this.now(), { errors: [why] }),
        );
        continue;
      }
      await writeFile(this.outputFile(part), s.text, "utf8");
      const r = await this.done(p.runId, model ? { model } : {});
      if (r.state !== "validated") errors.push(...r.errors.map((e) => `${p.name}: ${e}`));
    }
    return this.save(
      errors.length
        ? transition(run, "failed", this.now(), { errors })
        : transition(run, "validated", this.now()),
    );
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
export async function pruneRuns(
  root: string,
  days: number,
  now = new Date(),
  /** Only this change's runs (a stage prunes its own as it runs, ADR 0115 addendum 2026-10-25). */
  only?: string,
): Promise<string[]> {
  const removed: string[] = [];
  const runs = runsDirOf(root);
  const cutoff = now.getTime() - days * 86_400_000;
  const changes = only ? [only] : await readdir(runs).catch(() => [] as string[]);
  for (const change of changes) {
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
