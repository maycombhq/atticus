/**
 * A small, tolerant HCL reader for Terraform files: blocks with labels, attributes with
 * strings, numbers, booleans, null, lists, objects and references. Anything more (function
 * calls, conditionals, for expressions) is kept as raw text. Interpolations stay inside
 * strings as written ("a-${var.env}"); callers resolve what they need. It never evaluates
 * anything and never fails: an unclosed block ends the read and is reported with its line.
 */
import type { ParsedAt } from "../lang/parsed.js";

export interface HclRef {
  /** A traversal such as `var.env` or `google_pubsub_topic.t.name`. */
  $ref: string;
}
export interface HclExpr {
  /** Any other expression, as written. */
  $expr: string;
}
export type HclValue =
  string | number | boolean | null | HclValue[] | { [key: string]: HclValue } | HclRef | HclExpr;

export interface HclAttr {
  value: HclValue;
  line: number;
}

export interface HclBlock {
  type: string;
  labels: string[];
  line: number;
  attrs: Map<string, HclAttr>;
  blocks: HclBlock[];
}

export interface HclFile {
  attrs: Map<string, HclAttr>;
  blocks: HclBlock[];
  /** Where reading stopped early, if it did. */
  error?: { line: number; message: string };
}

type Tok =
  | { t: "id" | "num" | "p"; v: string; line: number; start: number; end: number }
  | { t: "str"; v: string; line: number; start: number; end: number }
  | { t: "nl"; v: "\n"; line: number; start: number; end: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  const push = (t: Tok["t"], v: string, start: number, l = line) =>
    out.push({ t, v, line: l, start, end: i } as Tok);
  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      i++;
      if (out.at(-1)?.t !== "nl") push("nl", "\n", i - 1);
      line++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#" || (c === "/" && src[i + 1] === "/")) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"') {
      const start = i;
      const startLine = line;
      i++;
      let v = "";
      let depth = 0; // inside ${ ... }
      while (i < n) {
        const d = src[i]!;
        if (depth === 0 && d === '"') break;
        if (d === "\n") line++;
        if (d === "\\" && i + 1 < n) {
          const e = src[i + 1]!;
          v += depth > 0 ? d + e : e === "n" ? "\n" : e === "t" ? "\t" : e;
          i += 2;
          continue;
        }
        if ((d === "$" || d === "%") && src[i + 1] === "{") {
          depth++;
          v += d + "{";
          i += 2;
          continue;
        }
        if (depth > 0 && d === "{") depth++;
        if (depth > 0 && d === "}") depth--;
        if (depth > 0 && d === '"') {
          // A string inside an interpolation: copy it whole.
          v += d;
          i++;
          while (i < n && src[i] !== '"') {
            if (src[i] === "\\") v += src[i++];
            v += src[i++];
          }
          v += '"';
          i++;
          continue;
        }
        v += d;
        i++;
      }
      i++;
      push("str", v, start, startLine);
      continue;
    }
    if (c === "<" && src[i + 1] === "<" && /[-A-Za-z_]/.test(src[i + 2] ?? "")) {
      const m = /^<<(-?)([A-Za-z_][A-Za-z0-9_]*)[^\n]*\n/.exec(src.slice(i));
      if (m) {
        const start = i;
        const startLine = line;
        i += m[0].length;
        line++;
        const lines: string[] = [];
        while (i < n) {
          const eol = src.indexOf("\n", i);
          const l = src.slice(i, eol === -1 ? n : eol);
          i = eol === -1 ? n : eol + 1;
          line++;
          if (l.trim() === m[2]) break;
          lines.push(l);
        }
        let body = lines;
        if (m[1]) {
          const indent = Math.min(
            ...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length),
          );
          body = lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
        }
        push("str", body.map((l) => `${l}\n`).join(""), start, startLine);
        line--; // the newline after the closing marker is tokenised next
        i--;
        if (src[i] !== "\n") i++;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_-]/.test(src[i]!)) i++;
      push("id", src.slice(start, i), start);
      continue;
    }
    if (/[0-9]/.test(c)) {
      const start = i;
      while (i < n && /[0-9.eE+-]/.test(src[i]!)) {
        if ((src[i] === "+" || src[i] === "-") && !/[eE]/.test(src[i - 1]!)) break;
        i++;
      }
      push("num", src.slice(start, i), start);
      continue;
    }
    const start = i;
    const two = src.slice(i, i + 2);
    if (["==", "!=", ">=", "<=", "&&", "||", "=>", "::"].includes(two)) i += 2;
    else if (src.startsWith("...", i)) i += 3;
    else i++;
    push("p", src.slice(start, i), start);
  }
  return out;
}

