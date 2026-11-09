import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { embedderFor, embeddingState, runtimeAvailable } from "../src/index.js";

/**
 * Review round 50 (getting started): a runtime.yaml with a YAML syntax error crashed atticus
 * doctor here. It reads as unconfigured; the org pack check is what says the file is broken.
 */

const made: string[] = [];
afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

describe("a runtime.yaml that isn't YAML (round 50, 4)", () => {
  it("reads as unconfigured, never throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-embed-r50-"));
    made.push(root);
    await mkdir(join(root, "org-pack"), { recursive: true });
    await writeFile(
      join(root, "org-pack/runtime.yaml"),
      "schemaVersion: 1\nassistants: { allowed: [copilot, default: copilot\n",
    );
    expect(await embeddingState(root)).toMatchObject({ configured: false });
    expect([undefined, "native", "wasm"]).toContain(await runtimeAvailable(root));
    expect((await embedderFor(root)).embedder).toBeUndefined();
    const was = process.env.ATTICUS_EMBEDDINGS;
    delete process.env.ATTICUS_EMBEDDINGS;
    try {
      expect(await embeddingState(root)).toMatchObject({ setting: "bundled", configured: false });
    } finally {
      if (was === undefined) delete process.env.ATTICUS_EMBEDDINGS;
      else process.env.ATTICUS_EMBEDDINGS = was;
    }
  });
});
