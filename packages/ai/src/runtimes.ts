import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Recording, type RuntimeKind } from "@maycombhq/core";
import { DATA_RULE, estimateTokens } from "./context.js";
import {
  OneShotRuntime,
  RuntimeError,
  type AiRequest,
  type AiRuntime,
  type Run,
  type Usage,
} from "./runtime.js";

// ------------------------------------------------------------------ mock

/** Deterministic runtime for tests: the output is a pure function of the request. */
export class MockRuntime extends OneShotRuntime {
  readonly kind: RuntimeKind = "mock";

  constructor(
    private readonly respond: (request: AiRequest) => string,
    opts: ConstructorParameters<typeof OneShotRuntime>[0] = {},
  ) {
    super(opts);
  }

  protected async produce(run: Run) {
    const output = this.respond(run.request);
    return {
      output,
      usage: {
        inputTokens: run.request.pack.manifest.totalTokens,
        outputTokens: estimateTokens(output),
      },
    };
  }
}

// ------------------------------------------------------------------ replay

/**
 * Returns recorded model outputs, keyed by agent and the sha256 of the exact prompt. CI and
 * every end-to-end journey use this; no live model runs in CI. A prompt with no recording
 * fails with the key to record, so a changed prompt can't pass silently.
 */
export class ReplayRuntime extends OneShotRuntime {
  readonly kind: RuntimeKind = "replay";
  private recordings = new Map<string, Recording>();

  constructor(recordings: Recording[], opts: ConstructorParameters<typeof OneShotRuntime>[0] = {}) {
    super(opts);
    for (const r of recordings)
      this.recordings.set(`${r.agent}/${r.promptSha256}`, Recording.parse(r));
  }

  /** Load every recording under a folder (`<agent>/<promptSha256>.json`). */
  static async fromDir(
    dir: string,
    opts: ConstructorParameters<typeof OneShotRuntime>[0] = {},
  ): Promise<ReplayRuntime> {
    const out: Recording[] = [];
    let agents: string[] = [];
    try {
      agents = await readdir(dir);
    } catch {
      // no recordings yet
    }
    for (const a of agents.sort()) {
      for (const f of (await readdir(join(dir, a)).catch(() => [] as string[]))
        .filter((x) => x.endsWith(".json"))
        .sort()) {
        out.push(Recording.parse(JSON.parse(await readFile(join(dir, a, f), "utf8"))));
      }
    }
    return new ReplayRuntime(out, opts);
  }

  protected async produce(run: Run) {
    const { agent, pack } = run.request;
    const rec = this.recordings.get(`${agent.id}/${pack.manifest.promptSha256}`);
    if (!rec) {
      throw new RuntimeError(
        `no recording for agent ${agent.id} with prompt ${pack.manifest.promptSha256}; record one with a live model outside CI`,
      );
    }
    return { output: rec.output, usage: rec.usage };
  }
}

/** Wraps a live runtime and saves each output as a recording for ReplayRuntime. */
export async function recordRun(
  live: AiRuntime,
  request: AiRequest,
  dir: string,
  model: string,
  now = new Date(),
): Promise<Recording> {
  const prepared = await live.prepare(request);
  const run = await live.run(prepared.runId);
  if (run.output === undefined || run.state === "failed")
    throw new RuntimeError(`live run failed: ${run.errors.join("; ")}`);
  const rec: Recording = {
    schemaVersion: 1,
    agent: request.agent.id,
    promptSha256: request.pack.manifest.promptSha256,
    output: run.output,
    usage: run.usage ?? { inputTokens: 0, outputTokens: 0 },
    model,
    recordedAt: now.toISOString(),
  };
  await mkdir(join(dir, rec.agent), { recursive: true });
  await writeFile(
    join(dir, rec.agent, `${rec.promptSha256}.json`),
    JSON.stringify(rec, null, 2) + "\n",
    "utf8",
  );
  return rec;
}

// ------------------------------------------------------------------ model

/** A model provider behind an adapter (Anthropic, Azure OpenAI, Bedrock, Vertex). */
export interface ModelProvider {
  readonly model: string;
  complete(input: {
    system: string;
    prompt: string;
    maxOutputTokens: number;
    signal?: AbortSignal;
  }): Promise<{ text: string; usage: Usage }>;
}

/** Test provider: answers from a function, never the network. */
export class MockModelProvider implements ModelProvider {
  readonly calls: { system: string; prompt: string }[] = [];
  constructor(
    readonly model: string,
    private readonly answer: (prompt: string) => string,
  ) {}
  async complete(input: { system: string; prompt: string; maxOutputTokens: number }) {
    this.calls.push({ system: input.system, prompt: input.prompt });
    const text = this.answer(input.prompt);
    return {
      text,
      usage: {
        inputTokens: estimateTokens(input.system + input.prompt),
        outputTokens: estimateTokens(text),
      },
    };
  }
}

/** Calls a model directly with the context pack; used where the org pack allows model mode. */
export class ModelRuntime extends OneShotRuntime {
  readonly kind: RuntimeKind = "model";

  constructor(
    private readonly provider: ModelProvider,
    opts: ConstructorParameters<typeof OneShotRuntime>[0] & {
      allowedModels?: readonly string[];
    } = {},
  ) {
    super(opts);
    if (
      opts.allowedModels &&
      opts.allowedModels.length > 0 &&
      !opts.allowedModels.includes(provider.model)
    ) {
      throw new RuntimeError(`model ${provider.model} is not allowed by runtime.yaml`);
    }
  }

  protected async produce(run: Run, signal?: AbortSignal) {
    const { agent, pack, outputPath } = run.request;
    const system = `You are the ${agent.id} agent in Atticus. ${agent.description}\nWrite only the content of ${outputPath}.\n${DATA_RULE}`;
    const left = agent.tokenBudget - pack.manifest.totalTokens;
    const { text, usage } = await this.provider.complete({
      system,
      prompt: pack.prompt,
      maxOutputTokens: Math.max(256, left),
      ...(signal ? { signal } : {}),
    });
    return { output: text, usage };
  }
}
