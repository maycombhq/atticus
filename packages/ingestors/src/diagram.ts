import { readDrawio, type Diagram, type LegendWords } from "@maycombhq/reconcile";
import { DEFAULT_LEGEND } from "./labels.js";
import { readLucidCsv } from "./lucid.js";
import { readMermaid } from "./mermaid.js";
import { extOf, fileBase, utf8 } from "./record.js";
import { readVsdx } from "./vsdx.js";

/**
 * Read any diagram format Atticus understands into the one Diagram model reconcile uses:
 * draw.io, Lucidchart CSV, Visio .vsdx, Mermaid (.mmd, .mermaid, or ```mermaid blocks in
 * Markdown). Undefined when the file is not a diagram. A broken .vsdx throws ZipError.
 */
export function readDiagram(
  fileName: string,
  bytes: Uint8Array,
  legendWords: LegendWords = DEFAULT_LEGEND,
): Diagram | undefined {
  const ext = extOf(fileName);
  if (/\.drawio(\.xml)?$/i.test(fileBase(fileName))) return readDrawio(utf8(bytes), legendWords);
  if (ext === ".vsdx") return readVsdx(bytes, legendWords);
  if (ext === ".csv") return readLucidCsv(utf8(bytes), legendWords);
  if (ext === ".mmd" || ext === ".mermaid") return readMermaid(utf8(bytes), legendWords);
  if (ext === ".md" || ext === ".markdown") {
    const text = utf8(bytes);
    return /^\s*(`{3,}|~{3,})\s*mermaid\s*$/m.test(text)
      ? readMermaid(text, legendWords)
      : undefined;
  }
  return undefined;
}
