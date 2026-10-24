import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cosine, vectorFromText } from "@maycombhq/ai";
import { OnnxEmbedder } from "@maycombhq/embed";
import { recordedVectors, recordRetrievalVectors } from "../src/index.js";

// ADR 0116: the golden vectors the eval replays are what the real model gives on this machine.
// Opt-in and local (ATTICUS_EMBED_MODEL: a model folder; ATTICUS_ORT_DIR: a folder whose
// node_modules holds onnxruntime-node), since the model file isn't in the repo; never in CI.

const FX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const MODEL = process.env.ATTICUS_EMBED_MODEL;
const ORT = process.env.ATTICUS_ORT_DIR;

describe.skipIf(!MODEL)("the recorded vectors (opt-in: ATTICUS_EMBED_MODEL)", () => {
  it("are what the model gives again: at least 99.9% of components equal, each cosine 0.9999 or more", async () => {
    const e = await OnnxEmbedder.open(MODEL!, ORT ? { runtimeDir: ORT } : {});
    const golden = recordedVectors(FX, e.manifest.name);
    expect(golden, `no fixtures/retrieval/vectors/${e.manifest.name}.json`).toBeDefined();
    const fresh = await recordRetrievalVectors(FX, e);
    expect(fresh.model).toBe(golden!.model);
    let equal = 0;
    let all = 0;
    for (const kind of ["document", "query"] as const) {
      expect(Object.keys(fresh[kind]).sort()).toEqual(Object.keys(golden![kind]).sort());
      for (const [sha, g] of Object.entries(golden![kind])) {
        const a = vectorFromText(g);
        const b = vectorFromText(fresh[kind][sha]!);
        all += a.q.length;
        equal += a.q.filter((x, i) => x === b.q[i]).length;
        expect(cosine(a, b) / Math.sqrt(cosine(a, a) * cosine(b, b))).toBeGreaterThanOrEqual(
          0.9999,
        );
      }
    }
    expect(equal / all).toBeGreaterThanOrEqual(0.999);
  }, 600_000);
});
