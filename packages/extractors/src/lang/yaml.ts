import { deepFreeze } from "@maycombhq/sdk";
import { LineCounter, parseAllDocuments, type Document } from "yaml";
import type { ParsedAt } from "./parsed.js";

/** A YAML (or JSON) file's documents with line numbers, as every lenient YAML reader parses it. */
export interface YamlStream {
  /** Undefined for an empty stream (no documents at all). */
  docs: readonly Document.Parsed[] | undefined;
  lc: LineCounter;
}

/**
 * Every document in a YAML file, duplicate keys allowed (the readers that report duplicates
 * don't use this). With a parse cache (ADR 0067) the file is parsed once for every reader in the
 * scan: the configuration flattener, the manifest and pipeline readers, Helm and Kustomize, and
 * dialect jsonPath rules. The documents' contents are frozen; readers only walk them.
 */
export function parseYamlStream(text: string, at?: ParsedAt): YamlStream {
  const parse = (t: string): YamlStream => {
    const lc = new LineCounter();
    const docs = parseAllDocuments(t, { lineCounter: lc, uniqueKeys: false });
    const list = Array.isArray(docs) ? (docs as Document.Parsed[]) : undefined;
    // The documents themselves hold their schema, which yaml may share: only what was read is frozen.
    for (const d of list ?? []) deepFreeze(d.contents);
    deepFreeze(lc);
    return { docs: list && Object.freeze(list), lc };
  };
  return at?.cache ? at.cache.get("yaml", at.path, text, parse, { freeze: false }) : parse(text);
}
