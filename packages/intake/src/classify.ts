import { parse } from "yaml";

/**
 * What a dropped file is, decided from its content (the name only breaks ties), so nobody has
 * to sort the inbox. Deterministic: no AI. Free text and images are recognised but not read
 * here; they are marked as needing reading, which is AI work for later.
 */
export type Classification =
  | "openapi"
  | "swagger"
  | "asyncapi"
  | "diagram"
  | "image"
  | "document"
  | "spreadsheet"
  | "ticket-export"
  | "payload"
  | "unknown";

export interface Classified {
  classification: Classification;
  /** For specs: info.title. */
  title?: string;
  /** For specs: info.version. */
  version?: string;
  /** The parsed YAML/JSON, when the file is one. */
  data?: unknown;
}

const startsWith = (b: Uint8Array, ...sig: number[]) => sig.every((x, i) => b[i] === x);
const ascii = (b: Uint8Array, from: number, s: string) =>
  [...s].every((c, i) => b[from + i] === c.charCodeAt(0));

function imageMagic(b: Uint8Array): boolean {
  return (
    startsWith(b, 0x89, 0x50, 0x4e, 0x47) || // PNG
    startsWith(b, 0xff, 0xd8, 0xff) || // JPEG
    ascii(b, 0, "GIF8") ||
    (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) ||
    ascii(b, 0, "BM") ||
    startsWith(b, 0x49, 0x49, 0x2a, 0x00) || // TIFF little-endian
    startsWith(b, 0x4d, 0x4d, 0x00, 0x2a) // TIFF big-endian
  );
}

/** Names of the entries in a zip file's central directory (enough to tell Office files apart). */
function zipEntries(b: Uint8Array): string[] {
  const out: string[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i + 46 <= b.length; i++) {
    if (b[i] !== 0x50 || b[i + 1] !== 0x4b || b[i + 2] !== 0x01 || b[i + 3] !== 0x02) continue;
    const len = b[i + 28]! | (b[i + 29]! << 8);
    out.push(dec.decode(b.subarray(i + 46, i + 46 + len)));
    i += 45 + len;
  }
  if (out.length > 0) return out;
  // no central directory (truncated file): fall back to local file headers
  for (let i = 0; i + 30 <= b.length; i++) {
    if (b[i] !== 0x50 || b[i + 1] !== 0x4b || b[i + 2] !== 0x03 || b[i + 3] !== 0x04) continue;
    const len = b[i + 26]! | (b[i + 27]! << 8);
    out.push(dec.decode(b.subarray(i + 30, i + 30 + len)));
  }
  return out;
}

/** Text if the bytes look like UTF-8 text; undefined for binary. */
function asText(b: Uint8Array): string | undefined {
  if (b.subarray(0, 8000).includes(0)) return undefined;
  try {
    // TextDecoder drops a leading byte-order mark by itself
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return undefined;
  }
}

const TICKET_KEYS = ["number", "ticket", "type", "title", "status", "state", "opened", "closed"];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

function fromData(data: unknown): Classified | undefined {
  if (isObj(data)) {
    const info = isObj(data.info) ? data.info : {};
    const meta = {
      ...(str(info.title) ? { title: str(info.title)! } : {}),
      ...(str(info.version) ? { version: str(info.version)! } : {}),
      data,
    };
    if (/^3(\.|$)/.test(String(data.openapi ?? ""))) return { classification: "openapi", ...meta };
    if (/^2(\.0)?$/.test(String(data.swagger ?? ""))) return { classification: "swagger", ...meta };
    if (data.asyncapi !== undefined) return { classification: "asyncapi", ...meta };
    return undefined;
  }
  if (Array.isArray(data) && data.length > 0 && data.every(isObj)) {
    const keys = new Set(data.flatMap((o) => Object.keys(o).map((k) => k.toLowerCase())));
    const hasId = keys.has("id") || keys.has("number") || keys.has("key");
    if (hasId && TICKET_KEYS.filter((k) => keys.has(k)).length >= 2)
      return { classification: "ticket-export", data };
  }
  return undefined;
}

export function classify(fileName: string, bytes: Uint8Array): Classified {
  const name = fileName.toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";

  if (imageMagic(bytes)) return { classification: "image" };
  if (ascii(bytes, 0, "%PDF")) return { classification: "document" };
  if (startsWith(bytes, 0x50, 0x4b, 0x03, 0x04)) {
    const entries = zipEntries(bytes);
    if (entries.some((e) => e.startsWith("visio/"))) return { classification: "diagram" };
    if (entries.some((e) => e.startsWith("xl/"))) return { classification: "spreadsheet" };
    if (entries.some((e) => e.startsWith("word/") || e.startsWith("ppt/")))
      return { classification: "document" };
    if (ext === "lucid" || entries.some((e) => /(^|\/)document\.json$/.test(e)))
      return { classification: "diagram" };
    return { classification: "unknown" };
  }
  if (startsWith(bytes, 0xd0, 0xcf, 0x11, 0xe0)) {
    // legacy OLE container: the extension is all there is to go on
    if (ext === "vsd") return { classification: "diagram" };
    if (ext === "xls") return { classification: "spreadsheet" };
    if (ext === "doc" || ext === "ppt") return { classification: "document" };
    return { classification: "unknown" };
  }

  const text = asText(bytes);
  if (text === undefined) return { classification: "unknown" };
  const head = text.slice(0, 2000).trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(mxfile|mxGraphModel)\b/.test(head))
    return { classification: "diagram" };
  if (/^(<\?xml[^>]*>\s*)?<svg\b/.test(head)) return { classification: "image" };
  if (/^<(!doctype html|html)\b/i.test(head)) return { classification: "document" };

  if (["json", "yaml", "yml"].includes(ext) || /^[[{]/.test(head)) {
    let data: unknown;
    try {
      data = parse(text);
    } catch {
      data = undefined;
    }
    const known = fromData(data);
    if (known) return known;
    if (ext === "json" || /^[[{]/.test(head)) {
      if (isObj(data) || Array.isArray(data)) return { classification: "payload", data };
    }
    if (ext === "yaml" || ext === "yml") return { classification: "unknown" };
  }
  if (head.startsWith("<")) return { classification: "payload" };
  if (["csv", "tsv"].includes(ext)) return { classification: "spreadsheet" };
  if (["md", "markdown", "txt", "rst", "adoc", "text", "rtf"].includes(ext) || ext === "")
    return { classification: "document" };
  return { classification: "unknown" };
}
