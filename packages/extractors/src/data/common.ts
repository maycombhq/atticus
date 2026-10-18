import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node } from "yaml";
import type { RepoHandle, ScanContext } from "@maycombhq/sdk";
import { componentOf, repoConfig, splitUrl } from "../facts.js";

/**
 * Helpers the data, observability, event-spec and mainframe extractors share.
 */

/** The id slug the built-in extractors use: lower case, dots kept, anything else a dash. */
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** The topic id slug of the topics extractor: dots become dashes too. */
export const topicId = (topic: string) =>
  `topic.${topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;

/**
 * The data store a repo's tables live in, computed exactly as the migrations extractor does
 * (the datasource host, else <system>-db), so ORM tables and migration tables get one id.
 */
export async function storeFor(repo: RepoHandle, ctx: ScanContext): Promise<string> {
  const config = await repoConfig(repo);
  const ds = config.get("spring.datasource.url")?.value;
  const host = ds
    ? splitUrl(ds.replace(/^jdbc:/, ""))
        .host?.split(":")[0]
        ?.split(".")[0]
    : undefined;
  return host ?? `${ctx.system ?? componentOf(repo, ctx)}-db`;
}

/** Test code, build output and vendored packages are never catalogued. */
export const isTestOrBuildPath = (path: string) =>
  /(^|\/)(test|tests|__tests__|node_modules|target|build|dist|bin|obj)\//i.test(path) ||
  /(^|\/)[^/]+\.(Tests?|UnitTests|IntegrationTests)\//.test(path) ||
  /(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$/.test(path);

export const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;

export interface YamlPair {
  key: string;
  line: number;
  value: unknown;
}

/** Parse YAML or JSON with line numbers; undefined when it doesn't parse. */
export function parseYamlDoc(text: string): { root: unknown; lc: LineCounter } | undefined {
  const lc = new LineCounter();
  try {
    const doc = parseDocument(text, { lineCounter: lc, uniqueKeys: false });
    if (doc.errors.length > 0) return undefined;
    return { root: doc.contents, lc };
  } catch {
    return undefined;
  }
}

/** The entries of a YAML map node, with the line of each key. */
export function pairs(node: unknown, lc: LineCounter): YamlPair[] {
  if (!isMap(node)) return [];
  return node.items.map((p) => {
    const k = p.key as Node | null;
    return {
      key: isScalar(k) ? String(k.value) : String(k),
      line: k?.range ? lc.linePos(k.range[0]).line : 1,
      value: p.value,
    };
  });
}

export const items = (node: unknown): unknown[] => (isSeq(node) ? node.items : []);

export const get = (node: unknown, key: string, lc: LineCounter): YamlPair | undefined =>
  pairs(node, lc).find((p) => p.key === key);

/** A scalar's value as a string, else undefined. */
export const scalar = (node: unknown): string | undefined =>
  isScalar(node) && node.value !== null && typeof node.value !== "object"
    ? String(node.value)
    : undefined;

export const nodeLine = (node: unknown, lc: LineCounter) => {
  const r = (node as { range?: [number, number, number] } | null)?.range;
  return r ? lc.linePos(r[0]).line : 1;
};
