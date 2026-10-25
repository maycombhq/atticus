import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ADR 0124 addendum D-bundle: search by meaning is an optional plugin. An npm install of the
 * command line brings @maycombhq/embed, @maycombhq/embed-model and onnxruntime only as optional
 * dependencies (`npm install --omit=optional` leaves them out), and the command line runs
 * without them: doctor says so as a note and search is by words and names.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "../..");
const BIN = join(HERE, "../dist/bin.js");
const HOOK = join(HERE, "no-embeddings-hook.mjs");

const plugin = (name: string) =>
  /^@maycombhq\/(embed|embed-model|onnxruntime-[a-z0-9-]+)$/.test(name) ||
  name === "onnxruntime-common";

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const manifests = new Map<string, Manifest>();
for (const dir of readdirSync(PACKAGES)) {
  const f = join(PACKAGES, dir, "package.json");
  if (!existsSync(f)) continue;
  const m = JSON.parse(readFileSync(f, "utf8")) as Manifest;
  manifests.set(m.name, m);
}

describe("the npm package without the embedding plugin", () => {
  it("brings the plugin's packages only as optional dependencies", () => {
    const cli = manifests.get("@maycombhq/cli")!;
    expect(Object.keys(cli.optionalDependencies ?? {}).sort()).toEqual([
      "@maycombhq/embed",
      "@maycombhq/embed-model",
    ]);
    expect(Object.keys(manifests.get("@maycombhq/index")!.optionalDependencies ?? {})).toEqual([
      "@maycombhq/embed",
    ]);
    expect(
      Object.keys(manifests.get("@maycombhq/embed")!.optionalDependencies ?? {}).every(plugin),
    ).toBe(true);
    // Nothing the command line needs (its dependencies, and theirs) needs the plugin.
    const needed = new Set<string>();
    const walk = (name: string) => {
      if (needed.has(name)) return;
      needed.add(name);
      for (const d of Object.keys(manifests.get(name)?.dependencies ?? {}))
        if (manifests.has(d)) walk(d);
    };
    walk("@maycombhq/cli");
    const through = [...needed].flatMap((n) =>
      Object.keys(manifests.get(n)!.dependencies ?? {})
        .filter(plugin)
        .map((d) => `${n} -> ${d}`),
    );
    expect(through).toEqual([]);
    expect([...needed].filter(plugin)).toEqual([]);
  });

  // The hook needs module.registerHooks (Node 22.15 and later).
  it.skipIf(typeof (nodeModule as { registerHooks?: unknown }).registerHooks !== "function")(
    "runs with the plugin's packages missing: doctor's note, a search by words and names",
    async () => {
      const work = await mkdtemp(join(tmpdir(), "atticus-no-embeddings-"));
      const env: NodeJS.ProcessEnv = { ...process.env };
      // The suites turn the model off; here the command line must find the plugin missing.
      delete env.ATTICUS_EMBEDDINGS;
      const run = (...args: string[]) =>
        spawnSync(process.execPath, ["--import", HOOK, BIN, ...args], {
          encoding: "utf8",
          env,
          timeout: 60_000,
        });
      // The hook really hides them: an import of @maycombhq/embed fails as a missing package.
      const probe = spawnSync(
        process.execPath,
        [
          "--import",
          HOOK,
          "--input-type=module",
          "-e",
          "await import('@maycombhq/embed').then(() => console.log('found'), (e) => console.log(e.code))",
        ],
        { encoding: "utf8", cwd: join(PACKAGES, "cli"), env },
      );
      expect(probe.stdout.trim()).toBe("ERR_MODULE_NOT_FOUND");

      expect(run("--version").status).toBe(0);
      const made = run("sandbox", "create", join(work, "sandbox"));
      expect(made.status, made.stderr).toBe(0);
      const root = join(work, "sandbox", "metarepo");
      const doctor = run("doctor", "--root", root, "--json");
      const checks = (
        JSON.parse(doctor.stdout) as { checks: { id: string; status: string; detail: string }[] }
      ).checks;
      expect(checks.find((c) => c.id === "embeddings")).toMatchObject({
        status: "ok",
        detail: expect.stringMatching(
          /^not installed \(@maycombhq\/embed, an optional plugin\), so the context engine searches by words and names only/,
        ),
      });
      const hits = run("query", "ledger", "--search", "--root", root);
      expect(hits.status, hits.stderr).toBe(0);
      expect(hits.stdout).toMatch(/System\s+ledger/);
      const scan = run("scan", "--root", root);
      expect(scan.status, scan.stderr).toBe(0);
      // Asked for by name, embedding says what is missing, without a stack trace.
      const embed = run("index", "embed", "--root", root);
      expect(embed.status).toBe(1);
      expect(embed.stderr).toMatch(
        /search by meaning is an optional plugin that isn't installed \(@maycombhq\/embed\)/,
      );
      expect(embed.stderr).not.toMatch(/\n\s+at /);
    },
    120_000,
  );
});