const OPEN: Record<string, string> = { "{": "}", "[": "]", "(": ")" };

class Parser {
  private i = 0;
  error?: { line: number; message: string };
  constructor(
    private readonly src: string,
    private readonly toks: Tok[],
  ) {}

  private peek(k = 0): Tok | undefined {
    return this.toks[this.i + k];
  }

  private skipNl() {
    while (this.peek()?.t === "nl") this.i++;
  }

  /** Skip what can't be read up to the end of the line; a `}` that closes the block stays. */
  private skipLine() {
    let depth = 0;
    while (this.i < this.toks.length) {
      const t = this.toks[this.i]!;
      if (t.t === "nl" && depth === 0) return;
      if (t.t === "p" && OPEN[t.v]) depth++;
      else if (t.t === "p" && (t.v === "}" || t.v === "]" || t.v === ")")) {
        if (depth === 0 && t.v === "}") return;
        depth = Math.max(0, depth - 1);
      }
      this.i++;
    }
  }

  /** A body: attributes and blocks until `}` (nested) or the end (top level). */
  body(nested: boolean): { attrs: Map<string, HclAttr>; blocks: HclBlock[]; closed: boolean } {
    const attrs = new Map<string, HclAttr>();
    const blocks: HclBlock[] = [];
    for (;;) {
      this.skipNl();
      const t = this.peek();
      if (!t) return { attrs, blocks, closed: !nested };
      if (t.t === "p" && t.v === "}") {
        if (nested) {
          this.i++;
          return { attrs, blocks, closed: true };
        }
        this.i++; // stray closing brace at top level
        continue;
      }
      if (t.t !== "id" && t.t !== "str") {
        this.skipLine();
        continue;
      }
      const next = this.peek(1);
      if (next?.t === "p" && (next.v === "=" || next.v === ":")) {
        this.i += 2;
        const value = this.expr(["nl", "}"]);
        if (!attrs.has(t.v)) attrs.set(t.v, { value, line: t.line });
        continue;
      }
      // A block: type, labels, then `{`.
      const type = t.v;
      const line = t.line;
      this.i++;
      const labels: string[] = [];
      while (this.peek()?.t === "str" || this.peek()?.t === "id") {
        labels.push(this.peek()!.v);
        this.i++;
      }
      if (!(this.peek()?.t === "p" && this.peek()!.v === "{")) {
        this.skipLine();
        continue;
      }
      this.i++;
      const inner = this.body(true);
      if (!inner.closed) {
        this.error ??= { line, message: "a block isn't closed" };
        return { attrs, blocks, closed: false };
      }
      blocks.push({ type, labels, line, attrs: inner.attrs, blocks: inner.blocks });
    }
  }

  /** Collect an expression's tokens up to a stop token at depth 0, then interpret them. */
  private expr(stops: string[]): HclValue {
    const start = this.i;
    let depth = 0;
    while (this.i < this.toks.length) {
      const t = this.toks[this.i]!;
      if (depth === 0) {
        if (t.t === "nl" && stops.includes("nl")) break;
        if (t.t === "p" && stops.includes(t.v)) break;
      }
      if (t.t === "p" && OPEN[t.v]) depth++;
      else if (t.t === "p" && (t.v === "}" || t.v === "]" || t.v === ")")) {
        if (depth === 0) break;
        depth--;
      }
      this.i++;
    }
    return this.interpret(this.toks.slice(start, this.i));
  }

