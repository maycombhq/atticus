import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, parseDocument } from "yaml";
import { ScannerPlugin, orgPackDirOf } from "@maycombhq/core";
import { runPluginTests } from "@maycombhq/scanner";
import { pluginEntryHash } from "@maycombhq/sdk";
import type { Output } from "./commands.js";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

interface LoadedPlugin {
  dir: string;
  file: string;
  manifest: ScannerPlugin;
  source: string;
}

/** Read org-pack/plugins/<id>/plugin.yaml and its entry file, printing why when it can't. */
async function load(root: string, id: string, io: Output): Promise<LoadedPlugin | undefined> {
  const plugins = join(orgPackDirOf(root), "plugins");
  const dir = join(plugins, id);
  const file = join(dir, "plugin.yaml");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    const known = (await readdir(plugins, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    io.err(
      `No plugin org-pack/plugins/${id}/plugin.yaml. ${known.length ? `Plugins here: ${known.join(", ")}` : "This org pack has no plugins yet."}`,
    );
    return undefined;
  }
  let data: unknown;
  try {
    data = parse(text);
  } catch (e) {
    io.err(`org-pack/plugins/${id}/plugin.yaml isn't valid YAML: ${(e as Error).message}`);
    return undefined;
  }
  const r = ScannerPlugin.safeParse(data);
  if (!r.success) {
    io.err(`org-pack/plugins/${id}/plugin.yaml isn't a valid plugin manifest (contract C6):`);
    for (const i of r.error.issues)
      io.err(`  ${i.path.length ? `${i.path.map(String).join(".")}: ` : ""}${i.message}`);
    return undefined;
  }
  if (r.data.id !== id) {
    io.err(
      `org-pack/plugins/${id}/plugin.yaml is for ${r.data.id}; keep it in plugins/${r.data.id}/`,
    );
    return undefined;
  }
  let source: string;
  try {
    source = await readFile(join(dir, ...r.data.entry.split("/")), "utf8");
  } catch {
    io.err(`Can't read the entry file org-pack/plugins/${id}/${r.data.entry}.`);
    return undefined;
  }
  return { dir, file, manifest: r.data, source };
}

/**
 * atticus plugin test <id>: run the plugin, sandboxed, against its golden files
 * (test/<case>/repo/ and expected.yaml) and print pass or FAIL per case, and whether the pin
 * still matches the entry file. Exit 0 all pass, 1 a failure or no tests.
 */
export async function pluginTest(root: string, id: string, io: Output): Promise<number> {
  const p = await load(root, id, io);
  if (!p) return 1;
  const results = await runPluginTests(p.dir, p.manifest, p.source);
  io.out(
    `Testing plugin ${p.manifest.id} ${p.manifest.version}: ${plural(results.length, "test")}`,
  );
  if (results.length === 0) {
    io.out(
      `No tests. Add test/<case>/repo/ and test/<case>/expected.yaml under org-pack/plugins/${id}/; the scan won't use a plugin without them.`,
    );
    return 1;
  }
  for (const r of results) {
    io.out(`  ${r.failures.length === 0 ? "pass" : "FAIL"}  ${r.name}`);
    for (const f of r.failures) io.out(`          ${f}`);
  }
  const hash = pluginEntryHash(p.source);
  const pin = !p.manifest.sha256
    ? `It isn't pinned: once it is reviewed, run atticus plugin pin ${id}.`
    : p.manifest.sha256 === hash
      ? `The pin matches ${p.manifest.entry}.`
      : `${p.manifest.entry} changed since it was pinned: the scan won't use it until it is reviewed and pinned again.`;
  const failed = results.filter((r) => r.failures.length > 0).length;
  if (failed === 0) {
    io.out(`${plural(results.length, "test")} passed. ${pin}`);
    return 0;
  }
  io.out(`${failed} of ${plural(results.length, "test")} failed. ${pin}`);
  return 1;
}

/**
 * atticus plugin pin <id>: write the entry file's sha256 into plugin.yaml, so the scan loads
 * exactly this code and nothing edited after it. Comments in plugin.yaml are kept. Exit 0
 * pinned, 1 the plugin can't be read.
 */
export async function pluginPin(root: string, id: string, io: Output): Promise<number> {
  const p = await load(root, id, io);
  if (!p) return 1;
  const hash = pluginEntryHash(p.source);
  const doc = parseDocument(await readFile(p.file, "utf8"));
  doc.set("sha256", hash);
  await writeFile(p.file, doc.toString({ flowCollectionPadding: false }), "utf8");
  io.out(`Pinned ${p.manifest.id} ${p.manifest.version}: ${p.manifest.entry} has sha256 ${hash}.`);
  io.out("Commit plugin.yaml with the code, in the same reviewed change.");
  return 0;
}
