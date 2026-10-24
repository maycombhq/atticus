import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { quantize, type Embedder, type EmbedKind, type QuantVector } from "@maycombhq/ai";
import { encode, wordPieceConfig, type WordPieceConfig } from "./wordpiece.js";

/**
 * A local embedding model (ADR 0116): a folder with the model as ONNX (fp32: an int8 model's
 * vectors change with the batch's shape and the backend, so it is never used), its
 * tokenizer.json and `atticus-model.yaml`, which says how to run it and the model file's sha256.
 * The folder comes with the offline bundle; nothing is ever downloaded. Run on the CPU with
 * onnxruntime-node (no DirectML: its licence is not on the allowed list), or with its WASM build
 * where the native one won't load. One text a run, so a vector never depends on what else was
 * embedded with it.
 */

export const MODEL_MANIFEST = "atticus-model.yaml";

export const ModelManifest = z.strictObject({
  schemaVersion: z.literal(1),
  /** A short name, e.g. snowflake-arctic-embed-xs. */
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  /** fp32 only: an int8 model's vectors change with the batch's shape and the backend. */
  dtype: z.literal("fp32"),
  /** The model file, fp32 ONNX, in the folder. */
  model: z.string().min(1).default("model.onnx"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  tokenizer: z.string().min(1).default("tokenizer.json"),
  dim: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  /** cls: the first token's vector; mean: the average over the tokens. */
  pooling: z.enum(["cls", "mean"]),
  /** Said before a query (some retrieval models are trained with one). */
  queryPrefix: z.string().default(""),
  documentPrefix: z.string().default(""),
  /** The cosine below which a node is not similar, for this model (calibrated on the eval). */
  similarityFloor: z.number().min(-1).max(1).optional(),
  /** The model's output to pool. */
  output: z.string().default("last_hidden_state"),
  licence: z.string().min(1),
  /** Where the weights were taken from, for the SBOM. */
  source: z.string().min(1),
});
export type ModelManifest = z.infer<typeof ModelManifest>;

export async function readModelManifest(dir: string): Promise<ModelManifest> {
  const text = await readFile(join(dir, MODEL_MANIFEST), "utf8");
  return ModelManifest.parse(parse(text));
}

/** The sha256 of a file, read in a stream. */
export function fileSha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (b) => h.update(b))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

interface OrtTensorCtor {
  new (type: string, data: BigInt64Array, dims: number[]): unknown;
}
interface OrtSession {
  run(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, { data: Float32Array; dims: number[] }>>;
  inputNames: readonly string[];
}
interface Ort {
  InferenceSession: {
    create(m: string | Uint8Array, o: Record<string, unknown>): Promise<OrtSession>;
  };
  Tensor: OrtTensorCtor;
  env?: { wasm?: { numThreads?: number; wasmBinary?: Uint8Array } };
}

/** Load onnxruntime-node, from `runtimeDir` when given (the bundle's), else beside Atticus. */
async function loadOrt(
  name: "onnxruntime-node" | "onnxruntime-web",
  runtimeDir?: string,
): Promise<{ ort: Ort; dir: string }> {
  const req = createRequire(runtimeDir ? join(runtimeDir, "noop.js") : import.meta.url);
  // The package's folder, from its entry (onnxruntime-web doesn't export its package.json).
  const entry = req.resolve(name);
  const at = entry.lastIndexOf(`${sep}${name}${sep}`);
  if (at < 0) throw new Error(`${name} resolved outside a ${name} folder: ${entry}`);
  const dir = entry.slice(0, at + name.length + 1);
  if (name === "onnxruntime-node") {
    const m = (await import(pathToFileURL(join(dir, "dist", "index.js")).href)) as {
      default?: Ort;
    } & Ort;
    return { ort: m.default ?? m, dir };
  }
  const m = (await import(pathToFileURL(join(dir, "dist", "ort.wasm.min.mjs")).href)) as {
    default?: Ort;
  } & Ort;
  return { ort: m.default ?? m, dir };
}

export interface OnnxOptions {
  /** A folder whose node_modules holds onnxruntime-node (and onnxruntime-web). */
  runtimeDir?: string;
  /** Use the WASM build even where the native one loads (for tests of the fallback). */
  backend?: "native" | "wasm";
}

export class OnnxEmbedder implements Embedder {
  readonly id: string;
  readonly dim: number;
  readonly maxTokens: number;
  backend = "not loaded";
  readonly floor?: number;
  private session?: Promise<{ s: OrtSession; ort: Ort; tok: WordPieceConfig }>;

