import { checkCatalog } from "./catalog.js";
import { checkDialect } from "./dialect.js";
import { checkExecutor, type ExecutorOptions } from "./executor.js";
import { checkOrgPack } from "./orgpack.js";
import { checkPlugin, type PluginOptions } from "./plugin.js";
import type { ConformanceKind, ConformanceReport } from "./report.js";

export const CONFORMANCE_KINDS: readonly ConformanceKind[] = [
  "catalog",
  "org-pack",
  "dialect",
  "plugin",
  "executor",
];

export type ConformanceOptions = { kind: ConformanceKind } & PluginOptions & ExecutorOptions;

/**
 * Run the conformance suite against one target:
 * - catalog: a catalog folder (generated/ and curated/) or a metarepo root;
 * - org-pack: an org-pack folder or a metarepo root;
 * - dialect: one dialect rule file;
 * - plugin: a JavaScript module exporting extractors or ingestors (optionally a repo folder
 *   or input files to run them on);
 * - executor: an executors.yaml file or a metarepo root (optionally which executor).
 */
export async function conformanceRun(
  target: string,
  o: ConformanceOptions,
): Promise<ConformanceReport> {
  switch (o.kind) {
    case "catalog":
      return checkCatalog(target);
    case "org-pack":
      return checkOrgPack(target);
    case "dialect":
      return checkDialect(target);
    case "plugin":
      return checkPlugin(target, o);
    case "executor":
      return checkExecutor(target, o);
  }
}
