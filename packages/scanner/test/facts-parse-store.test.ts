import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { factsParseHooks, factsParseStats, forgetFactsParses, parseFacts } from "@maycombhq/core";
import {
  buildCacheDirOf,
  factsParseStore,
  keepBuild,
  loadReadersTrust,
} from "../src/build-cache.js";

/**
 * ADR 0205 step 3: a facts file is parsed once for its bytes, in this process and, through the
 * build cache's store, in the next one. The same bytes give the same parse, a copy each time;
 * other bytes, another code or an entry that doesn't read are no hit.
 */
const fact = (id: string, line: number) =>
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
    cite: { file: "src/C.java", line, value: `/v1/${id}`, quote: `@GetMapping("/v1/${id}")` },
  });

const text = [fact("e-a", 1), fact("e-b", 2)].join("\n") + "\n";

const dirs: string[] = [];
afterEach(async () => {
  forgetFactsParses();
  delete factsParseHooks.off;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("facts parsed once for their bytes (ADR 0205 step 3)", () => {
  it("gives the parse of the text, a fresh copy each time, and misses on another byte", () => {
    forgetFactsParses();
    const was = { ...factsParseStats };
    const a = parseFacts(text);
    const b = parseFacts(text);
    expect(factsParseStats.parsed - was.parsed).toBe(1);
    expect(factsParseStats.kept - was.kept).toBe(1);
    factsParseHooks.off = true;
    const fresh = parseFacts(text);
    delete factsParseHooks.off;
    expect(isDeepStrictEqual(a, fresh)).toBe(true);
    expect(isDeepStrictEqual(b, fresh)).toBe(true);
    expect(b).not.toBe(a);
    if (a.ok && b.ok) {
      (a.facts[0] as { id: string }).id = "changed by a caller";
      expect(b.facts[0]!.id).toBe("e-a");
      expect((parseFacts(text) as typeof b).facts[0]!.id).toBe("e-a");
    } else throw new Error("the facts don't read");
    const other = text.replace("e-b", "e-c");
    parseFacts(other);
    expect(factsParseStats.parsed - was.parsed).toBe(2);
  });

  it("keeps the parses a build used on disk for the next process, and ignores one that doesn't read", async () => {
    const state = await mkdtemp(join(tmpdir(), "atticus-facts-store-"));
    dirs.push(state);
    await loadReadersTrust(state);
    forgetFactsParses();
    parseFacts(text);
    const build = { records: [], files: new Map<string, string>() };
    await keepBuild(build);
    // keepBuild keeps the readers and facts it used even with no build staged.
    const dir = join(buildCacheDirOf(state), "facts");
    const names = await readdir(dir);
    expect(names).toHaveLength(1);
    // The next process: nothing in memory, the store's copy read.
    forgetFactsParses();
    await loadReadersTrust(state);
    const was = { ...factsParseStats };
    const again = parseFacts(text);
    expect(factsParseStats.kept - was.kept).toBe(1);
    factsParseHooks.off = true;
    expect(isDeepStrictEqual(again, parseFacts(text))).toBe(true);
    delete factsParseHooks.off;
    // An entry that doesn't read is no entry: the text is parsed.
    await writeFile(join(dir, names[0]!), "not a v8 value");
    forgetFactsParses();
    await loadReadersTrust(state);
    const before = { ...factsParseStats };
    expect(isDeepStrictEqual(parseFacts(text), again)).toBe(true);
    expect(factsParseStats.parsed - before.parsed).toBe(1);
    expect(factsParseStore).toBeDefined();
  });
});
