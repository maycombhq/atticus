import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appMemoryHeld,
  forgetFactsParses,
  parseFacts,
  releaseAppMemory,
  startAppMemory,
  stopAppMemory,
  appMemory,
} from "@maycombhq/core";
import {
  buildCacheDirOf,
  buildCacheHooks,
  buildCacheStats,
  keepBuild,
  loadKept,
  loadReadersTrust,
  stageKept,
} from "../src/build-cache.js";

/**
 * ADR 0205 step 4, the review of beta.30's slice 10: what the build cache keeps in the app's
 * server's memory is let go by the app's rule (core's app-memory.ts) too: its facts parses not
 * yet on disk (up to 256 MB), and the last build's texts, which are kept only up to a size.
 */
const dirs: string[] = [];
afterEach(async () => {
  while (appMemory.on) stopAppMemory();
  forgetFactsParses();
  delete buildCacheHooks.stamp;
  delete buildCacheHooks.textsMaxBytes;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const fact = (id: string) =>
  JSON.stringify({
    kind: "entry",
    id,
    repo: "forge-svc-00",
    commit: "1111aaa",
    verified: "line",
    by: "assistant",
    conf: "declared",
    entryType: "rest",
    method: "GET",
    path: `/v1/${id}`,
    handler: "C.get",
    cite: { file: "src/C.java", line: 1, value: `/v1/${id}`, quote: `@GetMapping("/v1/${id}")` },
  });

const FRESH = "facts parses not yet on disk (the build cache's)";
const TEXTS = "the last build's texts (the build cache's)";

describe("the build cache's memory in the app's server (ADR 0205 step 4)", () => {
  it("lets its facts parses not yet on disk go by the app's rule", async () => {
    const state = await mkdtemp(join(tmpdir(), "atticus-app-keepers-"));
    dirs.push(state);
    buildCacheHooks.stamp = "c".repeat(64);
    startAppMemory();
    await loadReadersTrust(state);
    parseFacts(`${fact("e-a")}\n`);
    expect(appMemoryHeld()[FRESH]).toBeGreaterThan(0);
    releaseAppMemory();
    expect(appMemoryHeld()[FRESH]).toBe(0);
    // Let go, so none is written with the next build: a cache not written is no cache.
    await keepBuild({ records: [], files: new Map<string, string>() });
    expect(await readdir(join(buildCacheDirOf(state), "facts")).catch(() => [])).toEqual([]);
  });

  it("keeps the last build's texts in memory only up to its size limit", async () => {
    const state = await mkdtemp(join(tmpdir(), "atticus-app-keepers-"));
    dirs.push(state);
    buildCacheHooks.stamp = "d".repeat(64);
    startAppMemory();
    const kept = async (key: string, text: string) => {
      const build = {
        records: [{ kind: "Endpoint", id: key }],
        files: new Map([[`a/${key}.yaml`, text]]),
      };
      stageKept(build, state, key, new Map([[`a/${key}.yaml`, `json-of-${key}`]]));
      await keepBuild(build);
    };
    await kept("k1", "x".repeat(1000));
    expect(appMemoryHeld()[TEXTS]).toBe(1000);
    const from = buildCacheStats().textsFromMemory;
    const small = await loadKept(state, "another key");
    expect(buildCacheStats().textsFromMemory - from, "taken from memory").toBe(1);
    expect(small.texts?.get("json-of-k1")).toBe("x".repeat(1000));
    // Over the limit: not kept in memory; the next build reads the texts from disk, as before.
    buildCacheHooks.textsMaxBytes = 500;
    await kept("k2", "y".repeat(1000));
    expect(appMemoryHeld()[TEXTS] ?? 0).toBe(0);
    const again = buildCacheStats().textsFromMemory;
    const big = await loadKept(state, "yet another key");
    expect(buildCacheStats().textsFromMemory - again, "read from disk").toBe(0);
    expect(big.texts?.get("json-of-k2")).toBe("y".repeat(1000));
  });
});
