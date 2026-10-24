import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  embeddingState,
  encode,
  OnnxEmbedder,
  readModelManifest,
  wordPieceConfig,
} from "../src/index.js";

// ADR 0116: the local embedding model. Unit tests use invented files; the tests that load a real
// model run only where ATTICUS_EMBED_MODEL names a model folder (and ATTICUS_ORT_DIR a folder
// whose node_modules holds onnxruntime-node): an opt-in local check, never CI, no network.

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/retrieval/models");
const tiny = wordPieceConfig(JSON.parse(readFileSync(join(FIX, "tiny-tokenizer.json"), "utf8")));

const MANIFEST = (o: Record<string, unknown> = {}) =>
  [
    "schemaVersion: 1",
    "name: tiny-model",
    "dtype: fp32",
    "sha256: 2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
    "dim: 4",
    "maxTokens: 16",
    "pooling: mean",
    "licence: Apache-2.0",
    "source: invented for the tests",
    ...Object.entries(o).map(([k, v]) => `${k}: ${String(v)}`),
    "",
  ].join("\n");

async function modelDir(manifest: string, model = "foo"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-model-"));
  await writeFile(join(dir, "atticus-model.yaml"), manifest);
  await writeFile(join(dir, "model.onnx"), model);
  return dir;
}

describe("the WordPiece tokenizer", () => {
  it("cleans, lower-cases, strips accents, splits at punctuation and CJK, and spells each word longest first", () => {
    // [CLS] the renamed time ##stamp [SEP]
    expect(encode("The renamed TIMESTAMP", tiny, 32)).toEqual([2, 4, 5, 8, 9, 3]);
    // renames isn't in the vocabulary: rename, then ##s.
    expect(encode("renames", tiny, 32)).toEqual([2, 6, 19, 3]);
    expect(encode("Café, ledger-db.", tiny, 32)).toEqual([2, 10, 12, 13, 14, 15, 11, 3]);
    expect(encode("日本", tiny, 32)).toEqual([2, 16, 17, 3]);
    // A word it can't spell, and one longer than its limit, are unknown.
    expect(encode("zebra accountsaccounts", tiny, 32)).toEqual([2, 1, 1, 3]);
    // Cut at the limit, [SEP] kept.
    expect(encode("the the the the", tiny, 4)).toEqual([2, 4, 4, 3]);
  });

  it("reads only WordPiece tokenizers", () => {
    expect(() => wordPieceConfig({ model: { type: "BPE", vocab: {} } })).toThrow(
      /BPE, not WordPiece/,
    );
  });
});

describe("the model folder", () => {
  it("reads atticus-model.yaml, fp32 only", async () => {
    const m = await readModelManifest(await modelDir(MANIFEST({ similarityFloor: 0.25 })));
    expect(m).toMatchObject({
      name: "tiny-model",
      dtype: "fp32",
      pooling: "mean",
      similarityFloor: 0.25,
    });
    await expect(
      readModelManifest(await modelDir(MANIFEST().replace("dtype: fp32", "dtype: int8"))),
    ).rejects.toThrow();
  });

  it("checks the model file is the one the manifest names, by its sha256", async () => {
    const ok = await OnnxEmbedder.open(await modelDir(MANIFEST()));
    expect(ok.id).toBe("tiny-model@2c26b46b68ff");
    expect(await ok.check()).toEqual({ ok: true });
    const bad = await OnnxEmbedder.open(await modelDir(MANIFEST(), "bar"));
    expect((await bad.check()).problem).toMatch(/not the 2c26b46b.* its manifest names/);
    await expect(bad.embed(["x"], "query")).rejects.toThrow(/its manifest names/);
  });

  it("is off unless runtime.yaml turns it on; a folder that isn't there, or no bundled model, says why", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-embed-root-"));
    await mkdir(join(root, "org-pack"), { recursive: true });
    expect(await embeddingState(root)).toMatchObject({ setting: "off" });
    const runtime = (model: string) =>
      writeFile(
        join(root, "org-pack/runtime.yaml"),
        `schemaVersion: 1\nassistants: { allowed: [copilot], default: copilot }\nretrieval:\n  embeddings: { model: ${JSON.stringify(model)} }\n`,
      );
    await runtime("models/none");
    expect((await embeddingState(root)).problem).toMatch(/atticus-model.yaml/);
    await runtime("bundled");
    expect((await embeddingState(root)).problem).toMatch(
      /@maycombhq\/embed-model\) isn't installed/,
    );
    const dir = await modelDir(MANIFEST());
    await runtime(dir);
    expect(await embeddingState(root)).toMatchObject({
      setting: dir,
      dir,
      id: "tiny-model@2c26b46b68ff",
      licence: "Apache-2.0",
    });
  });
});

const MODEL = process.env.ATTICUS_EMBED_MODEL;
const ORT = process.env.ATTICUS_ORT_DIR;

describe.skipIf(!MODEL)("a real model on this machine (opt-in: ATTICUS_EMBED_MODEL)", () => {
  it("tokenizes as the model's own tokenizer does (golden token ids)", async () => {
    const m = await readModelManifest(MODEL!);
    const gold = parse(readFileSync(join(FIX, "token-ids.yaml"), "utf8")) as Record<
      string,
      { text: string; ids: number[] }[]
    >;
    const cfg = wordPieceConfig(JSON.parse(readFileSync(join(MODEL!, m.tokenizer), "utf8")));
    for (const g of gold[m.name] ?? []) expect(encode(g.text, cfg, 512), g.text).toEqual(g.ids);
  });

  it("gives the same vectors one text at a time and in a batch, and natively and in WASM", async () => {
    const texts = ["the renamed timestamp", "Settlement runbook › Cut-off times", "a"];
    const native = await OnnxEmbedder.open(MODEL!, ORT ? { runtimeDir: ORT } : {});
    const wasm = await OnnxEmbedder.open(MODEL!, {
      ...(ORT ? { runtimeDir: ORT } : {}),
      backend: "wasm",
    });
    const all = await native.embed(texts, "document");
    const one = [];
    for (const t of texts) one.push(...(await native.embed([t], "document")));
    const w = await wasm.embed(texts, "document");
    for (let i = 0; i < texts.length; i++) {
      expect(Array.from(one[i]!.q)).toEqual(Array.from(all[i]!.q));
      const same = all[i]!.q.filter((x, j) => x === w[i]!.q[j]).length / all[i]!.q.length;
      expect(same).toBeGreaterThanOrEqual(0.99);
    }
    expect(native.backend).toBe("native");
    expect(wasm.backend).toBe("wasm");
  }, 120_000);
});
