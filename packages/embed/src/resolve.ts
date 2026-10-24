import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { orgPackDirOf, Runtime } from "@maycombhq/core";
import type { Embedder } from "@maycombhq/ai";
import { modelInfo, OnnxEmbedder } from "./model.js";

/**
 * Which embedding model a metarepo uses (ADR 0116), from runtime.yaml's `retrieval.embeddings`:
 * off (the default), `bundled` (the @maycombhq/embed-model package the offline bundle carries)
 * or a model folder. The embedder is made only when the model is there; otherwise the state says
 * why, for `atticus doctor` and the selection's note.
 */

export interface EmbeddingState {
  /** What runtime.yaml says: off, bundled or a folder. */
  setting: string;
  /** The model folder it resolves to. */
  dir?: string;
  /** The model's id (name@sha), when its manifest was read. */
  id?: string;
  /** The model file's size in bytes. */
  bytes?: number;
  licence?: string;
  /** Why there is no embedder. */
  problem?: string;
}

/** The folder of the bundled model package, if it is installed. */
export function bundledModelDir(runtimeDir?: string): string | undefined {
  try {
    const req = createRequire(runtimeDir ? join(runtimeDir, "noop.js") : import.meta.url);
    return join(req.resolve("@maycombhq/embed-model/package.json"), "..");
  } catch {
    return undefined;
  }
}

async function settingsOf(root: string): Promise<{ model: string; runtime?: string }> {
  const text = await readFile(join(orgPackDirOf(root), "runtime.yaml"), "utf8").catch(
    () => undefined,
  );
  if (!text) return { model: "off" };
  const r = Runtime.safeParse(parse(text));
  const e = r.success ? r.data.retrieval?.embeddings : undefined;
  return e ? { model: e.model, ...(e.runtime ? { runtime: e.runtime } : {}) } : { model: "off" };
}

export async function embeddingState(root: string): Promise<EmbeddingState> {
  const s = await settingsOf(root);
  if (s.model === "off") return { setting: "off", problem: "retrieval.embeddings.model is off" };
  const base = orgPackDirOf(root);
  const runtimeDir = s.runtime ? resolve(base, s.runtime) : undefined;
  const dir =
    s.model === "bundled"
      ? bundledModelDir(runtimeDir)
      : isAbsolute(s.model)
        ? s.model
        : resolve(base, s.model);
  if (!dir)
    return {
      setting: s.model,
      problem: "the bundled model (@maycombhq/embed-model) isn't installed",
    };
  const info = await modelInfo(dir);
  if (!info.ok) return { setting: s.model, dir, problem: info.problem };
  return {
    setting: s.model,
    dir,
    id: `${info.manifest.name}@${info.manifest.sha256.slice(0, 12)}`,
    bytes: info.bytes,
    licence: info.manifest.licence,
  };
}

/** Which ONNX runtime would run the model, without loading it: native, wasm, or neither. */
export async function runtimeAvailable(root: string): Promise<"native" | "wasm" | undefined> {
  const s = await settingsOf(root);
  const dir = s.runtime ? resolve(orgPackDirOf(root), s.runtime) : undefined;
  const req = createRequire(dir ? join(dir, "noop.js") : import.meta.url);
  for (const [name, kind] of [
    ["onnxruntime-node", "native"],
    ["onnxruntime-web", "wasm"],
  ] as const)
    try {
      req.resolve(name);
      return kind;
    } catch {
      // not installed here
    }
  return undefined;
}

/** The metarepo's embedder, or undefined with the state saying why. */
export async function embedderFor(
  root: string,
): Promise<{ embedder?: Embedder; state: EmbeddingState }> {
  const state = await embeddingState(root);
  if (!state.dir || state.problem) return { state };
  const s = await settingsOf(root);
  const runtimeDir = s.runtime ? resolve(orgPackDirOf(root), s.runtime) : undefined;
  return {
    embedder: await OnnxEmbedder.open(state.dir, runtimeDir ? { runtimeDir } : {}),
    state,
  };
}
