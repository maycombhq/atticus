import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { CancelledError, commitCurrent, filePoolHooks, withSignal } from "@maycombhq/core";
import {
  BUILD_PASSES,
  BUILD_STAGES,
  buildAndWrite,
  buildCacheHooks,
  buildCatalog,
  buildTickHooks,
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
    "gives way inside the long passes (tick): the same catalog, and a throw there stops it",
    async () => {
      const root = await forge();
      buildCacheHooks.off = true;
      try {
        // Ticks heard, by the pass they came in.
        const ticks = new Map<number, number>();
        let at = 0;
        const withTick = await buildCatalog(await loadBuildInputs(root), {
          onPass: (n) => {
            at = n;
          },
          tick: async () => {
            ticks.set(at, (ticks.get(at) ?? 0) + 1);
            await new Promise((r) => setImmediate(r));
          },
        });
        // The estate projection and join (pass 2), and each repo's flows (pass 7).
        expect(ticks.get(2)).toBeGreaterThan(0);
        expect(ticks.get(7)).toBeGreaterThan(0);
        const without = await buildCatalog(await loadBuildInputs(root));
        expect([...withTick.files]).toEqual([...without.files]);
        // A Stop heard at a tick of pass 2 ends the build there: pass 3 never starts.
        const stop = new Error("stopped");
        const passes: number[] = [];
        await expect(
          buildCatalog(await loadBuildInputs(root), {
            onPass: (n) => void passes.push(n),
            tick: () => Promise.reject(stop),
          }),
        ).rejects.toBe(stop);
        expect(passes).toEqual([1, 2]);
      } finally {
        buildCacheHooks.off = false;
      }
    },
    T,
  );

  it(
    "names the stages inside its passes (onStage), awaiting each, and builds the same catalog",
    async () => {
      // Beta.28.4 (the owner's field report: pass 3 ran for minutes with no line): a pass of
      // several stages says each as it starts, so the last line said names what is running.
      const root = await forge();
      buildCacheHooks.off = true;
      try {
        const heard: [number, number, string, string][] = [];
        let waited = 0;
        const passes: number[] = [];
        const withHook = await buildCatalog(await loadBuildInputs(root), {
          onPass: (n) => void passes.push(n),
          onStage: async (n, of, what, stage) => {
            // A stage is said inside the pass it is of, after that pass was.
            expect(passes.at(-1)).toBe(n);
            heard.push([n, of, what, stage]);
            await new Promise((r) => setTimeout(r, 1));
            waited++;
          },
        });
        expect(waited).toBe(heard.length);
        expect(
          heard.every((h) => h[1] === BUILD_PASSES.length && h[2] === BUILD_PASSES[h[0] - 1]),
        ).toBe(true);
        const of = (n: number) => heard.filter((h) => h[0] === n).map((h) => h[3]);
        // No federated catalog here, so pass 3 names no such stage.
        expect(of(3)).toEqual([
          "the merge",
          "intake",
          "each repo's records after the merge",
          "the features",
          "the glossary",
        ]);
        // A stage is said only when it runs: no shared map is on file here.
        expect(of(4)).toEqual(["link evidence"]);
        expect(of(8)).toEqual(["the record files", "build.json"]);
        // Each is one of the stages the build lists for its pass.
        for (const [n, , , stage] of heard) expect(BUILD_STAGES[n]).toContain(stage);
        const without = await buildCatalog(await loadBuildInputs(root));
        expect([...withHook.files]).toEqual([...without.files]);
        expect(withHook.manifest).toEqual(without.manifest);
      } finally {
        buildCacheHooks.off = false;
      }
    },
    T,
  );

  it(
    "stops at a stage when onStage throws, and gives way (tick) at each stage of passes 3 to 6",
    async () => {
      const root = await forge();
      buildCacheHooks.off = true;
      try {
        const stop = new Error("stopped");
        const passes: number[] = [];
        const stages: string[] = [];
        await expect(
          buildCatalog(await loadBuildInputs(root), {
            onPass: (n) => void passes.push(n),
            onStage: (_n, _of, _what, stage) => {
              stages.push(stage);
              if (stage === "the glossary") throw stop;
            },
          }),
        ).rejects.toBe(stop);
        // The glossary never ran, and pass 4 never started.
        expect(passes).toEqual([1, 2, 3]);
        expect(stages.at(-1)).toBe("the glossary");
        // With no onStage, a Stop is still heard there: the build gives way at each stage, and
        // inside the loops over the legacy records and the record files (here at every turn;
        // a build does once a loop has run a tenth of a second).
        const ticks = new Map<number, number>();
        let at = 0;
        buildTickHooks.everyMs = 0;
        const withTicks = await buildCatalog(await loadBuildInputs(root), {
          onPass: (n) => {
            at = n;
          },
          tick: async () => {
            ticks.set(at, (ticks.get(at) ?? 0) + 1);
          },
        });
        expect(ticks.get(3)).toBeGreaterThanOrEqual(5);
        expect(ticks.get(4)).toBeGreaterThanOrEqual(1);
        // The legacy records (pass 5) give way as they are read.
        expect(ticks.get(5)).toBeGreaterThan(0);
        expect(ticks.get(8)).toBeGreaterThan(withTicks.files.size);
        delete buildTickHooks.everyMs;
        const without = await buildCatalog(await loadBuildInputs(root));
        expect([...withTicks.files]).toEqual([...without.files]);
        expect(withTicks.retired).toEqual(without.retired);
        // A Stop heard among the legacy records ends the build there: pass 6 never starts.
        buildTickHooks.everyMs = 0;
        const later: number[] = [];
        await expect(
          buildCatalog(await loadBuildInputs(root), {
            onPass: (n) => void later.push(n),
            tick: () => (later.at(-1) === 5 ? Promise.reject(stop) : Promise.resolve()),
          }),
        ).rejects.toBe(stop);
        expect(later).toEqual([1, 2, 3, 4, 5]);
      } finally {
        delete buildTickHooks.everyMs;
        buildCacheHooks.off = false;
      }
    },
    T,
  );

  it(
    "buildAndWrite gives way inside its build too (tick), and a Stop there writes nothing, with the build cache on",
    async () => {
      // Beta.28.4: `atticus catalog build` heard Stop only between passes. The build cache is
      // on, as a person's build has it: a build stopped part way keeps nothing of itself.
      const root = await forge();
      const stop = new Error("stopped");
      buildTickHooks.everyMs = 0;
      try {
        const passes: number[] = [];
        const steps: string[] = [];
        await expect(
          buildAndWrite(root, {
            command: "atticus catalog build",
            onStep: (s) => void steps.push(s.step),
            onPass: (n) => void passes.push(n),
            tick: () => (passes.at(-1) === 5 ? Promise.reject(stop) : Promise.resolve()),
          }),
        ).rejects.toBe(stop);
        // Stopped among the legacy records: pass 6 never started, and no step after the build.
        expect(passes).toEqual([1, 2, 3, 4, 5]);
        expect(steps).toEqual(["build"]);
        await expect(readdir(join(root, "catalog/generated"))).rejects.toThrow();
        // The next build runs every pass (nothing was kept of the stopped one) and writes what
        // a build that was never stopped writes.
        const again: number[] = [];
        let ticks = 0;
        const r = await buildAndWrite(root, {
          command: "atticus catalog build",
          onPass: (n) => void again.push(n),
          tick: async () => {
            ticks++;
          },
        });
        expect(again).toEqual(BUILD_PASSES.map((_, i) => i + 1));
        expect(ticks).toBeGreaterThan(0);
        expect(r.guard.refused).toBeUndefined();
        const other = await forge();
        delete buildTickHooks.everyMs;
        const plain = await buildAndWrite(other, { command: "atticus catalog build" });
        expect([...r.build.files]).toEqual([...plain.build.files]);
        // A build of the same inputs is then the one kept, whole: no pass runs, nothing to stop.
        // (The first write changed a slot the build reads, the legacy joins: built until
        // nothing changes first.)
        for (let n = 0, w = r.write; n < 3 && w && (w.written || w.slots.length); n++)
          w = (await buildAndWrite(root, { command: "atticus catalog build" })).write;
        const third: number[] = [];
        await buildAndWrite(root, {
          command: "atticus catalog build",
          onPass: (n) => void third.push(n),
          tick: () => Promise.reject(stop),
        });
        expect(third).toEqual([]);
      } finally {
        delete buildTickHooks.everyMs;
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

/**
 * Beta.28.3: Stop during the read of every file of the catalog (the `check` step). It was heard
 * only when the next step started, after every file had been read and hashed. With the job's
 * signal the read ends part way, in workers or in this thread, and buildAndWrite fails with
 * CancelledError before its guards: catalog/ is byte for byte as it was. On the Forge metarepo
 * with 3,000 more record files generated into its catalog, so the read is of many files.
 */
describe("Stop during the read of the catalog's files (beta.28.3)", () => {
  const MANY = 3_000;
  afterEach(() => {
    delete filePoolHooks.onRead;
    delete filePoolHooks.workers;
    delete filePoolHooks.minFiles;
  });

  /** Every file under `dir` with the hash of its bytes. */
  async function tree(dir: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const walk = async (d: string, rel: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(d, e.name), r);
        else
          out[r] = createHash("sha256")
            .update(await readFile(join(d, e.name)))
            .digest("hex");
      }
    };
    await walk(dir, "");
    return out;
  }

  /** Forge built once, then a facts file's meta changed (a build to write) and many files more. */
  async function bigForge() {
    const root = await forge();
    const first = await buildAndWrite(root, { command: "atticus catalog build" });
    expect(first.write).toBeDefined();
    const extra = join(root, "catalog/generated/Endpoint");
    await mkdir(extra, { recursive: true });
    for (let i = 0; i < MANY; i += 200)
      await Promise.all(
        Array.from({ length: Math.min(200, MANY - i) }, (_, k) =>
          writeFile(
            join(extra, `forge-generated-${i + k}.yaml`),
            `kind: Endpoint\nid: forge-generated-${i + k}\n${"# forge\n".repeat(30)}`,
          ),
        ),
      );
    return root;
  }

  for (const way of [
    { name: "in workers", workers: 2 },
    { name: "in this thread", workers: 0 },
  ])
    it(
      `${way.name}: the build stops in its check step, before its guards, and catalog/ is as it was`,
      async () => {
        const root = await bigForge();
        const before = await tree(join(root, "catalog"));
        filePoolHooks.workers = way.workers;
        filePoolHooks.minFiles = 0;
        const stop = new AbortController();
        const steps: string[] = [];
        let at = 0;
        let read = 0;
        filePoolHooks.onRead = (n) => {
          read = n;
          if (steps.at(-1) === "check" && n >= 256 && !stop.signal.aborted) {
            at = Date.now();
            stop.abort();
          }
        };
        await expect(
          withSignal(stop.signal, () =>
            buildAndWrite(root, {
              command: "atticus catalog build",
              onStep: (s) => {
                steps.push(s.step);
              },
            }),
          ),
        ).rejects.toBeInstanceOf(CancelledError);
        expect(Date.now() - at).toBeLessThan(5_000);
        expect(steps).toEqual(["build", "check"]);
        expect(read).toBeLessThan(MANY);
        expect(await tree(join(root, "catalog"))).toEqual(before);
      },
      T,
    );

  it(
    "once the job says it is writing, a Stop no longer cuts the read short",
    async () => {
      const root = await bigForge();
      filePoolHooks.workers = 2;
      filePoolHooks.minFiles = 0;
      const stop = new AbortController();
      const steps: string[] = [];
      filePoolHooks.onRead = (n) => {
        if (steps.at(-1) === "check" && n >= 256) stop.abort();
      };
      const r = await withSignal(stop.signal, async () => {
        // An Edit the map's Apply: its changes are saved, then it builds once.
        commitCurrent();
        return buildAndWrite(root, {
          command: "atticus catalog build",
          onStep: (s) => {
            steps.push(s.step);
          },
        });
      });
      expect(stop.signal.aborted).toBe(true);
      expect(steps).toContain("guard");
      expect(r.guard).toBeDefined();
    },
    T,
  );

  it(
    "a caller that doesn't listen to the steps (it never stopped between them) isn't stopped in one",
    async () => {
      const root = await bigForge();
      filePoolHooks.workers = 2;
      filePoolHooks.minFiles = 0;
      const stop = new AbortController();
      filePoolHooks.onRead = (n) => {
        if (n >= 256) stop.abort();
      };
      const r = await withSignal(stop.signal, () =>
        buildAndWrite(root, { command: "atticus catalog build" }),
      );
      expect(stop.signal.aborted).toBe(true);
      expect(r.guard).toBeDefined();
    },
    T,
  );
});
