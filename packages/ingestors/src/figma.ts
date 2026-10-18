import { isoDate, sourceDocument, utf8, type SourceDocumentRecord } from "./record.js";

/*
 * Figma designs are reference material only: a .fig file, a JSON export or a saved link
 * becomes a SourceDocument (docType design) and nothing else. A link is kept as text and
 * never opened.
 */

export interface DesignRead {
  record: SourceDocumentRecord;
  title?: string;
  /** Page (canvas) names from a JSON export. */
  pages: string[];
  /** A figma.com link found in a link file, never fetched. */
  link?: string;
  notes: string[];
}

const FIG_MAGIC = "fig-kiwi";
const LINK = /https:\/\/(?:www\.)?figma\.com\/[^\s"'<>]+/;

/** True when the head looks like a Figma file, export or link. */
export function looksLikeFigma(head: Uint8Array): "binary" | "json" | "link" | undefined {
  const text = new TextDecoder().decode(head.slice(0, 4096));
  if (text.startsWith(FIG_MAGIC)) return "binary";
  if (/^\s*\{/.test(text) && /"document"\s*:/.test(text) && /"type"\s*:\s*"DOCUMENT"/.test(text))
    return "json";
  if (LINK.test(text) && text.length < 4096 && !/^\s*</.test(text)) return "link";
  return undefined;
}

export function readFigma(fileName: string, bytes: Uint8Array): DesignRead {
  const kind = looksLikeFigma(bytes);
  const notes: string[] = [];
  let title: string | undefined;
  let version: string | undefined;
  let date: string | undefined;
  let link: string | undefined;
  const pages: string[] = [];
  if (kind === "json") {
    try {
      const doc = JSON.parse(utf8(bytes)) as {
        name?: unknown;
        version?: unknown;
        lastModified?: unknown;
        document?: { children?: { name?: unknown; type?: unknown }[] };
      };
      if (typeof doc.name === "string" && doc.name.trim()) title = doc.name.trim();
      if (typeof doc.version === "string" || typeof doc.version === "number")
        version = String(doc.version);
      date = isoDate(doc.lastModified);
      for (const c of doc.document?.children ?? [])
        if (c?.type === "CANVAS" && typeof c.name === "string") pages.push(c.name);
    } catch {
      notes.push("The Figma export is not valid JSON, so only the file itself is recorded.");
    }
  } else if (kind === "link") link = LINK.exec(utf8(bytes))![0];
  else if (kind !== "binary") notes.push("This does not look like a Figma file, export or link.");
  return {
    record: sourceDocument(fileName, bytes, "design", "document", {
      ...(version ? { version } : {}),
      ...(date ? { date } : {}),
    }),
    ...(title ? { title } : {}),
    pages,
    ...(link ? { link } : {}),
    notes,
  };
}
