import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

/**
 * The command line starts quickly (M5's budget: perf.test.ts). The editors, the app's server and
 * the assistant's hooks run it often, so what it loads before it knows the command is held here:
 * `--version` loads no workspace package at all, the help no schema, and a command that runs no
 * model doesn't load the model providers (their HTTP client) or the context tools.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "../dist/bin.js");
// --import takes a URL: a Windows path (C:\...) would read as a URL scheme.
const HOOK = pathToFileURL(join(HERE, "loaded-modules-hook.mjs")).href;

/** Run the built command line; the modules it loaded, as paths with forward slashes. */
async function loaded(args: string[], cwd?: string): Promise<{ out: string; files: string[] }> {
  const file = join(await mkdtemp(join(tmpdir(), "atticus-startup-")), "loaded.txt");
  const r = spawnSync(process.execPath, ["--import", HOOK, BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, ATTICUS_LOADED_FILE: file },
    timeout: 60_000,
    ...(cwd ? { cwd } : {}),
  });
  const files = (await readFile(file, "utf8"))
    .split("\n")
    .filter((u) => u.startsWith("file:"))
    .map((u) => fileURLToPath(u).split("\\").join("/"));
  return { out: r.stdout, files };
}

/** packages/<name>/... or node_modules/<package>/...: what a path belongs to. */
const owner = (f: string) => {
  const nm = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//.exec(f);
  if (nm) return nm[1]!;
  const pkg = /\/packages\/([^/]+)\//.exec(f);
  return pkg ? `packages/${pkg[1]}` : f;
};

// The hook needs module.registerHooks (Node 22.15 and later).
describe.skipIf(typeof (nodeModule as { registerHooks?: unknown }).registerHooks !== "function")(
  "what the command line loads before it runs a command",
  () => {
    it("answers --version without loading any workspace package or other module", async () => {
      const r = await loaded(["--version"]);
      expect(r.out.trim()).toBe(VERSION);
      const ours = r.files.filter((f) => !f.endsWith("loaded-modules-hook.mjs"));
      expect(ours.map((f) => f.replace(/.*\/packages\//, "packages/")).sort()).toEqual([
        "packages/cli/dist/bin.js",
        "packages/cli/dist/version.js",
      ]);
    });

    it("prints the help without loading a schema, zod or a YAML reader", async () => {
      const r = await loaded(["--help"]);
      expect(r.out).toContain(`atticus ${VERSION}`);
      const owners = [...new Set(r.files.map(owner))].sort();
      expect(owners).toEqual(["packages/cli", "packages/core"]);
      // Only core's light entry (the schema version and the log), never its schemas.
      for (const f of r.files.filter((x) => owner(x) === "packages/core"))
        expect(f).toMatch(/\/core\/dist\/(light|log|fs|schema\/version)\.js$/);
    });

    it("runs a command that calls no model without the model providers or the context tools", async () => {
      // `next` outside a metarepo says so: it still loads its command, as in one.
      const r = await loaded(["next"], await mkdtemp(join(tmpdir(), "atticus-startup-")));
      const owners = new Set(r.files.map(owner));
      expect(owners.has("packages/cli")).toBe(true);
      for (const heavy of ["packages/model-providers", "undici"])
        expect(owners.has(heavy), heavy).toBe(false);
      expect(r.files.some((f) => /cli\/dist\/(code-tools|model-plugins)\.js$/.test(f))).toBe(false);
    });
  },
);
