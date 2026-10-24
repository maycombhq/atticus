import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse, parseDocument } from "yaml";
import { ModelProviderPlugin, ScannerPlugin, orgPackDirOf } from "@maycombhq/core";
import { SHIPPED_MODEL_PROVIDER_PLUGINS } from "@maycombhq/model-providers";
import { runPluginTests } from "@maycombhq/scanner";
import { pluginEntryHash, runTranslator } from "@maycombhq/sdk";
import type { Output } from "./commands.js";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type LoadedPlugin = {
  dir: string;
  file: string;
  /** org-pack-relative, for messages. */
  rel: string;
  source: string;
} & (
  | { kind: "scanner"; manifest: ScannerPlugin }
  | { kind: "model-provider"; manifest: ModelProviderPlugin }
);

const MODEL_PROVIDERS = "model-providers";

async function folders(dir: string): Promise<string[]> {
  return (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/**
 * Read a plugin's plugin.yaml and entry file, printing why when it can't: a scanner plugin in
 * org-pack/plugins/<id>/, or a model-provider plugin (ADR 0121 item 4) in
 * org-pack/plugins/model-providers/<id>/.
 */
async function load(root: string, id: string, io: Output): Promise<LoadedPlugin | undefined> {
  const plugins = join(orgPackDirOf(root), "plugins");
  const asModel = join(plugins, MODEL_PROVIDERS, id);
  const kind =
    id !== MODEL_PROVIDERS && existsSync(join(plugins, id, "plugin.yaml"))
      ? "scanner"
      : existsSync(join(asModel, "plugin.yaml"))
        ? "model-provider"
        : undefined;
  if (!kind) {
    const known = [
      ...(await folders(plugins)).filter((n) => n !== MODEL_PROVIDERS),
      ...(await folders(join(plugins, MODEL_PROVIDERS))),
    ].sort();
    io.err(
      `No plugin ${id} in org-pack/plugins/ or org-pack/plugins/${MODEL_PROVIDERS}/. ${known.length ? `Plugins here: ${known.join(", ")}` : "This org pack has no plugins yet."}`,
    );
    return undefined;
  }
  const dir = kind === "scanner" ? join(plugins, id) : asModel;
  const rel = kind === "scanner" ? `plugins/${id}` : `plugins/${MODEL_PROVIDERS}/${id}`;
  const file = join(dir, "plugin.yaml");
  let data: unknown;
  try {
    data = parse(await readFile(file, "utf8"));
  } catch (e) {
    io.err(`org-pack/${rel}/plugin.yaml isn't valid YAML: ${(e as Error).message}`);
    return undefined;
  }
  const r =
    kind === "scanner" ? ScannerPlugin.safeParse(data) : ModelProviderPlugin.safeParse(data);
  if (!r.success) {
    io.err(`org-pack/${rel}/plugin.yaml isn't a valid plugin manifest (contract C6):`);
    for (const i of r.error.issues)
      io.err(`  ${i.path.length ? `${i.path.map(String).join(".")}: ` : ""}${i.message}`);
    return undefined;
  }
  if (r.data.id !== id) {
    io.err(`org-pack/${rel}/plugin.yaml is for ${r.data.id}; keep it in a folder of that name`);
    return undefined;
  }
  let source: string;
  try {
    source = await readFile(join(dir, ...r.data.entry.split("/")), "utf8");
  } catch {
    io.err(`Can't read the entry file org-pack/${rel}/${r.data.entry}.`);
    return undefined;
  }
  return kind === "scanner"
    ? { kind, dir, file, rel, source, manifest: r.data as ScannerPlugin }
    : { kind, dir, file, rel, source, manifest: r.data as ModelProviderPlugin };
}

/**
 * A model-provider plugin's golden tests (ADR 0121 item 4): each test/<case>/ holds
 * request.json (what Atticus gives `request`) with expected-request.json, and answer.json (what
 * the provider sends back) with expected-answer.json. Each pair is run in the sandbox.
 */
async function modelProviderTests(
  p: LoadedPlugin & { kind: "model-provider" },
): Promise<{ name: string; failures: string[] }[]> {
  const code = {
    id: p.manifest.id,
    version: p.manifest.version,
    source: p.source,
    entry: p.manifest.entry,
    limits: p.manifest.limits,
  };
  const out: { name: string; failures: string[] }[] = [];
  for (const name of (await folders(join(p.dir, "test"))).sort()) {
    const at = join(p.dir, "test", name);
    const failures: string[] = [];
    for (const [fn, given, wanted] of [
      ["request", "request.json", "expected-request.json"],
      ["response", "answer.json", "expected-answer.json"],
    ] as const) {
      if (!existsSync(join(at, given))) continue;
      try {
        const arg = JSON.parse(await readFile(join(at, given), "utf8")) as unknown;
        const expected = JSON.parse(await readFile(join(at, wanted), "utf8")) as unknown;
        const got = await runTranslator(code, fn, arg);
        if (!isDeepStrictEqual(got, expected))
          failures.push(
            `${fn} gave ${JSON.stringify(got)}, but ${wanted} says ${JSON.stringify(expected)}`,
          );
      } catch (e) {
        failures.push(`${fn}: ${(e as Error).message}`);
      }
    }
    out.push({ name, failures });
  }
  return out;
}

/**
 * atticus plugin test <id>: run the plugin, sandboxed, against its golden files and print pass
 * or FAIL per case, and whether the pin still matches the entry file. A scanner plugin's cases
 * are test/<case>/repo/ and expected.yaml; a model-provider plugin's are request and answer
 * pairs. Exit 0 all pass, 1 a failure or no tests.
 */
export async function pluginTest(root: string, id: string, io: Output): Promise<number> {
  const p = await load(root, id, io);
  if (!p) return 1;
  const results =
    p.kind === "scanner"
      ? await runPluginTests(p.dir, p.manifest, p.source)
      : await modelProviderTests(p);
  io.out(
    `Testing plugin ${p.manifest.id} ${p.manifest.version}: ${plural(results.length, "test")}`,
  );
  if (results.length === 0) {
    io.out(
      p.kind === "scanner"
        ? `No tests. Add test/<case>/repo/ and test/<case>/expected.yaml under org-pack/${p.rel}/; the scan won't use a plugin without them.`
        : `No tests. Add test/<case>/request.json with expected-request.json, and answer.json with expected-answer.json, under org-pack/${p.rel}/.`,
    );
    return 1;
  }
  for (const r of results) {
    io.out(`  ${r.failures.length === 0 ? "pass" : "FAIL"}  ${r.name}`);
    for (const f of r.failures) io.out(`          ${f}`);
  }
  const hash = pluginEntryHash(p.source);
  const user = p.kind === "scanner" ? "the scan" : "model mode";
  const pin = !p.manifest.sha256
    ? `It isn't pinned: once it is reviewed, run atticus plugin pin ${id}.`
    : p.manifest.sha256 === hash
      ? `The pin matches ${p.manifest.entry}.`
      : `${p.manifest.entry} changed since it was pinned: ${user} won't use it until it is reviewed and pinned again.`;
  const failed = results.filter((r) => r.failures.length > 0).length;
  if (failed === 0) {
    io.out(`${plural(results.length, "test")} passed. ${pin}`);
    return 0;
  }
  io.out(`${failed} of ${plural(results.length, "test")} failed. ${pin}`);
  return 1;
}

/**
 * atticus plugin pin <id>: write the entry file's sha256 into plugin.yaml, so the scan (or model
 * mode) loads exactly this code and nothing edited after it. Comments in plugin.yaml are kept.
 * Exit 0 pinned, 1 the plugin can't be read.
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

/**
 * atticus plugin add <id> (ADR 0121 item 4): copy a model-provider plugin Atticus ships (vertex)
 * into org-pack/plugins/model-providers/<id>/, unpinned: a person reviews it and pins it, as any
 * plugin. Exit 0 added, 1 already there, 2 no such plugin.
 */
export async function pluginAdd(root: string, id: string, io: Output): Promise<number> {
  const files = SHIPPED_MODEL_PROVIDER_PLUGINS[id];
  if (!files) {
    io.err(
      `Atticus ships no plugin called ${id}. It ships: ${Object.keys(SHIPPED_MODEL_PROVIDER_PLUGINS).sort().join(", ")}.`,
    );
    return 2;
  }
  const dir = join(orgPackDirOf(root), "plugins", MODEL_PROVIDERS, id);
  if (existsSync(dir)) {
    io.err(
      `org-pack/plugins/${MODEL_PROVIDERS}/${id}/ is already there; Atticus leaves it as it is.`,
    );
    return 1;
  }
  for (const [path, text] of Object.entries(files)) {
    const to = join(dir, ...path.split("/"));
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, text, "utf8");
  }
  io.out(`Added the ${id} model-provider plugin in org-pack/plugins/${MODEL_PROVIDERS}/${id}/.`);
  io.out(
    `Review index.js: it only builds each request and reads each answer; Atticus makes the call, to the hosts plugin.yaml names, and adds the key itself.`,
  );
  io.out(
    `Then run atticus plugin test ${id}, atticus plugin pin ${id}, and commit the folder through a pull request. Choose it as the model provider on Set up › AI (adapters.model.type: ${id}).`,
  );
  return 0;
}
