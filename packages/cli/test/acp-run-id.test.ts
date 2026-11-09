import { cp, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { acpStepRunner } from "../src/copilot-acp-steps.js";

/**
 * Review round 48 (tasks and Git host): a copilot-acp step claims its run's folder, as every
 * other run does (claimRunDir), so two steps that start in the same second with the same random
 * tail never share one: the second takes the next id.
 */

const tails = vi.hoisted(() => ({ next: [] as string[] }));
vi.mock("node:crypto", async (orig) => {
  const m = await orig<typeof import("node:crypto")>();
  return {
    ...m,
    randomBytes: ((n: number) => {
      const t = tails.next.shift();
      return t ? Buffer.from(t, "hex") : m.randomBytes(n);
    }) as typeof m.randomBytes,
  };
});

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");

describe("a copilot-acp step's run id (review round 48)", () => {
  it("claims its folder, so two steps in one second never share a run", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-acp-id-"));
    await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
    const now = () => new Date("2026-11-08T09:00:00Z");
    const runner = await acpStepRunner(root, {
      now,
      spawn: () => {
        throw new Error("no Copilot here");
      },
    });
    tails.next = ["aaaaaa", "aaaaaa", "bbbbbb"];
    const step = { line: "read the ledger", change: "map-forge-ledger", writeRoots: [] };
    await expect(runner(step)).rejects.toThrow("no Copilot here");
    await expect(runner(step)).rejects.toThrow("no Copilot here");
    expect((await readdir(join(root, ".runs/map-forge-ledger"))).sort()).toEqual([
      "run-20261108090000-aaaaaa",
      "run-20261108090000-bbbbbb",
    ]);
  });
});
