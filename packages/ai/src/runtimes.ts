import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Recording, runsDirOf, type RuntimeKind, type StepClass } from "@maycombhq/core";
import { DATA_RULE, estimateTokens } from "./context.js";
import {
  chatWithTools,
  ToolSession,
  type ChatInput,
  type ChatTurn,
  type ToolBox,
  type ToolLimits,
} from "./tools.js";
import {
  OneShotRuntime,
  RuntimeError,
  type AiRequest,
  type AiRuntime,
  type Run,
  type Usage,
} from "./runtime.js";
import { stepClassOf } from "./step-class.js";

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
  /**
   * A conversation with tools (ADR 0107 addendum): the provider's tool-call API. A provider
   * without it gets the one-shot prompt and no tools.
   */
  chat?(input: ChatInput): Promise<ChatTurn>;
}

/** What a mock model does in one round of a conversation with tools. */
export type MockChatScript = (
  input: ChatInput,
  round: number,
) => { text?: string; calls?: { name: string; input: Record<string, unknown> }[] };

/** Test provider: answers from a function, never the network; with a script, it calls tools. */
export class MockModelProvider implements ModelProvider {
  readonly calls: { system: string; prompt: string }[] = [];
  /** Every conversation request with tools, as it was sent. */
  readonly chats: ChatInput[] = [];
  readonly chat?: (input: ChatInput) => Promise<ChatTurn>;
  constructor(
    readonly model: string,
    private readonly answer: (prompt: string) => string,
    script?: MockChatScript,
  ) {
    if (script)
      this.chat = async (input: ChatInput) => {
        this.chats.push(structuredClone({ ...input, signal: undefined }));
        const round = input.messages.filter((m) => m.role === "tool").length + 1;
        const first = input.messages[0];
        const r = script(input, round);
        const calls = (r.calls ?? []).map((c, i) => ({ id: `call-${round}-${i + 1}`, ...c }));
        const text =
          r.text ?? (calls.length ? "" : this.answer(first?.role === "user" ? first.text : ""));
        const sent = input.messages
          .map((m) =>
            m.role === "tool" ? m.results.map((x) => x.text).join("") : "text" in m ? m.text : "",
          )
          .join("");
        return {
          text,
          calls,
          usage: {
            inputTokens: estimateTokens(input.system + sent),
            outputTokens: estimateTokens(text),
          },
        };
      };
  }
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

/**
 * The tools a runtime offers each request (ADR 0107 addendum), or none. The CLI registers the
 * context tools of the metarepo (packages/index) with `registerToolSource`.
 */
export type ToolSource = (request: AiRequest) => ToolBox | undefined;

/** Calls a model directly with the context pack; used where the org pack allows model mode. */
export class ModelRuntime extends OneShotRuntime {
  readonly kind: RuntimeKind = "model";

  constructor(
    private readonly provider: ModelProvider,
    private readonly mo: ConstructorParameters<typeof OneShotRuntime>[0] & {
      allowedModels?: readonly string[];
      /** The read-only tools beside each pack, when the provider can call tools. */
      tools?: ToolSource;
      toolLimits?: Partial<ToolLimits>;
      /** The metarepo: each finished run is kept under .runs/ for Model runs. */
      root?: string;
      /**
       * A provider per kind of step (ADR 0121 addendum), for the kinds runtime.yaml (or the
       * person's setting) names a model for; the other kinds run on `provider`.
       */
      models?: Partial<Record<StepClass, ModelProvider>>;
    } = {},
  ) {
    super(mo);
    const opts = mo;
    if (
      opts.allowedModels &&
      opts.allowedModels.length > 0 &&
      !opts.allowedModels.includes(provider.model)
    ) {
      throw new RuntimeError(`model ${provider.model} is not allowed by runtime.yaml`);
    }
  }

  /** The provider for a request: its kind's, else the one provider. */
  private providerOf(request: AiRequest): ModelProvider {
    return this.mo.models?.[stepClassOf(request)] ?? this.provider;
  }

  protected override modelFor(request: AiRequest): string | undefined {
    return this.providerOf(request).model;
  }

  protected async produce(run: Run, signal?: AbortSignal) {
    const { agent, pack, outputPath } = run.request;
    const provider = this.providerOf(run.request);
    const system = `You are the ${agent.id} agent in Atticus. ${agent.description}\nWrite only the content of ${outputPath}.\n${DATA_RULE}`;
    const left = agent.tokenBudget - pack.manifest.totalTokens;
    const box = provider.chat ? this.mo.tools?.(run.request) : undefined;
    if (box && box.definitions.length && provider.chat) {
      const session = new ToolSession(box, this.mo.toolLimits);
      try {
        const r = await chatWithTools((i) => provider.chat!(i), {
          system,
          prompt: pack.prompt,
          session,
          maxOutputTokens: Math.max(256, left),
          ...(signal ? { signal } : {}),
        });
        return { output: r.text, usage: r.usage, tools: r.tools };
      } catch (e) {
        // The calls made before the failure stay in the run record.
        throw Object.assign(e as Error, { tools: session.record() });
      }
    }
    const { text, usage } = await provider.complete({
      system,
      prompt: pack.prompt,
      maxOutputTokens: Math.max(256, left),
      ...(signal ? { signal } : {}),
    });
    return { output: text, usage };
  }

  /** Kept as a hand-off run is: run.json, the prompt and the manifest, so Model runs shows it. */
  protected override async keep(run: Run): Promise<void> {
    if (!this.mo.root) return;
    const dir = join(runsDirOf(this.mo.root), run.request.change, run.runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "prompt.md"), run.request.pack.prompt, "utf8");
    await writeFile(
      join(dir, "context-manifest.json"),
      JSON.stringify(run.request.pack.manifest, null, 2) + "\n",
      "utf8",
    );
    await writeFile(join(dir, "run.json"), JSON.stringify(run, null, 2) + "\n", "utf8");
  }
}
