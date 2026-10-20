import { isMap, isScalar, isSeq } from "yaml";
import type { ParsedAt } from "../lang/parsed.js";
import { parseYamlStream } from "../lang/yaml.js";
import { at } from "./util.js";

/** Multi-document YAML (and JSON, which YAML reads too) with line numbers. */

export type PathSeg = string | number;

/** One parsed document: its plain value and the line of any key path in it. */
export interface YamlDoc {
  value: unknown;
  /** Line of the key at `path` (of the item, for a sequence index). Undefined when absent. */
  line(path: readonly PathSeg[]): number | undefined;
}

export const MALFORMED_YAML = "Could not read this file as YAML; skipped it.";

/**
 * Parse every document in a file. Undefined when any document has a syntax error. With the repo
 * scan's parse cache (ADR 0067) every reader of the file gets the same frozen documents.
 */
export function readYamlDocs(text: string, where?: ParsedAt): YamlDoc[] | undefined {
  return where?.cache
    ? where.cache.get("yaml-docs", where.path, text, (t) => yamlDocs(t, where))
    : yamlDocs(text);
}

function yamlDocs(text: string, where?: ParsedAt): YamlDoc[] | undefined {
  const { docs, lc } = parseYamlStream(text, where);
  if (!docs) return undefined; // an empty stream
  if (docs.some((d) => d.errors.length > 0)) return undefined;
  const out: YamlDoc[] = [];
  for (const d of docs) {
    if (d.contents === null) continue;
    let value: unknown;
    try {
      value = d.toJS({ maxAliasCount: 100 });
    } catch {
      return undefined;
    }
    const lineAt = (pos: number) => lc.linePos(pos).line;
    const root = d.contents;
    out.push({
      value,
      line(path) {
        let node: unknown = root;
        let line: number | undefined = root.range ? lineAt(root.range[0]) : undefined;
        for (const seg of path) {
          if (isMap(node)) {
            const pair = node.items.find(
              (p) => (isScalar(p.key) ? String(p.key.value) : String(p.key)) === String(seg),
            );
            if (!pair) return undefined;
            const k = pair.key as { range?: [number, number, number] } | null;
            if (k?.range) line = lineAt(k.range[0]);
            node = pair.value;
          } else if (isSeq(node) && typeof seg === "number") {
            const item = node.items[seg] as { range?: [number, number, number] } | undefined;
            if (!item) return undefined;
            if (item.range) line = lineAt(item.range[0]);
            node = item;
          } else return undefined;
        }
        return line;
      },
    });
  }
  return out;
}

/** A view of part of a document, with lines still relative to the file. */
export function subDoc(doc: YamlDoc, prefix: readonly PathSeg[]): YamlDoc {
  return {
    value: at(doc.value, ...prefix),
    line: (path) => doc.line([...prefix, ...path]),
  };
}
