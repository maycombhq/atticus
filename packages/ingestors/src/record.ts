import { createHash } from "node:crypto";
import type { RecordOf } from "@maycombhq/core";

export type SourceDocumentRecord = RecordOf<"SourceDocument">;

export interface DocumentMeta {
  version?: string;
  author?: string;
  /** ISO date, YYYY-MM-DD. */
  date?: string;
  flags?: string[];
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** The file name without folders. */
export const fileBase = (fileName: string) => fileName.split(/[\\/]/).pop() ?? fileName;

/** The lower-case extension with its dot, e.g. ".docx"; "" when there is none. */
export function extOf(fileName: string): string {
  const base = fileBase(fileName);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** Double extensions that name the format together ("x.lucid.csv", "x.figma.json"). */
const DOUBLE = /\.(drawio\.xml|lucid\.csv|figma\.json)$/i;

/** The file name without folders and extension: the readable name of a document. */
export function stem(fileName: string): string {
  const base = fileBase(fileName);
  if (DOUBLE.test(base)) return base.replace(DOUBLE, "");
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * The SourceDocument id: "doc." and the file name made a slug, extension dropped, as the
 * draw.io ingestor does. Two files that differ only by extension get the same id.
 */
export function documentId(fileName: string): string {
  const s = slug(stem(fileName)).slice(0, 110);
  return `doc.${s || "file"}`;
}

/** An ISO date (YYYY-MM-DD) from a date or date-time string or a Date; undefined otherwise. */
export function isoDate(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime()))
    return value.toISOString().slice(0, 10);
  if (typeof value !== "string") return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return undefined;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(m[0]) ? m[0] : undefined;
}

/**
 * The SourceDocument record for a file: what it is, where it is and its sha-256 hash.
 * Facts inside the file are not records yet: intake and triage turn them into records, so
 * recordsProduced starts empty.
 */
export function sourceDocument(
  fileName: string,
  content: Uint8Array,
  docType: string,
  source: "diagram" | "document",
  meta: DocumentMeta = {},
): SourceDocumentRecord {
  const clean = (s: string | undefined) => (s && s.trim() ? s.trim() : undefined);
  const version = clean(meta.version);
  const author = clean(meta.author);
  return {
    schemaVersion: 1,
    kind: "SourceDocument",
    id: documentId(fileName),
    status: "current",
    confidence: "verified",
    ...(meta.flags?.length ? { flags: meta.flags } : {}),
    path: fileName,
    docType,
    ...(version ? { version } : {}),
    ...(author ? { author } : {}),
    ...(meta.date ? { date: meta.date } : {}),
    hash: createHash("sha256").update(content).digest("hex"),
    recordsProduced: [],
    evidence: [{ source, path: fileName }],
  };
}

export const utf8 = (b: Uint8Array) => {
  const s = new TextDecoder("utf-8").decode(b);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
};
