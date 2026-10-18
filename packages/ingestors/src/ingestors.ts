import type { CatalogRecord } from "@maycombhq/core";
import { drawioIngestor } from "@maycombhq/reconcile";
import type { Ingestor, ScanContext } from "@maycombhq/sdk";
import { documentFormat, officeFormat, readDocument, type DocumentFormat } from "./documents.js";
import { looksLikeFigma, readFigma } from "./figma.js";
import { IMAGE_EXTENSIONS, imageFormat, readImage } from "./image.js";
import { readLucidCsv } from "./lucid.js";
import { readMermaid } from "./mermaid.js";
import { extOf, sourceDocument, utf8 } from "./record.js";
import { readVsdx } from "./vsdx.js";
import { ZipError } from "./zip.js";

/*
 * The ingestors (contract C4). Each one yields only the file's SourceDocument record: facts
 * inside a diagram or document become records through reconcile or intake triage, where a
 * person decides. Sniffing goes by extension first, then by the first bytes.
 */

const VERSION = "0.1.0";
const headText = (head: Uint8Array) => new TextDecoder().decode(head.slice(0, 4096));

function diagramIngestor(
  id: string,
  sniff: Ingestor["sniff"],
  check: (content: Uint8Array) => string | undefined,
): Ingestor {
  return {
    id,
    version: VERSION,
    sniff,
    async *ingest(fileName: string, content: Uint8Array, ctx: ScanContext) {
      const problem = check(content);
      if (problem) ctx.warn(problem, fileName);
      yield sourceDocument(fileName, content, "diagram", "diagram") as CatalogRecord;
    },
  };
}

const isLucidHeader = (head: Uint8Array) => {
  const first = headText(head)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)[0]!
    .toLowerCase();
  const cols = first.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
  return cols.includes("id") && cols.includes("line source") && cols.includes("line destination");
};

export const lucidIngestor = diagramIngestor(
  "lucid",
  (fileName, head) => (isLucidHeader(head) ? (extOf(fileName) === ".csv" ? 1 : 0.9) : 0),
  (content) => {
    const d = readLucidCsv(utf8(content));
    return d.problems.find((p) => p.cell === "")
      ? "This file is not a Lucidchart CSV export."
      : undefined;
  },
);

export const visioIngestor = diagramIngestor(
  "visio",
  (fileName, head) => (extOf(fileName) === ".vsdx" ? 1 : officeFormat(head) === "vsdx" ? 0.9 : 0),
  (content) => {
    try {
      const d = readVsdx(content);
      return d.problems.find((p) => p.cell === "")
        ? "No pages were found in this Visio file."
        : undefined;
    } catch (err) {
      if (err instanceof ZipError) return `This file could not be read as a .vsdx: ${err.message}.`;
      throw err;
    }
  },
);

/** The first statement of Mermaid text, past front matter, comments and blank lines. */
function mermaidHeader(text: string): string {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === "---");
    i = end > 0 ? end + 1 : 0;
  }
  for (; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (l && !l.startsWith("%%")) return l;
  }
  return "";
}

export const mermaidIngestor = diagramIngestor(
  "mermaid",
  (fileName, head) => {
    const ext = extOf(fileName);
    if (ext === ".mmd" || ext === ".mermaid") return 1;
    return /^(flowchart|graph)\b/i.test(mermaidHeader(headText(head))) ? 0.8 : 0;
  },
  (content) =>
    readMermaid(utf8(content)).problems.find((p) => p.cell === "")
      ? "No Mermaid flowchart was found in this file."
      : undefined,
);

export const imageIngestor: Ingestor = {
  id: "image",
  version: VERSION,
  sniff(fileName, head) {
    if (IMAGE_EXTENSIONS.includes(extOf(fileName))) return 1;
    return imageFormat(head) ? 0.9 : 0;
  },
  async *ingest(fileName, content, ctx) {
    const r = readImage(fileName, content);
    for (const n of r.notes) ctx.warn(n, fileName);
    yield r.record as CatalogRecord;
  },
};

function documentIngestor(
  format: DocumentFormat,
  extensions: string[],
  bySniff: (head: Uint8Array) => number,
): Ingestor {
  return {
    id: format,
    version: VERSION,
    sniff(fileName, head) {
      if (extensions.includes(extOf(fileName))) return 1;
      if (documentFormat(fileName, head) === format) return bySniff(head) || 0.9;
      return bySniff(head);
    },
    async *ingest(fileName, content, ctx) {
      const r = readDocument(fileName, content);
      for (const n of r.notes) ctx.warn(n, fileName);
      yield r.record as CatalogRecord;
    },
  };
}

const none = () => 0;
export const markdownIngestor = documentIngestor("markdown", [".md", ".markdown"], none);
export const htmlIngestor = documentIngestor("html", [".html", ".htm"], (head) =>
  /^\s*(<!doctype html|<html[\s>])/i.test(headText(head)) ? 0.8 : 0,
);
export const textIngestor = documentIngestor("text", [".txt", ".text"], none);
export const docxIngestor = documentIngestor("docx", [".docx"], none);
export const pptxIngestor = documentIngestor("pptx", [".pptx"], none);
export const xlsxIngestor = documentIngestor("xlsx", [".xlsx"], none);
export const pdfIngestor = documentIngestor("pdf", [".pdf"], (head) =>
  new TextDecoder("latin1").decode(head.slice(0, 1024)).includes("%PDF-") ? 0.95 : 0,
);

export const figmaIngestor: Ingestor = {
  id: "figma",
  version: VERSION,
  sniff(fileName, head) {
    const ext = extOf(fileName);
    if (ext === ".fig") return 1;
    const kind = looksLikeFigma(head);
    if (kind === "binary") return 0.95;
    if (kind === "json") return 0.9;
    if (kind === "link" && [".url", ".webloc", ".figma"].includes(ext)) return 0.9;
    return 0;
  },
  async *ingest(fileName, content, ctx) {
    const r = readFigma(fileName, content);
    for (const n of r.notes) ctx.warn(n, fileName);
    yield r.record as CatalogRecord;
  },
};

/** Every ingestor Atticus ships, draw.io first. */
export function listIngestors(): Ingestor[] {
  return [
    drawioIngestor,
    lucidIngestor,
    visioIngestor,
    mermaidIngestor,
    imageIngestor,
    markdownIngestor,
    htmlIngestor,
    textIngestor,
    docxIngestor,
    pptxIngestor,
    xlsxIngestor,
    pdfIngestor,
    figmaIngestor,
  ];
}

/** The ingestor most sure it understands the file; undefined when none is. */
export function pickIngestor(fileName: string, head: Uint8Array): Ingestor | undefined {
  let best: Ingestor | undefined;
  let score = 0;
  for (const i of listIngestors()) {
    const s = i.sniff(fileName, head);
    if (s > score) {
      best = i;
      score = s;
    }
  }
  return best;
}
