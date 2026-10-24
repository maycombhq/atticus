import { createHash } from "node:crypto";
import { identifierWords } from "@maycombhq/core";

/**
 * The embedder (contract C5, ADR 0116): a model that turns a text into a vector, run on the
 * person's own machine. Atticus ships one small model (`@maycombhq/embed`, ONNX on the CPU); the
 * tests use `HashEmbedder`. A vector is kept as int8 with one scale, so scoring is an integer dot
 * product and the same stored vectors rank the same on every machine. Similarity only ranks what
 * goes into a prompt: it never makes a link, resolves a name, closes a gap or becomes a fact.
 */

/** A unit vector as int8: v ≈ q × scale, with q = round(v / max|v| × 127). */
export interface QuantVector {
  q: Int8Array;
  scale: number;
}

/** What is embedded: a query (the step's input, a search) or a document (a node's text). */
export type EmbedKind = "query" | "document";

export interface Embedder {
  /** The model and its file's hash, e.g. "arctic-embed-xs@1a2b3c4d5e6f": vectors are keyed by it. */
  readonly id: string;
  readonly dim: number;
  /** Tokens the model reads from one text; the rest is cut. */
  readonly maxTokens: number;
  /** The cosine below which a node is not similar, for this model (default: the index's). */
  readonly floor?: number;
  /** native (onnxruntime-node), wasm (onnxruntime-web) or mock. */
  readonly backend: string;
  embed(texts: string[], kind: EmbedKind): Promise<QuantVector[]>;
}

/** A float vector, L2-normalised, as int8 with its scale. */
export function quantize(v: ArrayLike<number>): QuantVector {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  let max = 0;
  for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i]! / norm));
  const q = new Int8Array(v.length);
  if (max === 0) return { q, scale: 0 };
  for (let i = 0; i < v.length; i++) q[i] = Math.round((v[i]! / norm / max) * 127);
  return { q, scale: max / 127 };
}

/** The integer dot product of two int8 vectors: exact on every machine. */
export function dotInt8(a: Int8Array, b: Int8Array, bOffset = 0): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[bOffset + i]!;
  return s;
}

/** The cosine of two quantised unit vectors. */
export const cosine = (a: QuantVector, b: QuantVector) => dotInt8(a.q, b.q) * a.scale * b.scale;

/** A vector as text (base64 of the int8 bytes), for golden files. */
export const vectorToText = (v: QuantVector) => ({
  q: Buffer.from(v.q.buffer, v.q.byteOffset, v.q.byteLength).toString("base64"),
  scale: v.scale,
});
export function vectorFromText(t: { q: string; scale: number }): QuantVector {
  const b = Buffer.from(t.q, "base64");
  return { q: new Int8Array(b.buffer, b.byteOffset, b.byteLength), scale: t.scale };
}

/** sha256 of a text, hex: what a vector is keyed by beside the model's id. */
export const textSha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Vectors a real model gave, kept to be replayed without it: by kind, then text sha. */
export interface RecordedVectors {
  /** The model's id (name@sha). */
  model: string;
  dim: number;
  maxTokens: number;
  floor?: number;
  document: Record<string, { q: string; scale: number }>;
  query: Record<string, { q: string; scale: number }>;
}

/**
 * The replay embedder (ADR 0116), as the replay runtime is for model output: the vectors a real
 * model gave each text once, recorded with the model, replayed in CI where the model file
 * isn't. A text it has no vector for is an error that says to record again.
 */
export class RecordedEmbedder implements Embedder {
  readonly backend = "recorded";
  readonly id: string;
  readonly dim: number;
  readonly maxTokens: number;
  readonly floor?: number;
  constructor(private readonly r: RecordedVectors) {
    this.id = r.model;
    this.dim = r.dim;
    this.maxTokens = r.maxTokens;
    if (r.floor !== undefined) this.floor = r.floor;
  }
  async embed(texts: string[], kind: EmbedKind): Promise<QuantVector[]> {
    return texts.map((t) => {
      const v = this.r[kind][textSha(t)];
      if (!v)
        throw new Error(
          `no recorded ${kind} vector for "${t.slice(0, 60)}" (${textSha(t).slice(0, 12)}): record the vectors again with the model`,
        );
      return vectorFromText(v);
    });
  }
}

/**
 * The tests' embedder: feature hashing of a text's words (and an identifier's words) and their
 * three-letter pieces into `dim` buckets. Deterministic, instant, no model: two texts that share
 * words are close, two that don't are not. It knows no meaning; it stands in for the model's
 * shape in tests (ADR 0116).
 */
export class HashEmbedder implements Embedder {
  readonly backend = "mock";
  readonly maxTokens = 512;
  calls = 0;
  embedded = 0;
  constructor(
    readonly dim = 256,
    readonly id = `hash-embedder@${dim}`,
  ) {}

  async embed(texts: string[], _kind: EmbedKind): Promise<QuantVector[]> {
    this.calls++;
    this.embedded += texts.length;
    return texts.map((t) => quantize(this.vector(t)));
  }

  private vector(text: string): Float64Array {
    const v = new Float64Array(this.dim);
    const bucket = (s: string) => {
      const h = createHash("sha256").update(s, "utf8").digest();
      return { i: h.readUInt32BE(0) % this.dim, sign: h[4]! & 1 ? 1 : -1 };
    };
    for (const m of text.matchAll(/[A-Za-z0-9]+/g)) {
      const words = [m[0].toLowerCase(), ...identifierWords(m[0])];
      for (const w of new Set(words)) {
        if (w.length < 3) continue;
        const b = bucket(`w:${w}`);
        v[b.i] = v[b.i]! + b.sign * 2;
        for (let i = 0; i + 3 <= w.length; i++) {
          const g = bucket(`g:${w.slice(i, i + 3)}`);
          v[g.i] = v[g.i]! + g.sign;
        }
      }
    }
    return v;
  }
}
