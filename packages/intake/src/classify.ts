import {
  parse,
  parseDocument,
  type ParseOptions,
  type DocumentOptions,
  type SchemaOptions,
  type ToJSOptions,
} from "yaml";

/**
 * What a dropped file is, decided from its content (the name only breaks ties), so nobody has
 * to sort the inbox. Deterministic: no AI. Free text and images are recognised but not read
 * here; they are marked as needing reading, which is AI work for later.
 */
export type Classification =
  | "openapi"
  | "swagger"
  | "asyncapi"
  /** A `.proto` file's messages (ADR 0164): a topic's contract, ours or another team's. */
  | "protobuf"
  /** An Avro schema (`.avsc`, or JSON whose top is a record with fields; ADR 0164). */
  | "avro"
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
  /**
   * What was read leniently, when the strict parser refused the file: a duplicate key (the last
   * kept), more aliases than its limit, or the one layout fixed for a spec (`readYaml`).
   */
  notes?: string[];
  /**
   * The text a reader takes, when it isn't the file's own: the file with that layout fixed, line
   * for line, so every cite still points at the file. Undefined when the file reads as it is.
   */
  text?: string;
  /** A YAML or JSON file nothing could read: the parser's reason, and where. */
  unreadable?: { reason: string; line?: number; column?: number };
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
    // A Jira REST search ({ issues: [{ key, fields }] }) or an Azure DevOps work-item batch
    // ({ value: [{ id, fields: { "System.Title": ... } }] }): tickets, not a payload.
    const list = (v: unknown) => (Array.isArray(v) && v.length > 0 && v.every(isObj) ? v : []);
    if (
      list(data.issues).every((i) => typeof i.key === "string" && isObj(i.fields)) &&
      list(data.issues).length
    )
      return { classification: "ticket-export", data };
    const items = list(data.value);
    if (
      items.length &&
      items.every(
        (i) =>
          i.id !== undefined &&
          isObj(i.fields) &&
          Object.keys(i.fields).some((k) => k.startsWith("System.")),
      )
    )
      return { classification: "ticket-export", data };
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

/** The strict parser's alias limit, and the higher one a lenient read allows (still bounded). */
const STRICT_ALIASES = 100;
const LENIENT_ALIASES = 10_000;
type YamlOptions = ParseOptions & DocumentOptions & SchemaOptions & ToJSOptions;
const LENIENT: YamlOptions = { uniqueKeys: false, maxAliasCount: LENIENT_ALIASES };

interface YamlError {
  code?: string;
  message: string;
  linePos?: { line: number; col: number }[];
}

/** The parser's reason, without its own "at line, column" and the snippet after it. */
const reasonOf = (e: YamlError) =>
  e.message
    .split("\n")[0]!
    .replace(/\s+at line \d+, column \d+:?\s*$/, "")
    .trim();

const unreadableOf = (e: YamlError): NonNullable<Classified["unreadable"]> => ({
  reason: reasonOf(e),
  ...(e.linePos?.[0] ? { line: e.linePos[0].line, column: e.linePos[0].col } : {}),
});

/** The keys a strict read finds twice, as `"key" at line:col`. */
function duplicateKeys(text: string): string[] {
  const lines = text.split(/\r?\n/);
  return parseDocument(text)
    .errors.filter((e) => e.code === "DUPLICATE_KEY" && e.linePos?.[0])
    .map((e) => {
      const { line, col } = e.linePos![0]!;
      const key = /^\s*["']?([^"':]+)["']?\s*:/.exec((lines[line - 1] ?? "").slice(col - 1))?.[1];
      return `duplicate key ${key ? `"${key.trim()}" ` : ""}at ${line}:${col}: the last one is kept`;
    });
}

/** Where a line's braces leave it: +1 per `{` and -1 per `}` outside quotes; NaN on a comment. */
function braceBalance(line: string): number {
  let n = 0;
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return NaN;
    else if (c === "{") n++;
    else if (c === "}") n--;
  }
  return quote ? NaN : n;
}

const indentOf = (l: string) => /^\s*/.exec(l)![0].length;
const blank = (l: string) => !l.trim() || /^\s*#/.test(l);

/**
 * The one layout fixed for a spec (an Apigee or Swagger UI export): under `servers[].variables`,
 * a variable written as a flow mapping over several lines whose lines aren't indented past its
 * key, and `key:{` with no space. Each such mapping is joined onto its key's line and the lines
 * it took are left blank, so the text keeps its line numbers. Nothing else is touched; undefined
 * when nothing there is written so, or a mapping isn't closed, or holds a comment.
 */