  private interpret(all: Tok[]): HclValue {
    // Newlines matter only between the items of an object.
    const toks = all.filter((t) => t.t !== "nl");
    if (toks.length === 0) return null;
    const first = toks[0]!;
    if (toks.length === 1) {
      if (first.t === "str") return first.v;
      if (first.t === "num") return Number(first.v);
      if (first.t === "id") {
        if (first.v === "true") return true;
        if (first.v === "false") return false;
        if (first.v === "null") return null;
        return { $ref: first.v };
      }
    }
    if (first.t === "p" && (first.v === "[" || first.v === "{") && this.closes(toks)) {
      if (first.v === "[") return this.list(toks.slice(1, -1));
      const from = all.indexOf(first);
      const to = all.lastIndexOf(toks.at(-1)!);
      return this.object(all.slice(from + 1, to));
    }
    if (
      first.t === "id" &&
      toks.every((t, i) => (i % 2 === 0 ? t.t === "id" : t.t === "p" && t.v === "."))
    )
      return { $ref: toks.map((t) => t.v).join("") };
    if (first.t === "p" && first.v === "-" && toks.length === 2 && toks[1]!.t === "num")
      return -Number(toks[1]!.v);
    return { $expr: this.src.slice(first.start, toks.at(-1)!.end).trim() };
  }

  /** True when the first token's bracket closes at the last token. */
  private closes(toks: Tok[]): boolean {
    let depth = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (t.t === "p" && OPEN[t.v]) depth++;
      else if (t.t === "p" && (t.v === "}" || t.v === "]" || t.v === ")")) {
        depth--;
        if (depth === 0) return i === toks.length - 1;
      }
    }
    return false;
  }

  private split(toks: Tok[], seps: (t: Tok) => boolean): Tok[][] {
    const parts: Tok[][] = [];
    let cur: Tok[] = [];
    let depth = 0;
    for (const t of toks) {
      if (t.t === "p" && OPEN[t.v]) depth++;
      else if (t.t === "p" && (t.v === "}" || t.v === "]" || t.v === ")")) depth--;
      if (depth === 0 && seps(t)) {
        if (cur.length) parts.push(cur);
        cur = [];
      } else cur.push(t);
    }
    if (cur.length) parts.push(cur);
    return parts;
  }

  private list(toks: Tok[]): HclValue {
    return this.split(
      toks.filter((t) => t.t !== "nl"),
      (t) => t.t === "p" && t.v === ",",
    ).map((p) => this.interpret(p));
  }

  private object(toks: Tok[]): HclValue {
    const out: { [k: string]: HclValue } = {};
    for (const item of this.split(toks, (t) => t.t === "nl" || (t.t === "p" && t.v === ","))) {
      const eq = item.findIndex((t) => t.t === "p" && (t.v === "=" || t.v === ":"));
      if (eq <= 0) continue;
      const keyToks = item.slice(0, eq);
      const key =
        keyToks.length === 1 && (keyToks[0]!.t === "str" || keyToks[0]!.t === "id")
          ? keyToks[0]!.v
          : this.src.slice(keyToks[0]!.start, keyToks.at(-1)!.end);
      out[key] = this.interpret(item.slice(eq + 1));
    }
    return out;
  }
}

/**
 * Read an HCL file. With the repo scan's parse cache (ADR 0067) it is read once for every reader
 * (Terraform, dialect hclBlock rules, observability) and the same frozen result handed to each.
 */
export function parseHcl(text: string, at?: ParsedAt): HclFile {
  return at?.cache ? at.cache.get("hcl", at.path, text, readHcl) : readHcl(text);
}

function readHcl(text: string): HclFile {
  const p = new Parser(text, tokenize(text));
  const { attrs, blocks } = p.body(false);
  return { attrs, blocks, ...(p.error ? { error: p.error } : {}) };
}

/** The first child block of a type. */
export const child = (b: HclBlock | undefined, type: string): HclBlock | undefined =>
  b?.blocks.find((x) => x.type === type);

export const children = (b: HclBlock | undefined, type: string): HclBlock[] =>
  b?.blocks.filter((x) => x.type === type) ?? [];

export const attrOf = (b: HclBlock | undefined, name: string): HclValue | undefined =>
  b?.attrs.get(name)?.value;

export const isRef = (v: unknown): v is HclRef =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  typeof (v as HclRef).$ref === "string";
