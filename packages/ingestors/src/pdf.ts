import { constants, inflateSync } from "node:zlib";
import type { DocumentMeta } from "./record.js";
import { Sections, type ParsedText } from "./text-model.js";

/*
 * PDF, best effort and honest about it. It reads uncompressed and Flate-compressed content
 * streams (also inside object streams), follows the page tree for page numbers, and takes text
 * from the Tj, TJ, ' and " operators. Fonts with custom encodings and no ToUnicode map, other
 * filters and encrypted files give no text: then it says so and never guesses.
 */

const NO_TEXT =
  "No text was found in this PDF. It may be a scanned image, so a person needs to read it.";
const MAX_STREAM = 64 * 1024 * 1024;

interface PdfObject {
  dict: string;
  stream?: Buffer;
}

const refs = (s: string) => [...s.matchAll(/(\d+)\s+\d+\s+R\b/g)].map((m) => Number(m[1]));
const ref = (dict: string, key: string) => {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R\\b`).exec(dict);
  return m ? Number(m[1]) : undefined;
};
const isType = (dict: string, type: string) =>
  new RegExp(`/Type\\s*/${type}(?![A-Za-z])`).test(dict);

function decodeStream(o: PdfObject): Buffer | undefined {
  if (!o.stream) return undefined;
  const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(o.dict)?.[1];
  if (!filter) return o.stream;
  const names = filter.match(/\/\w+/g) ?? [];
  if (names.length !== 1 || names[0] !== "/FlateDecode") return undefined;
  try {
    return inflateSync(o.stream, { maxOutputLength: MAX_STREAM });
  } catch {
    try {
      // Some writers leave streams unterminated; take what inflates.
      return inflateSync(o.stream, {
        finishFlush: constants.Z_SYNC_FLUSH,
        maxOutputLength: MAX_STREAM,
      });
    } catch {
      return undefined;
    }
  }
}

/** Every "N G obj ... endobj" in the file, plus objects packed in object streams. */
function objects(src: string, bytes: Buffer): Map<number, PdfObject> {
  const out = new Map<number, PdfObject>();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const start = re.lastIndex;
    const end = src.indexOf("endobj", start);
    const body = src.slice(start, end < 0 ? src.length : end);
    const s = /\bstream\r?\n/.exec(body);
    const obj: PdfObject = { dict: s ? body.slice(0, s.index) : body };
    if (s) {
      const dataStart = start + s.index + s[0].length;
      const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(obj.dict);
      let dataEnd = -1;
      if (len) {
        const e = dataStart + Number(len[1]);
        if (/^\s*endstream/.test(src.slice(e, e + 30))) dataEnd = e;
      }
      if (dataEnd < 0) {
        const es = src.indexOf("endstream", dataStart);
        dataEnd = es < 0 ? dataStart : es;
        while (dataEnd > dataStart && (src[dataEnd - 1] === "\n" || src[dataEnd - 1] === "\r"))
          dataEnd--;
      }
      obj.stream = bytes.subarray(dataStart, dataEnd);
    }
    out.set(Number(m[1]), obj);
    if (end > 0) re.lastIndex = end;
  }
  for (const o of [...out.values()]) {
    if (!isType(o.dict, "ObjStm")) continue;
    const data = decodeStream(o)?.toString("latin1");
    const n = Number(/\/N\s+(\d+)/.exec(o.dict)?.[1] ?? 0);
    const first = Number(/\/First\s+(\d+)/.exec(o.dict)?.[1] ?? 0);
    if (!data || !n) continue;
    const head = data.slice(0, first).trim().split(/\s+/).map(Number);
    for (let k = 0; k < n; k++) {
      const num = head[2 * k]!;
      const off = first + head[2 * k + 1]!;
      const nextOff = k + 1 < n ? first + head[2 * k + 3]! : data.length;
      if (!out.has(num)) out.set(num, { dict: data.slice(off, nextOff) });
    }
  }
  return out;
}

/** Bytes of a literal string body (escapes resolved). */
function literalBytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== "\\") {
      out.push(c.charCodeAt(0) & 255);
      continue;
    }
    const n = s[++i];
    if (n === undefined) break;
    const simple: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
    if (n in simple) out.push(simple[n]!);
    else if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(s[i + 1] ?? "")) oct += s[++i];
      out.push(parseInt(oct, 8) & 255);
    } else if (n === "\r") {
      if (s[i + 1] === "\n") i++;
    } else if (n !== "\n") out.push(n.charCodeAt(0) & 255);
  }
  return out;
}

/** Text from string bytes: UTF-16BE with a byte-order mark, else Latin-1; controls dropped. */
function bytesText(b: number[]): string {
  let s: string;
  if (b[0] === 0xfe && b[1] === 0xff) {
    s = "";
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
  } else s = String.fromCharCode(...b);
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    // Keep tab, line feed and carriage return; drop other control characters.
    if (c >= 32 ? c !== 127 : c === 9 || c === 10 || c === 13) out += ch;
  }
  return out;
}

type Token =
  | { t: "str"; v: number[] }
  | { t: "num"; v: number }
  | { t: "arr"; v: Token[] }
  | { t: "op"; v: string }
  | { t: "other" };

/** Read a literal string starting after "(" at i; returns the body and the index after ")". */
function readLiteral(src: string, i: number): [string, number] {
  let depth = 1;
  let k = i;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === "\\") k++;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) break;
  }
  return [src.slice(i, k), k + 1];
}

function hexBytes(h: string): number[] {
  const clean = h.replace(/[^0-9a-fA-F]/g, "");
  const even = clean.length % 2 ? clean + "0" : clean;
  const out: number[] = [];
  for (let i = 0; i < even.length; i += 2) out.push(parseInt(even.slice(i, i + 2), 16));
  return out;
}

/** Text shown by a content stream, one line per text line. */
export function contentText(src: string): string[] {
  const lines: string[] = [];
  let cur = "";
  const newline = () => {
    if (cur.trim()) lines.push(cur.replace(/\s+/g, " ").trim());
    cur = "";
  };
  const show = (tok: Token | undefined) => {
    if (tok?.t === "str") cur += bytesText(tok.v);
    else if (tok?.t === "arr")
      for (const x of tok.v) {
        if (x.t === "str") cur += bytesText(x.v);
        else if (x.t === "num" && x.v < -200) cur += " ";
      }
  };
  const stack: Token[] = [];
  const arrays: Token[][] = [];
  const push = (tok: Token) => (arrays.length ? arrays.at(-1)!.push(tok) : stack.push(tok));
  let lastY: number | undefined;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "%") {
      const e = src.indexOf("\n", i);
      i = e < 0 ? src.length : e + 1;
    } else if (c === "(") {
      const [body, next] = readLiteral(src, i + 1);
      push({ t: "str", v: literalBytes(body) });
      i = next;
    } else if (c === "<" && src[i + 1] === "<") {
      i += 2;
    } else if (c === ">" && src[i + 1] === ">") {
      i += 2;
    } else if (c === "<") {
      const e = src.indexOf(">", i);
      push({ t: "str", v: hexBytes(src.slice(i + 1, e < 0 ? src.length : e)) });
      i = e < 0 ? src.length : e + 1;
    } else if (c === "[") {
      arrays.push([]);
      i++;
    } else if (c === "]") {
      const a = arrays.pop() ?? [];
      push({ t: "arr", v: a });
      i++;
    } else if (c === "/") {
      const m = /^\/[^\s/[\]()<>{}%]*/.exec(src.slice(i, i + 128))!;
      push({ t: "other" });
      i += m[0].length;
    } else {
      const m = /^[+-]?(\d+\.?\d*|\.\d+)/.exec(src.slice(i, i + 32));
      if (m) {
        push({ t: "num", v: Number(m[0]) });
        i += m[0].length;
        continue;
      }
      const w = /^[A-Za-z'"*0-9]+/.exec(src.slice(i, i + 32));
      const op = w ? w[0] : c;
      i += op.length;
      const num = (k: number) => {
        const t = stack[stack.length - k];
        return t?.t === "num" ? t.v : 0;
      };
      switch (op) {
        case "BT":
        case "ET":
        case "T*":
          newline();
          break;
        case "Td":
        case "TD":
          if (num(1) !== 0) newline();
          break;
        case "Tm": {
          const y = num(1);
          if (lastY !== undefined && y !== lastY) newline();
          lastY = y;
          break;
        }
        case "Tj":
        case "TJ":
          show(stack.at(-1));
          break;
        case "'":
          newline();
          show(stack.at(-1));
          break;
        case '"':
          newline();
          show(stack.at(-1));
          break;
        case "ID": {
          // Inline image data: skip to EI.
          const e = src.slice(i).search(/\sEI(\s|$)/);
          i = e < 0 ? src.length : i + e + 3;
          break;
        }
      }
      if (op === "BT") lastY = undefined;
      stack.length = 0;
    }
  }
  newline();
  return lines;
}

/** A literal or hex string value of a dictionary key, as text. */
function dictString(dict: string, key: string): string | undefined {
  const m = new RegExp(`/${key}\\s*([(<])`).exec(dict);
  if (!m) return undefined;
  const at = m.index + m[0].length;
  if (m[1] === "(") return bytesText(literalBytes(readLiteral(dict, at)[0])).trim() || undefined;
  const e = dict.indexOf(">", at);
  return bytesText(hexBytes(dict.slice(at, e < 0 ? dict.length : e))).trim() || undefined;
}

function pdfDate(s: string | undefined): string | undefined {
  const m = s ? /^(?:D:)?(\d{4})(\d{2})?(\d{2})?/.exec(s) : null;
  if (!m) return undefined;
  return `${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"}`;
}

export function readPdf(bytes: Uint8Array): ParsedText {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const src = buf.toString("latin1");
  const objs = objects(src, buf);
  const trailers = [...src.matchAll(/trailer\s*(<<[\s\S]*?>>)/g)].map((m) => m[1]!);
  for (const o of objs.values()) if (isType(o.dict, "XRef")) trailers.push(o.dict);
  // The last trailer wins (incremental updates append a new one).
  const latestFirst = [...trailers].reverse();
  const trailerRef = (key: string) => {
    for (const t of latestFirst) {
      const r = ref(t, key);
      if (r !== undefined) return r;
    }
    return undefined;
  };
  const meta: DocumentMeta = {};
  const notes: string[] = [];
  if (trailers.some((t) => /\/Encrypt\b/.test(t))) {
    notes.push("This PDF is encrypted, so its text was not read. A person needs to read it.");
    return { sections: [], tables: [], meta: { flags: ["needs-reading"] }, notes };
  }
  const infoNo = trailerRef("Info");
  const info = infoNo !== undefined ? objs.get(infoNo)?.dict : undefined;
  const title = info ? dictString(info, "Title") : undefined;
  if (info) {
    const author = dictString(info, "Author");
    const date = pdfDate(dictString(info, "ModDate")) ?? pdfDate(dictString(info, "CreationDate"));
    if (author) meta.author = author;
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) meta.date = date;
  }

  // Pages in page-tree order; if there is no usable tree, every Page object by number.
  const pages: number[] = [];
  let rootNo = trailerRef("Root");
  if (rootNo === undefined) for (const [n, o] of objs) if (isType(o.dict, "Catalog")) rootNo ??= n;
  const seen = new Set<number>();
  const walk = (n: number, depth: number) => {
    const o = objs.get(n);
    if (!o || seen.has(n) || depth > 64) return;
    seen.add(n);
    if (isType(o.dict, "Pages")) {
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(o.dict)?.[1] ?? "";
      for (const k of refs(kids)) walk(k, depth + 1);
    } else if (isType(o.dict, "Page")) pages.push(n);
  };
  const pagesRoot = rootNo !== undefined ? ref(objs.get(rootNo)?.dict ?? "", "Pages") : undefined;
  if (pagesRoot !== undefined) walk(pagesRoot, 0);
  if (!pages.length)
    for (const [n, o] of [...objs].sort((a, b) => a[0] - b[0]))
      if (isType(o.dict, "Page")) pages.push(n);

  const s = new Sections();
  pages.forEach((n, i) => {
    const dict = objs.get(n)!.dict;
    const contents = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(dict)?.[1] ?? "";
    let streams = refs(contents);
    // /Contents may point at an array object rather than a stream.
    if (streams.length === 1 && !objs.get(streams[0]!)?.stream)
      streams = refs(objs.get(streams[0]!)?.dict ?? "");
    const text = streams
      .map((r) => objs.get(r))
      .map((o) => (o ? decodeStream(o)?.toString("latin1") : undefined))
      .filter((t): t is string => t !== undefined)
      .flatMap(contentText);
    s.heading("", 0, { page: i + 1 });
    for (const l of text) s.add(l);
  });
  const sections = s.done();
  if (!sections.length) {
    notes.push(NO_TEXT);
    meta.flags = ["needs-reading"];
  }
  return { ...(title ? { title } : {}), sections, tables: [], meta, notes };
}
