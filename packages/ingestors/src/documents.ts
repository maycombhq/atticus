import { readHtml, readMarkdown, readPlainText } from "./markup.js";
import { readDocx, readPptx, readXlsx } from "./office.js";
import { readPdf } from "./pdf.js";
import {
  extOf,
  fileBase,
  sourceDocument,
  stem,
  utf8,
  type SourceDocumentRecord,
} from "./record.js";
import { ReadError, type ParsedText, type TextDocument } from "./text-model.js";
import { peekZip, readZip, ZipError, type ZipLimits } from "./zip.js";

export type { TextDocument, TextSection } from "./text-model.js";

export type DocumentFormat = "markdown" | "html" | "text" | "docx" | "pptx" | "xlsx" | "pdf";

export interface DocumentRead {
  format: DocumentFormat;
  /** The SourceDocument record (contract C1) for the file. */
  record: SourceDocumentRecord;
  /** The file's text, as data. */
  text: TextDocument;
  /** Plain sentences about what could not be read; empty when everything was. */
  notes: string[];
}

const BY_EXT: Record<string, DocumentFormat> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".html": "html",
  ".htm": "html",
  ".txt": "text",
  ".text": "text",
  ".docx": "docx",
  ".pptx": "pptx",
  ".xlsx": "xlsx",
  ".pdf": "pdf",
};

const DOC_TYPE: Record<DocumentFormat, string> = {
  markdown: "document",
  html: "document",
  text: "document",
  docx: "document",
  pptx: "presentation",
  xlsx: "spreadsheet",
  pdf: "document",
};

/** Which Office format a ZIP is, from its [Content_Types].xml (or its part names). */
export function officeFormat(head: Uint8Array): "docx" | "pptx" | "xlsx" | "vsdx" | undefined {
  const peek = peekZip(head);
  if (!peek) return undefined;
  const text = `${peek.name}\n${peek.content}`;
  if (/wordprocessingml|^word\//m.test(text)) return "docx";
  if (/presentationml|^ppt\//m.test(text)) return "pptx";
  if (/spreadsheetml|^xl\//m.test(text)) return "xlsx";
  if (/ms-visio|^visio\//m.test(text)) return "vsdx";
  return undefined;
}

/** The document format of a file, by extension, then by its first bytes. */
export function documentFormat(fileName: string, head: Uint8Array): DocumentFormat | undefined {
  const byExt = BY_EXT[extOf(fileName)];
  if (byExt) return byExt;
  if (new TextDecoder("latin1").decode(head.slice(0, 1024)).includes("%PDF-")) return "pdf";
  const office = officeFormat(head);
  return office && office !== "vsdx" ? office : undefined;
}

function parse(format: DocumentFormat, bytes: Uint8Array, limits: Partial<ZipLimits>): ParsedText {
  switch (format) {
    case "markdown":
      return readMarkdown(utf8(bytes));
    case "html":
      return readHtml(utf8(bytes));
    case "text":
      return readPlainText(utf8(bytes));
    case "pdf":
      return readPdf(bytes);
    case "docx":
      return readDocx(readZip(bytes, limits));
    case "pptx":
      return readPptx(readZip(bytes, limits));
    case "xlsx":
      return readXlsx(readZip(bytes, limits));
  }
}

/** Formats whose first heading makes a fair title when the file names none. */
const HEADING_TITLE = new Set<DocumentFormat>(["markdown", "html", "docx", "pptx"]);

/**
 * Read a document into plain text sections and tables, plus its SourceDocument record
 * (version, author and date from front matter or document properties when present). Facts in
 * the text are not records: intake and triage decide what becomes one. A file that can't be
 * read still gets its record, with a note saying why; a file type that isn't a document
 * throws.
 */
export function readDocument(
  fileName: string,
  bytes: Uint8Array,
  limits: Partial<ZipLimits> = {},
): DocumentRead {
  const format = documentFormat(fileName, bytes.slice(0, 4096));
  if (!format) throw new Error(`${fileBase(fileName)} is not a document type Atticus reads.`);
  let parsed: ParsedText;
  try {
    parsed = parse(format, bytes, limits);
  } catch (err) {
    if (!(err instanceof ZipError || err instanceof ReadError)) throw err;
    parsed = {
      sections: [],
      tables: [],
      meta: {},
      notes: [`This file could not be read as a .${format}: ${err.message}.`],
    };
  }
  const firstHeading = HEADING_TITLE.has(format)
    ? parsed.sections.find((s) => s.heading)?.heading
    : undefined;
  const text: TextDocument = {
    title: parsed.title ?? firstHeading ?? stem(fileName),
    sections: parsed.sections,
    ...(parsed.tables.length ? { tables: parsed.tables } : {}),
  };
  return {
    format,
    record: sourceDocument(fileName, bytes, DOC_TYPE[format], "document", parsed.meta),
    text,
    notes: parsed.notes,
  };
}
