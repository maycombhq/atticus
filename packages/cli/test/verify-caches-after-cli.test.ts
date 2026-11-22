import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { afterResultPending, readLock } from "@maycombhq/core";
import { buildAndWrite } from "@maycombhq/scanner";
import { main } from "../src/main.js";
import { BIG_COMMIT, bigRepoId, makeBigEstate, writeBigRepo } from "./big-estate.js";

/**
 * ADR 0205 step 2, the command line's side (the review of beta.30's slice 10): `atticus verify
 * <repo> --write` prints its lines, then writes its local caches (the build kept, the written
 * texts' parses), still under the scan's lock, and only then ends. Before, only the app's Apply
 * did; the command wrote them before its result. Invented Forge estate (CLAUDE.md rule 3).
 */
const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

/** The key of the build the build cache keeps (its header line), or undefined. */
const keptKey = (root: string) =>
  readFile(join(root, ".index", "build-cache", "last-build.jsonl"), "utf8").then(
    (t) => (JSON.parse(t.slice(0, t.indexOf("\n"))) as { key: string }).key,
    () => undefined,
  );

describe("atticus verify <repo> --write: its lines, then its caches (ADR 0205 step 2)", () => {
  it("prints its lines before it writes its caches, and ends once they are written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-verify-caches-"));
    made.push(dir);
    const { root, options } = await makeBigEstate(dir, {
      repos: 3,
      entries: 12,
      calls: 8,
      tables: 3,
      settings: 6,
      seed: 3,
      checkouts: 3,
    });
    const cold = await buildAndWrite(root, { command: "atticus catalog build" });
    expect(cold.guard.refused).toBeUndefined();
    const before = await keptKey(root);
    expect(before).toBeDefined();
    await writeBigRepo(root, 1, options, 2, true, false);
    const repo = bigRepoId(1);
    // What the build cache kept when each line was printed, read as it was printed.
    const seen: (string | undefined)[] = [];
    const lines: string[] = [];
    const keptNow = () => {
      try {
        const t = readFileSync(join(root, ".index", "build-cache", "last-build.jsonl"), "utf8");
        return (JSON.parse(t.slice(0, t.indexOf("\n"))) as { key: string }).key;
      } catch {
        return undefined;
      }
    };
    const io = {
      out: (l: string) => {
        lines.push(l);
        seen.push(keptNow());
      },
      err: (l: string) => void lines.push(l),
    };
    const code = await main(
      ["verify", repo, "--write", "--commit", BIG_COMMIT, "--root", root],
      io,
    );
    expect(code, lines.join("\n")).toBe(0);
    // Every line was printed with the caches still to write: the build kept was the last one.
    expect(seen.length, lines.join("\n")).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([before]));
    // The command ended once they were written: nothing pending, the lock let go, the new build kept.
    expect(afterResultPending()).toBe(0);
    expect(await readLock(root, "scan")).toBeUndefined();
    const after = await keptKey(root);
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  }, 300_000);
});
