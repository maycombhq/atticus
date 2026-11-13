import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  BUILD_PASSES,
  buildAndWrite,
  buildCacheHooks,
  buildCatalog,
  loadBuildInputs,
} from "../src/index.js";

/**
 * Beta.28.1 ("nothing slow runs silently"): the build says each of its passes as it starts one
 * (`onPass`), and buildAndWrite each of its steps (`onStep`), so a write of a large estate shows
 * where it is. The hooks only listen: a build with them is the build without them. On the
 * invented Forge metarepo with every golden slot.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const SLOTS = join(FORGE, "slots");
const T = 180_000;
const made: string[] = [];
afterAll(async () => {
  buildCacheHooks.off = false;
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

async function forge(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-build-progress-"));
  made.push(root);
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await writeFile(join(root, "org-pack/sources.yaml"), "schemaVersion: 1\nwikis: []\n");
  await cp(join(FORGE, "inputs"), join(root, "inputs"), { recursive: true });
  for (const d of ["readers", "facts", "legacy"])
    await cp(join(SLOTS, d), join(root, "catalog/sources", d), { recursive: true });
  return root;
}

describe("the build says its passes and steps (beta.28.1)", () => {
  it(
    "calls onPass once per pass, in order, awaiting each, and builds the same catalog",
    async () => {
      const root = await forge();
      buildCacheHooks.off = true;
      try {
        const heard: [number, number, string][] = [];
        let waited = 0;
        const withHook = await buildCatalog(await loadBuildInputs(root), {
          onPass: async (n, of, what) => {
            heard.push([n, of, what]);
            await new Promise((r) => setTimeout(r, 1));
            waited++;
          },
        });
        expect(heard.map((h) => h[0])).toEqual(BUILD_PASSES.map((_, i) => i + 1));
        expect(heard.every((h) => h[1] === BUILD_PASSES.length)).toBe(true);
        expect(heard.map((h) => h[2])).toEqual([...BUILD_PASSES]);
        expect(waited).toBe(BUILD_PASSES.length);
        const without = await buildCatalog(await loadBuildInputs(root));
        expect([...withHook.files]).toEqual([...without.files]);
      } finally {
        buildCacheHooks.off = false;
      }
    },
    T,
  );

  it(
    "stops between passes when onPass throws, writing nothing",
    async () => {
      const root = await forge();
      buildCacheHooks.off = true;
      try {
        const stop = new Error("stopped");
        await expect(
          buildCatalog(await loadBuildInputs(root), {
            onPass: (n) => {
              if (n === 3) throw stop;
            },
          }),
        ).rejects.toBe(stop);
      } finally {
        buildCacheHooks.off = false;
      }
    },
    T,
  );

  it(
    "buildAndWrite says its steps before the write, with the files it writes",
    async () => {
      const root = await forge();
      const steps: { step: string; files?: number }[] = [];
      const r = await buildAndWrite(root, {
        command: "atticus catalog build",
        onStep: (s) => {
          steps.push(s);
        },
      });
      expect(r.guard.refused).toBeUndefined();
      expect(steps.map((s) => s.step)).toEqual(["build", "check", "guard", "write"]);
      expect(steps.at(-1)!.files).toBe(r.build.files.size);
    },
    T,
  );

  it(
    "a refused or stopped buildAndWrite never reaches its write step",
    async () => {
      const root = await forge();
      const stop = new Error("stopped");
      await expect(
        buildAndWrite(root, {
          command: "atticus catalog build",
          onStep: (s) => {
            if (s.step === "write") throw stop;
          },
        }),
      ).rejects.toBe(stop);
      // Nothing was written: the next build still has everything to write.
      const steps: string[] = [];
      const again = await buildAndWrite(root, {
        command: "atticus catalog build",
        check: true,
        onStep: (s) => {
          steps.push(s.step);
        },
      });
      expect(again.upToDate).toBe(false);
      // A check writes nothing, so it has no write step.
      expect(steps).not.toContain("write");
    },
    T,
  );
});
