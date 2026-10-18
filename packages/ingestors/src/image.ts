import { extOf, sourceDocument, utf8, type SourceDocumentRecord } from "./record.js";
import { squash } from "./labels.js";
import { findAll, parseXmlTree, textOf, type XNode } from "./xml.js";

/*
 * Pictures of diagrams. Reading edges from a picture needs AI or a person, so the
 * deterministic ingest only records the file (docType image, hash) and flags it as needing
 * reading. Edges read from it later are asserted only after a person confirms each one.
 * An SVG's text labels are offered as candidate box names, still unconfirmed.
 */

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "svg" | "unknown";

export interface NeedsReading {
  reason: string;
  /** Text found in the picture (SVG only), as candidates for a person to confirm. */
  candidateLabels: string[];
  /** Always false here: confirming is a person's job, during intake triage. */
  confirmed: false;
}

export interface ImageRead {
  record: SourceDocumentRecord;
  image: { format: ImageFormat; width?: number; height?: number };
  needsReading: NeedsReading;
  notes: string[];
}

export const NEEDS_READING_FLAG = "needs-reading";
const REASON =
  "Edges in a picture are read later, by AI or a person, and each edge is asserted only after a person confirms it.";

const EXT: Record<string, ImageFormat> = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".gif": "gif",
  ".webp": "webp",
  ".svg": "svg",
};

export const IMAGE_EXTENSIONS = Object.keys(EXT);

/** The picture format from its first bytes; undefined when it isn't one. */
export function imageFormat(head: Uint8Array): ImageFormat | undefined {
  const b = head;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === "PNG" && b[4] === 0x0d && b[5] === 0x0a)
    return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(ascii(0, 6))) return "gif";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  const text = new TextDecoder().decode(b.slice(0, 1024));
  if (/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(text))
    return "svg";
  return undefined;
}

function size(format: ImageFormat, b: Uint8Array): { width?: number; height?: number } {
  const be16 = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const le16 = (i: number) => b[i]! | (b[i + 1]! << 8);
  const le24 = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
  const be32 = (i: number) =>
    ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
  try {
    if (format === "png" && b.length >= 24) return { width: be32(16), height: be32(20) };
    if (format === "gif" && b.length >= 10) return { width: le16(6), height: le16(8) };
    if (format === "jpeg") {
      // Walk the segments to a start-of-frame marker.
      for (let i = 2; i + 9 < b.length;) {
        if (b[i] !== 0xff) return {};
        const marker = b[i + 1]!;
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
          return { height: be16(i + 5), width: be16(i + 7) };
        i += 2 + be16(i + 2);
      }
      return {};
    }
    if (format === "webp" && b.length >= 30) {
      const chunk = String.fromCharCode(...b.slice(12, 16));
      if (chunk === "VP8X") return { width: le24(24) + 1, height: le24(27) + 1 };
      if (chunk === "VP8 ") return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
      if (chunk === "VP8L") {
        const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    return {};
  }
  return {};
}

/** Text labels in an SVG, in order, de-duplicated; scripts and styles are not read. */
function svgLabels(svg: XNode | undefined): string[] {
  const out: string[] = [];
  for (const t of findAll(svg, "text")) {
    const parts = t.children.map((c) => (typeof c === "string" ? c : textOf(c)));
    const label = squash(parts.join(" "));
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

const px = (v: string | undefined) => {
  const m = v ? /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/.exec(v) : null;
  return m ? Number(m[1]) : undefined;
};

export function readImage(fileName: string, bytes: Uint8Array): ImageRead {
  const notes: string[] = [];
  const byExt = EXT[extOf(fileName)];
  const byBytes = imageFormat(bytes.slice(0, 1024));
  const format: ImageFormat = byBytes ?? "unknown";
  if (!byBytes) notes.push("The content is not a picture format Atticus recognises.");
  else if (byExt && byExt !== byBytes)
    notes.push(`The file name says ${byExt} but the content is ${byBytes}.`);
  let dims: { width?: number; height?: number } = {};
  let candidateLabels: string[] = [];
  if (format === "svg") {
    const svg = parseXmlTree(utf8(bytes));
    if (svg) {
      const width = px(svg.attrs.width);
      const height = px(svg.attrs.height);
      dims = { ...(width ? { width } : {}), ...(height ? { height } : {}) };
      candidateLabels = svgLabels(svg);
    }
  } else if (format !== "unknown") dims = size(format, bytes);
  return {
    record: sourceDocument(fileName, bytes, "image", "diagram", { flags: [NEEDS_READING_FLAG] }),
    image: { format, ...dims },
    needsReading: { reason: REASON, candidateLabels, confirmed: false },
    notes,
  };
}