export function joinServerVariables(text: string): { text: string; at: number[] } | undefined {
  const lines = text.split(/\r?\n/);
  const at: number[] = [];
  let servers: number | undefined;
  let vars: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (blank(l)) continue;
    const ind = indentOf(l);
    if (vars !== undefined && ind <= vars) vars = undefined;
    if (servers !== undefined && ind <= servers && !/^\s*-(\s|$)/.test(l)) servers = undefined;
    if (servers !== undefined && ind < servers) servers = undefined;
    if (/^\s*["']?servers["']?\s*:\s*$/.test(l)) {
      servers = ind;
      vars = undefined;
      continue;
    }
    if (servers === undefined) continue;
    const v = /^(\s*)(-\s+)?["']?variables["']?\s*:\s*$/.exec(l);
    if (v) {
      vars = v[1]!.length + (v[2]?.length ?? 0);
      continue;
    }
    if (vars === undefined) continue;
    const m = /^(\s*)(["']?[\w.-]+["']?)\s*:\s*(\{.*)$/.exec(l);
    if (!m) continue;
    let balance = braceBalance(m[3]!);
    if (Number.isNaN(balance)) return undefined;
    const parts = [m[3]!.trim()];
    let j = i;
    while (balance > 0) {
      j++;
      if (j >= lines.length || j - i > 200) return undefined;
      const b = braceBalance(lines[j]!);
      if (Number.isNaN(b)) return undefined;
      balance += b;
      parts.push(lines[j]!.trim());
    }
    if (balance < 0) return undefined;
    const joined = `${m[1]}${m[2]}: ${parts.filter(Boolean).join(" ")}`;
    if (joined === l && j === i) continue;
    lines[i] = joined;
    for (let k = i + 1; k <= j; k++) lines[k] = "";
    at.push(i + 1);
    i = j;
  }
  return at.length ? { text: lines.join("\n"), at } : undefined;
}

const SPEC_KINDS: readonly Classification[] = ["openapi", "swagger", "asyncapi"];

/**
 * A YAML or JSON file's data: strictly, else leniently where that's safe (a duplicate key keeps
 * the last, more aliases than the strict limit), else, for a spec only, with the one layout
 * `joinServerVariables` fixes — kept only when the file then reads as an OpenAPI, Swagger or
 * AsyncAPI spec. Otherwise the strict parser's reason and where: never a guess.
 */
function readYaml(
  text: string,
): { data: unknown; notes?: string[]; text?: string } | { error: YamlError } {
  let first: YamlError;
  try {
    return { data: parse(text) };
  } catch (e) {
    first = e as YamlError;
  }
  const notes: string[] = [];
  const dup = first.code === "DUPLICATE_KEY";
  const aliases = /alias count/i.test(first.message);
  const lenient = (t: string) => {
    try {
      return { data: parse(t, LENIENT) as unknown };
    } catch (e) {
      return { error: e as YamlError };
    }
  };
  const notesOf = (t: string) => {
    const out = duplicateKeys(t);
    try {
      parse(t, { uniqueKeys: false });
    } catch (e) {
      if (/alias count/i.test((e as YamlError).message))
        out.push(
          `more aliases than the strict parser allows (${STRICT_ALIASES}): read with a higher limit (${LENIENT_ALIASES})`,
        );
    }
    return out;
  };
  if (dup || aliases) {
    const r = lenient(text);
    if ("data" in r) return { data: r.data, notes: notesOf(text) };
  }
  const fixed = joinServerVariables(text);
  if (fixed) {
    const r = lenient(fixed.text);
    if ("data" in r && SPEC_KINDS.includes(fromData(r.data)?.classification ?? "unknown")) {
      notes.push(...notesOf(fixed.text));
      const lines =
        fixed.at.length === 1
          ? `line ${fixed.at[0]} is a flow mapping`
          : `lines ${fixed.at.slice(0, -1).join(", ")} and ${fixed.at.at(-1)} are flow mappings`;
      notes.push(
        `servers[].variables at ${lines} written over several lines, not indented past ${fixed.at.length === 1 ? "its key: read as if it were" : "their key: read as if each were"} on one line`,
      );
      return { data: r.data, notes, text: fixed.text };
    }
  }
  return { error: first };
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
  // Mermaid: past optional front matter and %% comments, a diagram keyword.
  const mermaid = head
    .replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "")
    .replace(/^(\s*%%[^\n]*\n)+/, "")
    .trimStart();
  if (
    /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|C4(Context|Container|Component|Dynamic|Deployment)|architecture-beta|block-beta)\b/.test(
      mermaid,
    )
  )
    return { classification: "diagram" };
  if (/^<(!doctype html|html)\b/i.test(head)) return { classification: "document" };
  // ADR 0164: a topic's message spec. A .proto by its name or its first statements; Avro by its
  // name or a top-level record with fields.
  if (ext === "proto" || /^(syntax\s*=\s*["']proto[23]["']|package\s+[\w.]+\s*;)/m.test(head))
    return { classification: "protobuf" };
  if (
    ext === "avsc" ||
    (/^\{/.test(head) && /"type"\s*:\s*"record"/.test(head) && /"fields"\s*:/.test(head))
  )
    return { classification: "avro" };

  if (["json", "yaml", "yml"].includes(ext) || /^[[{]/.test(head)) {
    const r = readYaml(text);
    const named = ["json", "yaml", "yml"].includes(ext);
    // A file named as YAML or JSON that nothing reads says why (intake list: unreadable).
    if ("error" in r && named)
      return { classification: "unknown", unreadable: unreadableOf(r.error) };
    const data = "data" in r ? r.data : undefined;
    const lenient = {
      ...("notes" in r && r.notes?.length ? { notes: r.notes } : {}),
      ...("text" in r && r.text !== undefined ? { text: r.text } : {}),
    };
    const known = fromData(data);
    if (known) return { ...known, ...lenient };
    if (ext === "json" || /^[[{]/.test(head)) {
      if (isObj(data) || Array.isArray(data))
        return { classification: "payload", data, ...lenient };
    }
    if (ext === "yaml" || ext === "yml") return { classification: "unknown" };
  }
  if (head.startsWith("<")) return { classification: "payload" };
  if (["csv", "tsv"].includes(ext)) return { classification: "spreadsheet" };
  if (["md", "markdown", "txt", "rst", "adoc", "text", "rtf"].includes(ext) || ext === "")
    return { classification: "document" };
  return { classification: "unknown" };
}