  constructor(
    readonly dir: string,
    readonly manifest: ModelManifest,
    private readonly o: OnnxOptions = {},
  ) {
    this.id = `${manifest.name}@${manifest.sha256.slice(0, 12)}`;
    this.dim = manifest.dim;
    this.maxTokens = manifest.maxTokens;
    if (manifest.similarityFloor !== undefined) this.floor = manifest.similarityFloor;
  }

  static async open(dir: string, o: OnnxOptions = {}): Promise<OnnxEmbedder> {
    return new OnnxEmbedder(dir, await readModelManifest(dir), o);
  }

  /** The model file is there and is the one the manifest names (its sha256). */
  async check(): Promise<{ ok: boolean; problem?: string }> {
    const file = join(this.dir, this.manifest.model);
    if (!existsSync(file)) return { ok: false, problem: `${file} isn't there` };
    const sha = await fileSha256(file);
    return sha === this.manifest.sha256
      ? { ok: true }
      : {
          ok: false,
          problem: `${file} has sha256 ${sha}, not the ${this.manifest.sha256} its manifest names`,
        };
  }

  private load() {
    this.session ??= (async () => {
      const c = await this.check();
      if (!c.ok) throw new Error(c.problem);
      const tok = wordPieceConfig(
        JSON.parse(await readFile(join(this.dir, this.manifest.tokenizer), "utf8")) as unknown,
      );
      const file = join(this.dir, this.manifest.model);
      let loaded: { ort: Ort; dir: string } | undefined;
      let s: OrtSession | undefined;
      if (this.o.backend !== "wasm") {
        try {
          loaded = await loadOrt("onnxruntime-node", this.o.runtimeDir);
          s = await loaded.ort.InferenceSession.create(file, {
            executionProviders: ["cpu"],
            graphOptimizationLevel: "all",
            intraOpNumThreads: 1,
          });
          this.backend = "native";
        } catch {
          s = undefined;
        }
      }
      if (!s) {
        loaded = await loadOrt("onnxruntime-web", this.o.runtimeDir);
        if (loaded.ort.env?.wasm) {
          loaded.ort.env.wasm.numThreads = 1;
          loaded.ort.env.wasm.wasmBinary = await readFile(
            join(loaded.dir, "dist", "ort-wasm-simd-threaded.wasm"),
          );
        }
        s = await loaded.ort.InferenceSession.create(await readFile(file), {
          executionProviders: ["wasm"],
        });
        this.backend = "wasm";
      }
      return { s, ort: loaded!.ort, tok };
    })();
    return this.session;
  }

  async embed(texts: string[], kind: EmbedKind): Promise<QuantVector[]> {
    const { s, ort, tok } = await this.load();
    const out: QuantVector[] = [];
    const prefix = kind === "query" ? this.manifest.queryPrefix : this.manifest.documentPrefix;
    for (const t of texts) {
      const ids = encode(`${prefix}${t}`, tok, this.maxTokens);
      const n = ids.length;
      const feeds: Record<string, unknown> = {
        input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, n]),
        attention_mask: new ort.Tensor("int64", new BigInt64Array(n).fill(1n), [1, n]),
      };
      if (s.inputNames.includes("token_type_ids"))
        feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(n), [1, n]);
      const r = await s.run(feeds);
      const h = r[this.manifest.output];
      if (!h) throw new Error(`the model has no output ${this.manifest.output}`);
      const d = h.dims.at(-1)!;
      const v = new Float64Array(d);
      if (this.manifest.pooling === "cls") for (let j = 0; j < d; j++) v[j] = h.data[j]!;
      else {
        for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) v[j] = v[j]! + h.data[i * d + j]!;
        for (let j = 0; j < d; j++) v[j] = v[j]! / n;
      }
      out.push(quantize(v));
    }
    return out;
  }
}

/** Whether a folder holds a model: its manifest and model file, and the file's size. */
export async function modelInfo(
  dir: string,
): Promise<{ ok: true; manifest: ModelManifest; bytes: number } | { ok: false; problem: string }> {
  try {
    const manifest = await readModelManifest(dir);
    const st = await stat(join(dir, manifest.model)).catch(() => undefined);
    if (!st) return { ok: false, problem: `${join(dir, manifest.model)} isn't there` };
    return { ok: true, manifest, bytes: st.size };
  } catch (e) {
    return {
      ok: false,
      problem: `${join(dir, MODEL_MANIFEST)}: ${(e as Error).message.split("\n")[0]}`,
    };
  }
}
