import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { orgPackJsonSchemas, rulesJsonSchemas } from "@maycombhq/core";
import { cliMarkdown, frameworksCliMarkdown } from "./cli-reference.js";
import { kindsMarkdown } from "./kinds-doc.js";

/** The kit's hand-written files; the package ships them next to dist/. */
export const KIT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "kit");

/** The framework-model kit's hand-written files (ADR 0055). */
export const FRAMEWORKS_KIT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "frameworks-kit",
);

async function walk(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...(await walk(join(dir, e.name), `${prefix}${e.name}/`)));
    else if (e.isFile()) out.push(`${prefix}${e.name}`);
  }
  return out;
}

/**
 * Write the dialect build kit to a folder so it can be handed to an assistant with nothing
 * else: the hand-written guides, plus files generated from the contracts (the C2 JSON
 * Schema and the C1 record kinds) and the command reference, so they can't drift from the
 * code. Overwrites the kit's own files and leaves anything else in the folder alone.
 * Returns the paths written, relative to the folder, sorted.
 */
export async function exportKit(outDir: string): Promise<string[]> {
  const files = new Map<string, string>();
  for (const f of await walk(KIT_DIR)) files.set(f, await readFile(join(KIT_DIR, f), "utf8"));
  files.set("dialect.schema.json", JSON.stringify(rulesJsonSchemas().Dialect, null, 2) + "\n");
  files.set("c1-kinds.md", kindsMarkdown());
  files.set("cli.md", cliMarkdown());
  const written = [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const f of written) {
    const target = join(outDir, ...f.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, files.get(f)!, "utf8");
  }
  return written;
}

/**
 * Write the framework-model kit (ADR 0055) to a folder, for an assistant drafting a model
 * during onboarding: the guide, two worked examples, the checklist and a task prompt, plus the
 * model's JSON Schema and the command reference, generated so they can't drift. Overwrites
 * the kit's own files and leaves anything else alone. Returns the paths written, sorted.
 */
export async function exportFrameworksKit(outDir: string): Promise<string[]> {
  const files = new Map<string, string>();
  for (const f of await walk(FRAMEWORKS_KIT_DIR))
    files.set(f, await readFile(join(FRAMEWORKS_KIT_DIR, f), "utf8"));
  files.set(
    "framework.schema.json",
    JSON.stringify(orgPackJsonSchemas().FrameworkModel, null, 2) + "\n",
  );
  files.set("cli.md", frameworksCliMarkdown());
  const written = [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const f of written) {
    const target = join(outDir, ...f.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, files.get(f)!, "utf8");
  }
  return written;
}
